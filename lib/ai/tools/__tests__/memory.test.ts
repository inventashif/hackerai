/**
 * Tests for the structured-memory tool.
 *
 * The tool is one entry point with 9 action branches, so the risks are
 * mis-dispatch (an action calling the wrong DB function), missing-argument
 * handling, and — most importantly — identity: the model supplies the action
 * arguments, but never the user id. If `userID` could come from tool input, one
 * user could read another's memory.
 */
import type { ToolContext } from "@/types";
import { createMemory } from "../memory";

// The factory must build its own mocks inline: jest.mock() is hoisted above
// module-level `const`s, so referencing an outer object here hits the temporal
// dead zone. References are recovered via requireMock below, after hoisting.
//
// A factory (rather than an automock) also keeps the real module from ever
// loading, which matters because it starts with `import "server-only"`.
jest.mock("@/lib/db/memory-actions", () => ({
  createMemoryNode: jest.fn(),
  updateMemoryNode: jest.fn(),
  moveMemoryNode: jest.fn(),
  archiveMemoryNode: jest.fn(),
  listMemoryChildren: jest.fn(),
  getMemorySubtree: jest.fn(),
  getMemoryAncestors: jest.fn(),
  searchMemoryNodes: jest.fn(),
  createMemoryEdge: jest.fn(),
  getMemoryNeighbors: jest.fn(),
}));

const mocks = jest.requireMock("@/lib/db/memory-actions") as Record<
  string,
  jest.Mock
>;

const USER = "user-under-test";
const CHAT = "chat-123";

function makeContext(): ToolContext {
  return { userID: USER, chatId: CHAT } as unknown as ToolContext;
}

async function run(input: Record<string, unknown>) {
  const tool = createMemory(makeContext());
  const execute = (
    tool as unknown as {
      execute: (i: unknown, o: unknown) => Promise<any>;
    }
  ).execute;
  return execute(input, {
    toolCallId: "call-1",
    abortSignal: undefined,
    messages: [],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mocks.createMemoryNode.mockResolvedValue({
    success: true,
    node_id: "n1",
    path: "n1",
  });
  mocks.updateMemoryNode.mockResolvedValue({ success: true });
  mocks.moveMemoryNode.mockResolvedValue({
    success: true,
    moved_descendants: 2,
  });
  mocks.archiveMemoryNode.mockResolvedValue({ success: true, affected: 3 });
  mocks.listMemoryChildren.mockResolvedValue([]);
  mocks.getMemorySubtree.mockResolvedValue({
    root: { node_id: "n1", title: "Root" },
    descendants: [],
    truncated: false,
  });
  mocks.getMemoryAncestors.mockResolvedValue([]);
  mocks.searchMemoryNodes.mockResolvedValue([]);
  mocks.createMemoryEdge.mockResolvedValue({ success: true, edge_id: "e1" });
  mocks.getMemoryNeighbors.mockResolvedValue({ outgoing: [], incoming: [] });
});

describe("identity", () => {
  it("always uses the context user, never tool input", async () => {
    // The model controls tool input. If a user_id there could reach the DB
    // layer, memory would be cross-readable.
    await run({
      action: "create",
      title: "t",
      content: "c",
      userId: "attacker",
      user_id: "attacker",
    });

    expect(mocks.createMemoryNode).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER }),
    );
  });

  it("passes the chat id as provenance on create", async () => {
    await run({ action: "create", title: "t", content: "c" });
    expect(mocks.createMemoryNode).toHaveBeenCalledWith(
      expect.objectContaining({ sourceChatId: CHAT }),
    );
  });
});

describe("node_id requirement", () => {
  const needsNodeId = [
    "read",
    "update",
    "move",
    "archive",
    "link",
    "neighbors",
  ];

  it.each(needsNodeId)("rejects '%s' without node_id", async (action) => {
    // Caught in the tool so the model gets an actionable message rather than
    // an opaque Convex argument-validation error.
    const result = await run({ action });
    expect(result.success).toBe(false);
    expect(result.error).toContain("node_id");
    expect(result.error).toContain(action);
  });

  it("allows 'list' without node_id to list roots", async () => {
    const result = await run({ action: "list" });
    expect(result.success).toBe(true);
    expect(result.parent_id).toBeNull();
    expect(mocks.listMemoryChildren).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, parentId: undefined }),
    );
  });

  it("allows 'create' and 'search' without node_id", async () => {
    expect((await run({ action: "create", title: "t", content: "c" })).success).toBe(
      true,
    );
    expect((await run({ action: "search", query: "q" })).success).toBe(true);
  });
});

