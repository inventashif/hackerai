/**
 * Tests for compaction -> structured memory linkage.
 *
 * Two behaviors here are correctness-critical and cannot be caught by the live
 * smoke test (which always passes a userId):
 *
 *   1. PRIVACY: a user who disabled notes/memory in Settings must never have
 *      compaction silently write persistent knowledge. The runner withholds
 *      `userId` in that case, so absence of userId must mean "write nothing".
 *   2. NO DEAD PATHS: the excerpt stored in memory must be the raw summary, not
 *      the summary with the sandbox transcript notice appended. That notice
 *      points at a sandbox path that stops resolving once the sandbox dies, and
 *      persisting it into permanent memory would recreate the bug this fixes.
 */
import { recordCompactionMemoryLink } from "@/lib/chat/summarization/helpers";

const mockRecordCompactionMemory = jest.fn();
jest.mock("@/lib/db/memory-actions", () => ({
  recordCompactionMemory: (...args: unknown[]) =>
    mockRecordCompactionMemory(...args),
}));

// helpers.ts imports this at module load; stub it so the suite stays focused on
// linkage rather than exercising the whole summarization pipeline.
jest.mock("@/lib/db/actions", () => ({ saveChatSummary: jest.fn() }));

const SUMMARY = "User audited example.com and confirmed an IDOR on /api/users.";

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordCompactionMemory.mockResolvedValue({
    success: true,
    node_id: "n1",
    folder_id: "f1",
    truncated: false,
  });
});

describe("opt-out gating", () => {
  it("writes nothing when userId is absent", async () => {
    // The runner withholds userId when shouldIncludeNotes is false.
    await recordCompactionMemoryLink({
      userId: undefined,
      chatId: "chat-1",
      summaryText: SUMMARY,
      summaryId: null,
      cutoffMessageId: "msg-1",
      mode: "agent",
    });

    expect(mockRecordCompactionMemory).not.toHaveBeenCalled();
  });

  it("writes nothing when chatId is absent", async () => {
    await recordCompactionMemoryLink({
      userId: "user-1",
      chatId: null,
      summaryText: SUMMARY,
      summaryId: null,
      cutoffMessageId: "msg-1",
      mode: "agent",
    });

    expect(mockRecordCompactionMemory).not.toHaveBeenCalled();
  });

  it("writes when both are present", async () => {
    await recordCompactionMemoryLink({
      userId: "user-1",
      chatId: "chat-1",
      summaryText: SUMMARY,
      summaryId: null,
      cutoffMessageId: "msg-1",
      mode: "agent",
    });

    expect(mockRecordCompactionMemory).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", chatId: "chat-1" }),
    );
  });
});

describe("payload", () => {
  it("stores the raw summary, never a sandbox transcript path", async () => {
    // Regression guard for the dead-path bug: callers must pass summaryText,
    // not finalSummaryText. If a transcript notice ever reached this function it
    // would be frozen into permanent memory pointing at a dead sandbox file.
    await recordCompactionMemoryLink({
      userId: "user-1",
      chatId: "chat-1",
      summaryText: SUMMARY,
      summaryId: null,
      cutoffMessageId: "msg-1",
      mode: "agent",
    });

    const arg = mockRecordCompactionMemory.mock.calls[0][0];
    expect(arg.summaryText).toBe(SUMMARY);
    expect(arg.summaryText).not.toContain("Transcript location");
    expect(arg.summaryText).not.toContain("/home/user/agent-transcripts");
    expect(arg.summaryText).not.toContain("/tmp/agent-transcripts");
  });

  it("forwards the summary id when the row was written", async () => {
    await recordCompactionMemoryLink({
      userId: "user-1",
      chatId: "chat-1",
      summaryText: SUMMARY,
      summaryId: "summary_abc" as never,
      cutoffMessageId: "msg-1",
      mode: "agent",
    });

    expect(mockRecordCompactionMemory).toHaveBeenCalledWith(
      expect.objectContaining({ summaryId: "summary_abc" }),
    );
  });

  it("omits summaryId when the summary write was skipped", async () => {
    // persistSummary returns null when Convex skipped the write (chat deleted,
    // stale summary, cutoff missing). Linkage should still record the
    // compaction, just without a correlation id.
    await recordCompactionMemoryLink({
      userId: "user-1",
      chatId: "chat-1",
      summaryText: SUMMARY,
      summaryId: null,
      cutoffMessageId: "msg-1",
      mode: "agent",
    });

    const arg = mockRecordCompactionMemory.mock.calls[0][0];
    expect(arg).not.toHaveProperty("summaryId");
    expect(arg.cutoffMessageId).toBe("msg-1");
  });
});

describe("failure isolation", () => {
  it("does not throw when the mutation reports failure", async () => {
    mockRecordCompactionMemory.mockResolvedValue({
      success: false,
      error: "Summary text is empty",
    });

    await expect(
      recordCompactionMemoryLink({
        userId: "user-1",
        chatId: "chat-1",
        summaryText: SUMMARY,
        summaryId: null,
        cutoffMessageId: "msg-1",
        mode: "agent",
      }),
    ).resolves.toBeUndefined();
  });

  it("swallows a thrown error so compaction still succeeds", async () => {
    // The summary itself is already persisted by this point, so memory
    // bookkeeping must never fail the turn.
    mockRecordCompactionMemory.mockRejectedValue(new Error("convex down"));

    await expect(
      recordCompactionMemoryLink({
        userId: "user-1",
        chatId: "chat-1",
        summaryText: SUMMARY,
        summaryId: null,
        cutoffMessageId: "msg-1",
        mode: "agent",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("telemetry", () => {
  it("logs the linkage without leaking conversation content", async () => {
    // Summary text is user conversation content and must never reach logs.
    const info = jest.spyOn(console, "info").mockImplementation(() => {});
    mockRecordCompactionMemory.mockResolvedValue({
      success: true,
      node_id: "n9",
      folder_id: "f9",
      linked_to: "n8",
      truncated: true,
    });

    await recordCompactionMemoryLink({
      userId: "user-1",
      chatId: "chat-1",
      summaryText: SUMMARY,
      summaryId: null,
      cutoffMessageId: "msg-1",
      mode: "agent",
    });

    const logged = info.mock.calls.map(([line]) => String(line)).join("\n");
    expect(logged).toContain("compaction_memory_linked");
    expect(logged).toContain("n9");
    expect(logged).toContain("n8");
    expect(logged).not.toContain("IDOR");
    expect(logged).not.toContain("example.com");

    info.mockRestore();
  });
});
