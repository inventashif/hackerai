/**
 * Structured long-term memory: a connected node store the agent can navigate.
 *
 * Complements `notes` (a flat per-user list) with two coexisting structures:
 *   - a TREE via `parent_id` + materialized `path`, so a bounded subtree can be
 *     loaded instead of the whole store;
 *   - a GRAPH via `memory_edges`, for typed links that cut across the tree.
 *
 * Authorization: every function here is a public `mutation`/`query` guarded by
 * `validateServiceKey`, with `userId` trusted as given — matching the existing
 * `*ForBackend` convention in `notes.ts`. Consequently EVERY read and write
 * below must filter by `user_id`, and edge endpoints must be ownership-checked,
 * because the service key can name any user.
 */
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { validateServiceKey } from "./lib/utils";
import {
  ancestorIdsFromPath,
  buildNodePath,
  isInsideSubtree,
  prefixUpperBound,
  rebaseDescendantPath,
  subtreePrefix,
} from "./lib/memoryPaths";

const NODE_KINDS = [
  "folder",
  "fact",
  "finding",
  "target",
  "methodology",
  "plan",
  "question",
  "summary",
] as const;

const EDGE_RELATIONS = [
  "relates_to",
  "depends_on",
  "derived_from",
  "evidence_for",
  "contradicts",
  "supersedes",
] as const;

const nodeKindValidator = v.union(...NODE_KINDS.map((k) => v.literal(k)));
const edgeRelationValidator = v.union(
  ...EDGE_RELATIONS.map((r) => v.literal(r)),
);
const statusValidator = v.union(v.literal("active"), v.literal("archived"));

/** Guard against unbounded nesting; also bounds path length and move cost. */
const MAX_DEPTH = 12;
/** Bounds a single subtree read so one call cannot blow the context budget. */
const MAX_SUBTREE_NODES = 200;
/** Bounds descendant rewriting on a move. */
const MAX_DESCENDANTS_PER_MOVE = 500;

const MAX_TITLE_CHARS = 200;
const MAX_CONTENT_CHARS = 8_000;
const MAX_TAGS = 20;

/** Auto-injected memory budget, mirroring the notes tiering in `notes.ts`. */
const CONTEXT_TOKEN_LIMIT_FREE = 5_000;
const CONTEXT_TOKEN_LIMIT_PAID = 15_000;

/**
 * 10 chars from a 36-char alphabet (~3.7e15 combinations). Deliberately longer
 * than the 5-char ids in `notes.ts`: compaction creates memory nodes
 * automatically, so volume is far higher and birthday-collision risk matters.
 * Still paired with a collision check below.
 */
function generateId(): string {
  let out = "";
  while (out.length < 10) {
    out += Math.random().toString(36).slice(2);
  }
  return out.slice(0, 10);
}

/** ~4 chars per token, matching `estimateNoteTokens` in `notes.ts`. */
function estimateTokens(
  title: string,
  content: string,
  kind: string,
  tags: string[],
): number {
  const chars =
    title.length + content.length + kind.length + tags.join(",").length;
  return Math.ceil(chars / 4);
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const cleaned = tags
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, MAX_TAGS);
  return Array.from(new Set(cleaned));
}

type ValidationError = { success: false; error: string };

function validateTitleAndContent(
  title: string,
  content: string,
): ValidationError | null {
  if (!title.trim()) return { success: false, error: "Title cannot be empty" };
  if (title.length > MAX_TITLE_CHARS) {
    return {
      success: false,
      error: `Title exceeds ${MAX_TITLE_CHARS} characters`,
    };
  }
  if (content.length > MAX_CONTENT_CHARS) {
    return {
      success: false,
      error: `Content exceeds ${MAX_CONTENT_CHARS} characters`,
    };
  }
  return null;
}

