import "server-only";

import { api } from "@/convex/_generated/api";
import { ChatSDKError } from "../errors";
import { getConvexClient } from "./convex-client";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * Server-side wrappers for the structured memory store (`convex/memory.ts`).
 *
 * Kept separate from `actions.ts` purely for file size; the conventions are
 * identical — service-key auth, `ChatSDKError` on transport failure, and
 * `{ success, error }` results passed through rather than thrown so tools can
 * report failures to the model without aborting the run.
 */
const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;

export type MemoryNodeKind =
  | "folder"
  | "fact"
  | "finding"
  | "target"
  | "methodology"
  | "plan"
  | "question"
  | "summary";

export type MemoryRelation =
  | "relates_to"
  | "depends_on"
  | "derived_from"
  | "evidence_for"
  | "contradicts"
  | "supersedes";

/** Wrap a Convex call so transport errors surface consistently. */
async function call<T>(fn: () => Promise<T>, failureMessage: string): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new ChatSDKError(
      "bad_request:database",
      error instanceof Error ? error.message : failureMessage,
    );
  }
}

export async function createMemoryNode(args: {
  userId: string;
  title: string;
  content: string;
  kind?: MemoryNodeKind;
  parentId?: string;
  tags?: string[];
  pinned?: boolean;
  sourceChatId?: string;
  sourceMessageId?: string;
  sourceSummaryId?: Id<"chat_summaries">;
}) {
  return call(
    () =>
      getConvexClient().mutation(api.memory.createMemoryNodeForBackend, {
        serviceKey,
        ...args,
      }),
    "Failed to create memory node",
  );
}

export async function updateMemoryNode(args: {
  userId: string;
  nodeId: string;
  title?: string;
  content?: string;
  kind?: MemoryNodeKind;
  tags?: string[];
  pinned?: boolean;
}) {
  return call(
    () =>
      getConvexClient().mutation(api.memory.updateMemoryNodeForBackend, {
        serviceKey,
        ...args,
      }),
    "Failed to update memory node",
  );
}

export async function moveMemoryNode(args: {
  userId: string;
  nodeId: string;
  newParentId?: string;
}) {
  return call(
    () =>
      getConvexClient().mutation(api.memory.moveMemoryNodeForBackend, {
        serviceKey,
        ...args,
      }),
    "Failed to move memory node",
  );
}

export async function archiveMemoryNode(args: {
  userId: string;
  nodeId: string;
  restore?: boolean;
}) {
  return call(
    () =>
      getConvexClient().mutation(api.memory.archiveMemoryNodeForBackend, {
        serviceKey,
        ...args,
      }),
    "Failed to archive memory node",
  );
}

export async function getMemoryNode(args: { userId: string; nodeId: string }) {
  return call(
    () =>
      getConvexClient().query(api.memory.getMemoryNodeForBackend, {
        serviceKey,
        ...args,
      }),
    "Failed to read memory node",
  );
}

export async function listMemoryChildren(args: {
  userId: string;
  parentId?: string;
  includeArchived?: boolean;
  limit?: number;
}) {
  return call(
    () =>
      getConvexClient().query(api.memory.listMemoryChildrenForBackend, {
        serviceKey,
        ...args,
      }),
    "Failed to list memory nodes",
  );
}

export async function getMemorySubtree(args: {
  userId: string;
  nodeId: string;
  maxDepth?: number;
  limit?: number;
}) {
  return call(
    () =>
      getConvexClient().query(api.memory.getMemorySubtreeForBackend, {
        serviceKey,
        ...args,
      }),
    "Failed to read memory subtree",
  );
}

export async function getMemoryAncestors(args: {
  userId: string;
  nodeId: string;
}) {
  return call(
    () =>
      getConvexClient().query(api.memory.getMemoryAncestorsForBackend, {
        serviceKey,
        ...args,
      }),
    "Failed to read memory ancestors",
  );
}

export async function searchMemoryNodes(args: {
  userId: string;
  queryText: string;
  kind?: MemoryNodeKind;
  limit?: number;
}) {
  return call(
    () =>
      getConvexClient().query(api.memory.searchMemoryNodesForBackend, {
        serviceKey,
        ...args,
      }),
    "Failed to search memory",
  );
}

export async function getMemoryContext(args: {
  userId: string;
  subscription: string;
}) {
  return call(
    () =>
      getConvexClient().query(api.memory.getMemoryContextForBackend, {
        serviceKey,
        ...args,
      }),
    "Failed to load memory context",
  );
}

export async function getMemoryNodesBySummary(args: {
  userId: string;
  summaryId: Id<"chat_summaries">;
}) {
  return call(
    () =>
      getConvexClient().query(api.memory.getMemoryNodesBySummaryForBackend, {
        serviceKey,
        ...args,
      }),
    "Failed to expand summary into memory nodes",
  );
}

/**
 * Record a compaction as a durable memory node chained to the previous one.
 *
 * Returns a result object rather than throwing, because compaction must never
 * fail on account of memory bookkeeping.
 */
export async function recordCompactionMemory(args: {
  userId: string;
  chatId: string;
  summaryText: string;
  chatTitle?: string;
  summaryId?: Id<"chat_summaries">;
  cutoffMessageId?: string;
}) {
  return call(
    () =>
      getConvexClient().mutation(api.memory.recordCompactionMemoryForBackend, {
        serviceKey,
        ...args,
      }),
    "Failed to record compaction memory",
  );
}

export async function createMemoryEdge(args: {
  userId: string;
  fromNodeId: string;
  toNodeId: string;
  relation: MemoryRelation;
  note?: string;
}) {
  return call(
    () =>
      getConvexClient().mutation(api.memory.createMemoryEdgeForBackend, {
        serviceKey,
        ...args,
      }),
    "Failed to link memory nodes",
  );
}

export async function deleteMemoryEdge(args: {
  userId: string;
  edgeId: string;
}) {
  return call(
    () =>
      getConvexClient().mutation(api.memory.deleteMemoryEdgeForBackend, {
        serviceKey,
        ...args,
      }),
    "Failed to unlink memory nodes",
  );
}

export async function getMemoryNeighbors(args: {
  userId: string;
  nodeId: string;
  limit?: number;
}) {
  return call(
    () =>
      getConvexClient().query(api.memory.getMemoryNeighborsForBackend, {
        serviceKey,
        ...args,
      }),
    "Failed to traverse memory",
  );
}