describe("required arguments", () => {
  it("requires title and content for create", async () => {
    expect((await run({ action: "create", title: "t" })).error).toContain(
      "content",
    );
    expect((await run({ action: "create", content: "c" })).error).toContain(
      "title",
    );
    expect(mocks.createMemoryNode).not.toHaveBeenCalled();
  });

  it("requires a query for search", async () => {
    const result = await run({ action: "search" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("query");
    expect(mocks.searchMemoryNodes).not.toHaveBeenCalled();
  });

  it("requires to_node_id and relation for link", async () => {
    const noTarget = await run({ action: "link", node_id: "n1" });
    expect(noTarget.error).toContain("to_node_id");

    const noRelation = await run({
      action: "link",
      node_id: "n1",
      to_node_id: "n2",
    });
    expect(noRelation.error).toContain("relation");
    expect(mocks.createMemoryEdge).not.toHaveBeenCalled();
  });
});

describe("dispatch", () => {
  it("read returns the node with ancestors and children", async () => {
    mocks.getMemoryAncestors.mockResolvedValue([{ node_id: "root" }]);
    mocks.getMemorySubtree.mockResolvedValue({
      root: { node_id: "n1", title: "Finding" },
      descendants: [{ node_id: "n2" }],
      truncated: true,
    });

    const result = await run({ action: "read", node_id: "n1" });

    // Ancestors come back in the same call so the model can place new nodes
    // without a second round trip.
    expect(result).toMatchObject({
      success: true,
      node: { node_id: "n1" },
      ancestors: [{ node_id: "root" }],
      children: [{ node_id: "n2" }],
      truncated: true,
    });
  });

  it("read reports a missing node rather than an empty success", async () => {
    mocks.getMemorySubtree.mockResolvedValue({
      root: null,
      descendants: [],
      truncated: false,
    });
    const result = await run({ action: "read", node_id: "gone" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("move forwards parent_id and reports descendants", async () => {
    const result = await run({
      action: "move",
      node_id: "n1",
      parent_id: "n9",
    });
    expect(mocks.moveMemoryNode).toHaveBeenCalledWith({
      userId: USER,
      nodeId: "n1",
      newParentId: "n9",
    });
    expect(result.moved_descendants).toBe(2);
  });

  it("move without parent_id promotes to a root", async () => {
    const result = await run({ action: "move", node_id: "n1" });
    expect(mocks.moveMemoryNode).toHaveBeenCalledWith(
      expect.objectContaining({ newParentId: undefined }),
    );
    expect(result.message).toContain("root");
  });

  it("archive distinguishes archive from restore", async () => {
    const archived = await run({ action: "archive", node_id: "n1" });
    expect(archived.message).toContain("Archived");

    const restored = await run({
      action: "archive",
      node_id: "n1",
      restore: true,
    });
    expect(mocks.archiveMemoryNode).toHaveBeenLastCalledWith(
      expect.objectContaining({ restore: true }),
    );
    expect(restored.message).toContain("Restored");
  });

  it("link records the relation direction", async () => {
    const result = await run({
      action: "link",
      node_id: "poc",
      to_node_id: "finding",
      relation: "evidence_for",
      note: "why",
    });
    expect(mocks.createMemoryEdge).toHaveBeenCalledWith({
      userId: USER,
      fromNodeId: "poc",
      toNodeId: "finding",
      relation: "evidence_for",
      note: "why",
    });
    expect(result.edge_id).toBe("e1");
    expect(result.message).toContain("evidence_for");
  });

  it("neighbors returns both directions", async () => {
    mocks.getMemoryNeighbors.mockResolvedValue({
      outgoing: [{ edge_id: "e1" }],
      incoming: [{ edge_id: "e2" }],
    });
    const result = await run({ action: "neighbors", node_id: "n1" });
    expect(result.outgoing).toHaveLength(1);
    expect(result.incoming).toHaveLength(1);
  });
});

describe("failure handling", () => {
  it("surfaces a DB-layer failure message", async () => {
    mocks.createMemoryNode.mockResolvedValue({
      success: false,
      error: "Parent node not found",
    });
    const result = await run({
      action: "create",
      title: "t",
      content: "c",
      parent_id: "missing",
    });
    expect(result).toEqual({ success: false, error: "Parent node not found" });
  });

  it("catches a thrown error instead of failing the run", async () => {
    // A Convex outage must not abort the agent loop.
    mocks.searchMemoryNodes.mockRejectedValue(new Error("convex unreachable"));
    const result = await run({ action: "search", query: "q" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("convex unreachable");
  });

  it("rejects an unknown action", async () => {
    const result = await run({ action: "destroy" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unsupported memory action");
  });
});