/** Shape returned to callers. Excludes Convex internals. */
const nodeShape = v.object({
  node_id: v.string(),
  parent_id: v.optional(v.string()),
  path: v.string(),
  depth: v.number(),
  kind: nodeKindValidator,
  title: v.string(),
  content: v.string(),
  tags: v.array(v.string()),
  tokens: v.number(),
  status: statusValidator,
  pinned: v.optional(v.boolean()),
  source_chat_id: v.optional(v.string()),
  source_message_id: v.optional(v.string()),
  created_at: v.number(),
  updated_at: v.number(),
});

/**
 * Project a stored node onto the wire shape. Derived from `Doc` rather than a
 * hand-written type so it cannot drift from the schema, and so internal fields
 * (`_id`, `user_id`, `source_summary_id`) are dropped deliberately rather than
 * by omission.
 */
function toNodeShape(doc: Doc<"memory_nodes">) {
  return {
    node_id: doc.node_id,
    parent_id: doc.parent_id,
    path: doc.path,
    depth: doc.depth,
    kind: doc.kind,
    title: doc.title,
    content: doc.content,
    tags: doc.tags,
    tokens: doc.tokens,
    status: doc.status,
    pinned: doc.pinned,
    source_chat_id: doc.source_chat_id,
    source_message_id: doc.source_message_id,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

// ── Internal lookups ────────────────────────────────────────────────────────

/**
 * Fetch a node by public id, scoped to the owner. Returns null when the node
 * does not exist OR belongs to someone else — the two cases are deliberately
 * indistinguishable so callers cannot probe for another user's node ids.
 */
async function findOwnedNode(
  // Only the reader is needed, so this accepts both QueryCtx and MutationCtx
  // (a writer is structurally a reader) without widening to `any`. Typing this
  // properly matters: it is the single chokepoint enforcing user isolation.
  ctx: { db: QueryCtx["db"] },
  userId: string,
  nodeId: string,
): Promise<Doc<"memory_nodes"> | null> {
  const doc = await ctx.db
    .query("memory_nodes")
    .withIndex("by_node_id", (q) => q.eq("node_id", nodeId))
    .first();
  if (!doc || doc.user_id !== userId) return null;
  return doc;
}

// ── Node writes ─────────────────────────────────────────────────────────────

export const createMemoryNodeForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    title: v.string(),
    content: v.string(),
    kind: v.optional(nodeKindValidator),
    parentId: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    pinned: v.optional(v.boolean()),
    sourceChatId: v.optional(v.string()),
    sourceMessageId: v.optional(v.string()),
    sourceSummaryId: v.optional(v.id("chat_summaries")),
  },
  returns: v.object({
    success: v.boolean(),
    node_id: v.optional(v.string()),
    path: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const title = args.title.trim();
    const content = args.content.trim();
    const invalid = validateTitleAndContent(title, content);
    if (invalid) return invalid;

    const kind = args.kind ?? "fact";
    const tags = normalizeTags(args.tags);

    // Resolve tree position. A missing/foreign parent must not silently create
    // a root node — that would relocate the caller's data unexpectedly.
    let parentPath: string | null = null;
    let depth = 0;
    if (args.parentId) {
      const parent = await findOwnedNode(ctx, args.userId, args.parentId);
      if (!parent) return { success: false, error: "Parent node not found" };
      if (parent.status === "archived") {
        return { success: false, error: "Cannot add a child to an archived node" };
      }
      if (parent.depth + 1 > MAX_DEPTH) {
        return {
          success: false,
          error: `Maximum nesting depth of ${MAX_DEPTH} reached`,
        };
      }
      parentPath = parent.path;
      depth = parent.depth + 1;
    }

    let nodeId: string | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateId();
      const existing = await ctx.db
        .query("memory_nodes")
        .withIndex("by_node_id", (q) => q.eq("node_id", candidate))
        .first();
      if (!existing) {
        nodeId = candidate;
        break;
      }
    }
    if (!nodeId) {
      return { success: false, error: "Failed to generate unique node ID" };
    }

    const path = buildNodePath(parentPath, nodeId);
    const now = Date.now();

    try {
      await ctx.db.insert("memory_nodes", {
        user_id: args.userId,
        node_id: nodeId,
        parent_id: args.parentId,
        path,
        depth,
        kind,
        title,
        content,
        tags,
        tokens: estimateTokens(title, content, kind, tags),
        status: "active",
        ...(args.pinned !== undefined ? { pinned: args.pinned } : {}),
        ...(args.sourceChatId ? { source_chat_id: args.sourceChatId } : {}),
        ...(args.sourceMessageId
          ? { source_message_id: args.sourceMessageId }
          : {}),
        ...(args.sourceSummaryId
          ? { source_summary_id: args.sourceSummaryId }
          : {}),
        created_at: now,
        updated_at: now,
      });
      return { success: true, node_id: nodeId, path };
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("Failed to create memory node:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create node",
      };
    }
  },
});

export const updateMemoryNodeForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    nodeId: v.string(),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    kind: v.optional(nodeKindValidator),
    tags: v.optional(v.array(v.string())),
    pinned: v.optional(v.boolean()),
  },
  returns: v.object({
    success: v.boolean(),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const node = await findOwnedNode(ctx, args.userId, args.nodeId);
    if (!node) return { success: false, error: "Node not found" };

    const title = args.title !== undefined ? args.title.trim() : node.title;
    const content =
      args.content !== undefined ? args.content.trim() : node.content;
    const invalid = validateTitleAndContent(title, content);
    if (invalid) return invalid;

    const kind = args.kind ?? node.kind;
    const tags = args.tags !== undefined ? normalizeTags(args.tags) : node.tags;

    try {
      await ctx.db.patch(node._id, {
        title,
        content,
        kind,
        tags,
        tokens: estimateTokens(title, content, kind, tags),
        ...(args.pinned !== undefined ? { pinned: args.pinned } : {}),
        updated_at: Date.now(),
      });
      return { success: true };
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("Failed to update memory node:", error);
      return { success: false, error: "Failed to update node" };
    }
  },
});

/**
 * Reparent a node and rewrite descendant paths.
 *
 * Rejects cycles: with materialized paths, "is the new parent inside my own
 * subtree" is a prefix test, so no traversal is needed. Without this check a
 * move could detach a subtree into an unreachable loop.
 */
export const moveMemoryNodeForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    nodeId: v.string(),
    // Omit to promote the node to a root.
    newParentId: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    moved_descendants: v.optional(v.number()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const node = await findOwnedNode(ctx, args.userId, args.nodeId);
    if (!node) return { success: false, error: "Node not found" };

    let newParentPath: string | null = null;
    let newDepth = 0;
    if (args.newParentId) {
      if (args.newParentId === args.nodeId) {
        return { success: false, error: "A node cannot be its own parent" };
      }
      const parent = await findOwnedNode(ctx, args.userId, args.newParentId);
      if (!parent) return { success: false, error: "Parent node not found" };

      // Cycle guard: the destination must not sit inside this node's subtree.
      if (isInsideSubtree(parent.path, node.path)) {
        return {
          success: false,
          error: "Cannot move a node into its own descendant",
        };
      }
      newParentPath = parent.path;
      newDepth = parent.depth + 1;
    }

    // Read descendants before mutating, so the prefix scan sees the old paths.
    const descendantPrefix = subtreePrefix(node.path);
    const descendants = await ctx.db
      .query("memory_nodes")
      .withIndex("by_user_and_path", (q) =>
        q
          .eq("user_id", args.userId)
          .gte("path", descendantPrefix)
          .lt("path", prefixUpperBound(descendantPrefix)),
      )
      .take(MAX_DESCENDANTS_PER_MOVE + 1);

    if (descendants.length > MAX_DESCENDANTS_PER_MOVE) {
      return {
        success: false,
        error: `Subtree exceeds ${MAX_DESCENDANTS_PER_MOVE} nodes; move smaller branches first`,
      };
    }

    const depthShift = newDepth - node.depth;
    const deepest = descendants.reduce(
      (max, d) => Math.max(max, d.depth),
      node.depth,
    );
    if (deepest + depthShift > MAX_DEPTH) {
      return {
        success: false,
        error: `Move would exceed maximum nesting depth of ${MAX_DEPTH}`,
      };
    }

    const newPath = buildNodePath(newParentPath, node.node_id);
    const now = Date.now();

    try {
      await ctx.db.patch(node._id, {
        parent_id: args.newParentId,
        path: newPath,
        depth: newDepth,
        updated_at: now,
      });

      for (const d of descendants) {
        await ctx.db.patch(d._id, {
          // Swaps only the ancestor portion; the tail is unchanged.
          path: rebaseDescendantPath(d.path, node.path, newPath),
          depth: d.depth + depthShift,
          updated_at: now,
        });
      }

      return { success: true, moved_descendants: descendants.length };
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("Failed to move memory node:", error);
      return { success: false, error: "Failed to move node" };
    }
  },
});

/**
 * Soft-delete a node and its subtree.
 *
 * Archiving rather than deleting keeps edges from dangling and preserves the
 * provenance chain of anything derived from this node.
 */
export const archiveMemoryNodeForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    nodeId: v.string(),
    // Restore instead of archive.
    restore: v.optional(v.boolean()),
  },
  returns: v.object({
    success: v.boolean(),
    affected: v.optional(v.number()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const node = await findOwnedNode(ctx, args.userId, args.nodeId);
    if (!node) return { success: false, error: "Node not found" };

    const status = args.restore ? "active" : "archived";
    const now = Date.now();
    const prefix = subtreePrefix(node.path);

    const descendants = await ctx.db
      .query("memory_nodes")
      .withIndex("by_user_and_path", (q) =>
        q
          .eq("user_id", args.userId)
          .gte("path", prefix)
          .lt("path", prefixUpperBound(prefix)),
      )
      .take(MAX_DESCENDANTS_PER_MOVE);

    try {
      await ctx.db.patch(node._id, { status, updated_at: now });
      for (const d of descendants) {
        await ctx.db.patch(d._id, { status, updated_at: now });
      }
      return { success: true, affected: descendants.length + 1 };
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("Failed to archive memory node:", error);
      return { success: false, error: "Failed to archive node" };
    }
  },
});

// ── Node reads ──────────────────────────────────────────────────────────────

export const getMemoryNodeForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    nodeId: v.string(),
  },
  returns: v.union(nodeShape, v.null()),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const node = await findOwnedNode(ctx, args.userId, args.nodeId);
    return node ? toNodeShape(node) : null;
  },
});

/**
 * List direct children — the core "directory listing" operation. Passing no
 * `parentId` lists root nodes.
 */
export const listMemoryChildrenForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    parentId: v.optional(v.string()),
    includeArchived: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  returns: v.array(nodeShape),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const limit = Math.min(args.limit ?? 50, MAX_SUBTREE_NODES);

    // `by_user_parent_and_status` also serves roots, since `parent_id` is
    // undefined for them and Convex indexes that as a distinct value.
    const rows = args.includeArchived
      ? await ctx.db
          .query("memory_nodes")
          .withIndex("by_user_parent_and_status", (q) =>
            q.eq("user_id", args.userId).eq("parent_id", args.parentId),
          )
          .take(limit)
      : await ctx.db
          .query("memory_nodes")
          .withIndex("by_user_parent_and_status", (q) =>
            q
              .eq("user_id", args.userId)
              .eq("parent_id", args.parentId)
              .eq("status", "active"),
          )
          .take(limit);

    return rows.map(toNodeShape);
  },
});

/** Load a bounded subtree by materialized-path prefix. */
export const getMemorySubtreeForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    nodeId: v.string(),
    maxDepth: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    root: v.union(nodeShape, v.null()),
    descendants: v.array(nodeShape),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const root = await findOwnedNode(ctx, args.userId, args.nodeId);
    if (!root) return { root: null, descendants: [], truncated: false };

    const limit = Math.min(args.limit ?? MAX_SUBTREE_NODES, MAX_SUBTREE_NODES);
    const prefix = subtreePrefix(root.path);
    const rows = await ctx.db
      .query("memory_nodes")
      .withIndex("by_user_and_path", (q) =>
        q
          .eq("user_id", args.userId)
          .gte("path", prefix)
          .lt("path", prefixUpperBound(prefix)),
      )
      .take(limit + 1);

    const truncated = rows.length > limit;
    const capped = truncated ? rows.slice(0, limit) : rows;
    const maxDepth =
      args.maxDepth !== undefined ? root.depth + args.maxDepth : Infinity;

    return {
      root: toNodeShape(root),
      descendants: capped
        .filter((d) => d.status === "active" && d.depth <= maxDepth)
        .map(toNodeShape),
      truncated,
    };
  },
});

/** Walk from a node to its root, for explaining where a node sits. */
export const getMemoryAncestorsForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    nodeId: v.string(),
  },
  returns: v.array(nodeShape),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const node = await findOwnedNode(ctx, args.userId, args.nodeId);
    if (!node) return [];

    // Path already encodes the chain, so this is a bounded set of point reads
    // rather than an unbounded parent walk.
    const ancestorIds = ancestorIdsFromPath(node.path);
    const out = [];
    for (const id of ancestorIds) {
      const doc = await findOwnedNode(ctx, args.userId, id);
      if (doc) out.push(toNodeShape(doc));
    }
    return out;
  },
});

export const searchMemoryNodesForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    queryText: v.string(),
    kind: v.optional(nodeKindValidator),
    limit: v.optional(v.number()),
  },
  returns: v.array(nodeShape),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const text = args.queryText.trim();
    if (!text) return [];

    const limit = Math.min(args.limit ?? 20, 50);
    const rows = await ctx.db
      .query("memory_nodes")
      .withSearchIndex("search_memory_nodes", (q) => {
        const base = q
          .search("content", text)
          .eq("user_id", args.userId)
          .eq("status", "active");
        return args.kind ? base.eq("kind", args.kind) : base;
      })
      .take(limit);

    return rows.map(toNodeShape);
  },
});

/**
 * Memory selected for automatic prompt injection: pinned nodes first, then the
 * most recently updated, bounded by a plan-based token budget so memory can
 * never crowd out the conversation itself.
 */
export const getMemoryContextForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    subscription: v.string(),
  },
  returns: v.object({
    nodes: v.array(nodeShape),
    total_tokens: v.number(),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const budget =
      args.subscription === "free"
        ? CONTEXT_TOKEN_LIMIT_FREE
        : CONTEXT_TOKEN_LIMIT_PAID;

    const pinned = await ctx.db
      .query("memory_nodes")
      .withIndex("by_user_and_pinned", (q) =>
        q.eq("user_id", args.userId).eq("pinned", true),
      )
      .take(100);

    const recent = await ctx.db
      .query("memory_nodes")
      .withIndex("by_user_status_and_updated", (q) =>
        q.eq("user_id", args.userId).eq("status", "active"),
      )
      .order("desc")
      .take(100);

    const seen = new Set<string>();
    const ordered = [...pinned.filter((n) => n.status === "active"), ...recent];

    const selected = [];
    let total = 0;
    let truncated = false;
    for (const node of ordered) {
      if (seen.has(node.node_id)) continue;
      seen.add(node.node_id);

      const tokens = Number.isFinite(node.tokens) && node.tokens > 0
        ? node.tokens
        : 0;
      if (total + tokens > budget) {
        truncated = true;
        continue;
      }
      total += tokens;
      selected.push(toNodeShape(node));
    }

    return { nodes: selected, total_tokens: total, truncated };
  },
});

/** Expand a compaction summary into the nodes extracted from it. */
export const getMemoryNodesBySummaryForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    summaryId: v.id("chat_summaries"),
  },
  returns: v.array(nodeShape),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const rows = await ctx.db
      .query("memory_nodes")
      .withIndex("by_source_summary", (q) =>
        q.eq("source_summary_id", args.summaryId),
      )
      .take(MAX_SUBTREE_NODES);

    // Index is not user-scoped, so filter explicitly.
    return rows.filter((r) => r.user_id === args.userId).map(toNodeShape);
  },
});

// ── Compaction linkage ──────────────────────────────────────────────────────

/**
 * Record a compaction as a durable, connected memory node.
 *
 * Why this exists: `chat_summaries` is lossy by design. Each compaction DELETES
 * the previous summary row and the `previous_summaries` chain is capped at
 * MAX_PREVIOUS_SUMMARIES (10), so older context is unrecoverable. The sandbox
 * transcript that used to backstop it dies with the sandbox. This writes an
 * uncapped, permanent record instead:
 *
 *   [folder] Chat: <title>
 *     +- [summary] Compaction 1
 *     +- [summary] Compaction 2  --derived_from-->  Compaction 1
 *     +- [summary] Compaction 3  --derived_from-->  Compaction 2
 *
 * The node stores its own excerpt rather than only pointing at the summary row,
 * precisely because that row gets deleted. `source_summary_id` is still recorded
 * for correlation while it lives.
 *
 * Done as ONE mutation so folder find-or-create, node insert, and edge creation
 * are transactional — concurrent compactions cannot produce duplicate folders.
 */
export const recordCompactionMemoryForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    chatId: v.string(),
    summaryText: v.string(),
    chatTitle: v.optional(v.string()),
    summaryId: v.optional(v.id("chat_summaries")),
    cutoffMessageId: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    node_id: v.optional(v.string()),
    folder_id: v.optional(v.string()),
    linked_to: v.optional(v.string()),
    truncated: v.optional(v.boolean()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const summaryText = args.summaryText.trim();
    if (!summaryText) {
      return { success: false, error: "Summary text is empty" };
    }

    const now = Date.now();

    // Two explicitly typed reservation helpers rather than one generic helper
    // over a table union: TypeScript cannot correlate table name with index
    // name, so the generic version needs `as any` on the index and a typo
    // would compile but fail at runtime.
    const reserveNodeId = async (): Promise<string | null> => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateId();
        const existing = await ctx.db
          .query("memory_nodes")
          .withIndex("by_node_id", (q) => q.eq("node_id", candidate))
          .first();
        if (!existing) return candidate;
      }
      return null;
    };

    const reserveEdgeId = async (): Promise<string | null> => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateId();
        const existing = await ctx.db
          .query("memory_edges")
          .withIndex("by_edge_id", (q) => q.eq("edge_id", candidate))
          .first();
        if (!existing) return candidate;
      }
      return null;
    };

    try {
      // Resolve the chat title here rather than plumbing it through the
      // summarization call chain: we are already inside a transaction with DB
      // access, so this is one indexed read instead of an extra round trip on
      // the compaction critical path.
      let resolvedTitle = args.chatTitle?.trim();
      if (!resolvedTitle) {
        const chat = await ctx.db
          .query("chats")
          .withIndex("by_chat_id", (q) => q.eq("id", args.chatId))
          .first();
        resolvedTitle =
          chat && chat.user_id === args.userId ? chat.title?.trim() : undefined;
      }

      // Nodes previously recorded for this chat. Used both to locate the folder
      // and to find the newest summary node to chain from.
      const existing = await ctx.db
        .query("memory_nodes")
        .withIndex("by_source_chat", (q) => q.eq("source_chat_id", args.chatId))
        .take(200);
      // Index is not user-scoped, so filter explicitly.
      const owned = existing.filter((n) => n.user_id === args.userId);

      // ── Folder: find or create ──
      let folder = owned.find((n) => n.kind === "folder");
      if (!folder) {
        const folderId = await reserveNodeId();
        if (!folderId) {
          return { success: false, error: "Failed to generate folder ID" };
        }
        const folderTitle = resolvedTitle
          ? `Chat: ${resolvedTitle.slice(0, 120)}`
          : `Chat ${args.chatId.slice(0, 8)}`;
        const folderDocId = await ctx.db.insert("memory_nodes", {
          user_id: args.userId,
          node_id: folderId,
          path: buildNodePath(null, folderId),
          depth: 0,
          kind: "folder",
          title: folderTitle,
          content:
            "Compaction history for this conversation. Each child summarizes a span of the chat that was compacted out of the live context.",
          tags: ["chat-history"],
          tokens: 0,
          status: "active",
          source_chat_id: args.chatId,
          created_at: now,
          updated_at: now,
        });
        const inserted = await ctx.db.get(folderDocId);
        if (!inserted) {
          return { success: false, error: "Folder insert did not persist" };
        }
        folder = inserted;
      }

      // ── Previous summary node, for chaining ──
      const previous = owned
        .filter((n) => n.kind === "summary")
        .sort((a, b) => b.created_at - a.created_at)[0];

      // ── Summary node ──
      const nodeId = await reserveNodeId();
      if (!nodeId) {
        return { success: false, error: "Failed to generate node ID" };
      }

      const truncated = summaryText.length > MAX_CONTENT_CHARS;
      const content = truncated
        ? `${summaryText.slice(0, MAX_CONTENT_CHARS - 120)}\n\n[Excerpt truncated; this records the start of the summary.]`
        : summaryText;

      // 1-based ordinal for display. Named to avoid reading as a database
      // index, which is what "index" means everywhere else in this file.
      const compactionNumber =
        owned.filter((n) => n.kind === "summary").length + 1;
      const title = `Compaction ${compactionNumber}`;

      await ctx.db.insert("memory_nodes", {
        user_id: args.userId,
        node_id: nodeId,
        parent_id: folder.node_id,
        path: buildNodePath(folder.path, nodeId),
        depth: folder.depth + 1,
        kind: "summary",
        title,
        content,
        tags: ["compaction"],
        tokens: Math.ceil((title.length + content.length) / 4),
        status: "active",
        source_chat_id: args.chatId,
        ...(args.cutoffMessageId
          ? { source_message_id: args.cutoffMessageId }
          : {}),
        ...(args.summaryId ? { source_summary_id: args.summaryId } : {}),
        created_at: now,
        updated_at: now,
      });

      // ── Chain to the previous compaction ──
      let linkedTo: string | undefined;
      if (previous) {
        const edgeId = await reserveEdgeId();
        if (edgeId) {
          await ctx.db.insert("memory_edges", {
            user_id: args.userId,
            edge_id: edgeId,
            from_node_id: nodeId,
            to_node_id: previous.node_id,
            // derived_from, not supersedes: the earlier summary is still valid
            // history. Each compaction builds on the last rather than
            // invalidating it.
            relation: "derived_from",
            note: "Continues the compaction history of this conversation",
            created_at: now,
          });
          linkedTo = previous.node_id;
        }
      }

      return {
        success: true,
        node_id: nodeId,
        folder_id: folder.node_id,
        linked_to: linkedTo,
        truncated,
      };
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("Failed to record compaction memory:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to record compaction memory",
      };
    }
  },
});

// ── Edges ───────────────────────────────────────────────────────────────────

export const createMemoryEdgeForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    fromNodeId: v.string(),
    toNodeId: v.string(),
    relation: edgeRelationValidator,
    note: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    edge_id: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    if (args.fromNodeId === args.toNodeId) {
      return { success: false, error: "Cannot link a node to itself" };
    }

    // Ownership check on BOTH endpoints. Without this, an edge could point at
    // another user's node and later traversal would leak its existence.
    const from = await findOwnedNode(ctx, args.userId, args.fromNodeId);
    if (!from) return { success: false, error: "Source node not found" };
    const to = await findOwnedNode(ctx, args.userId, args.toNodeId);
    if (!to) return { success: false, error: "Target node not found" };

    const duplicate = await ctx.db
      .query("memory_edges")
      .withIndex("by_from_to_and_relation", (q) =>
        q
          .eq("from_node_id", args.fromNodeId)
          .eq("to_node_id", args.toNodeId)
          .eq("relation", args.relation),
      )
      .first();
    if (duplicate) {
      return { success: true, edge_id: duplicate.edge_id };
    }

    let edgeId: string | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateId();
      const existing = await ctx.db
        .query("memory_edges")
        .withIndex("by_edge_id", (q) => q.eq("edge_id", candidate))
        .first();
      if (!existing) {
        edgeId = candidate;
        break;
      }
    }
    if (!edgeId) {
      return { success: false, error: "Failed to generate unique edge ID" };
    }

    try {
      await ctx.db.insert("memory_edges", {
        user_id: args.userId,
        edge_id: edgeId,
        from_node_id: args.fromNodeId,
        to_node_id: args.toNodeId,
        relation: args.relation,
        ...(args.note?.trim() ? { note: args.note.trim() } : {}),
        created_at: Date.now(),
      });
      return { success: true, edge_id: edgeId };
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("Failed to create memory edge:", error);
      return { success: false, error: "Failed to create edge" };
    }
  },
});

export const deleteMemoryEdgeForBackend = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    edgeId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const edge = await ctx.db
      .query("memory_edges")
      .withIndex("by_edge_id", (q) => q.eq("edge_id", args.edgeId))
      .first();
    if (!edge || edge.user_id !== args.userId) {
      return { success: false, error: "Edge not found" };
    }

    await ctx.db.delete(edge._id);
    return { success: true };
  },
});

/**
 * Graph traversal one hop out from a node, in both directions. Node bodies are
 * included so the agent can decide what to follow without a second round trip.
 */
export const getMemoryNeighborsForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    nodeId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    outgoing: v.array(
      v.object({
        edge_id: v.string(),
        relation: edgeRelationValidator,
        note: v.optional(v.string()),
        node: nodeShape,
      }),
    ),
    incoming: v.array(
      v.object({
        edge_id: v.string(),
        relation: edgeRelationValidator,
        note: v.optional(v.string()),
        node: nodeShape,
      }),
    ),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const node = await findOwnedNode(ctx, args.userId, args.nodeId);
    if (!node) return { outgoing: [], incoming: [] };

    const limit = Math.min(args.limit ?? 50, 100);

    const outEdges = await ctx.db
      .query("memory_edges")
      .withIndex("by_user_and_from", (q) =>
        q.eq("user_id", args.userId).eq("from_node_id", args.nodeId),
      )
      .take(limit);

    const inEdges = await ctx.db
      .query("memory_edges")
      .withIndex("by_user_and_to", (q) =>
        q.eq("user_id", args.userId).eq("to_node_id", args.nodeId),
      )
      .take(limit);

    const hydrate = async (
      edges: typeof outEdges,
      pick: (e: (typeof outEdges)[number]) => string,
    ) => {
      const out = [];
      for (const edge of edges) {
        const other = await findOwnedNode(ctx, args.userId, pick(edge));
        // Skip archived neighbors so traversal surfaces current knowledge.
        if (!other || other.status !== "active") continue;
        out.push({
          edge_id: edge.edge_id,
          relation: edge.relation,
          note: edge.note,
          node: toNodeShape(other),
        });
      }
      return out;
    };

    return {
      outgoing: await hydrate(outEdges, (e) => e.to_node_id),
      incoming: await hydrate(inEdges, (e) => e.from_node_id),
    };
  },
});
