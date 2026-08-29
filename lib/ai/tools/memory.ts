import { tool } from "ai";
import type { ToolContext } from "@/types";
import {
  archiveMemoryNode,
  createMemoryEdge,
  createMemoryNode,
  getMemoryAncestors,
  getMemoryNeighbors,
  getMemorySubtree,
  listMemoryChildren,
  moveMemoryNode,
  searchMemoryNodes,
  updateMemoryNode,
} from "@/lib/db/memory-actions";
import {
  MEMORY_ACTIONS_REQUIRING_NODE_ID,
  memoryTool,
  type MemoryToolInput,
} from "./schemas";

/**
 * Structured memory: a navigable tree of nodes plus typed cross-links.
 *
 * Exposed as ONE tool with an `action` discriminator, mirroring the existing
 * `file` tool. Ten separate tools would nearly double agent-mode tool count and
 * their schemas are paid for on every request.
 *
 * All operations are user-scoped inside Convex; `context.userID` is the only
 * identity passed, so the model cannot address another user's memory.
 */
export const createMemory = (context: ToolContext) => {
  return tool({
    ...memoryTool,
    execute: async (input: MemoryToolInput) => {
      const userId = context.userID;

      // Validate up front rather than per-branch. Without this, a missing
      // node_id would reach Convex and fail argument validation, surfacing an
      // opaque transport error instead of something the model can act on.
      if (
        (MEMORY_ACTIONS_REQUIRING_NODE_ID as readonly string[]).includes(
          input.action,
        ) &&
        !input.node_id
      ) {
        return {
          success: false,
          error: `\`node_id\` is required for the '${input.action}' action`,
        };
      }
      // Safe for the actions above by the guard; unused by the others.
      const nodeId = input.node_id as string;

      try {
        switch (input.action) {
          case "create": {
            if (!input.title || !input.content) {
              return {
                success: false,
                error: "`title` and `content` are required for create",
              };
            }
            const result = await createMemoryNode({
              userId,
              title: input.title,
              content: input.content,
              kind: input.kind,
              parentId: input.parent_id,
              tags: input.tags,
              pinned: input.pinned,
              // Provenance, so a node can later be traced to its origin.
              sourceChatId: context.chatId,
            });
            if (!result.success) {
              return { success: false, error: result.error };
            }
            return {
              success: true,
              node_id: result.node_id,
              path: result.path,
              message: `Created memory node '${input.title}'`,
            };
          }

          case "list": {
            const nodes = await listMemoryChildren({
              userId,
              parentId: input.node_id,
              limit: input.limit,
            });
            return {
              success: true,
              // Absent node_id lists roots, which is the entry point for
              // exploring memory without knowing any ids.
              parent_id: input.node_id ?? null,
              count: nodes.length,
              nodes,
            };
          }

          case "read": {
            const subtree = await getMemorySubtree({
              userId,
              nodeId: nodeId,
              maxDepth: input.max_depth,
              limit: input.limit,
            });
            if (!subtree.root) {
              return { success: false, error: "Node not found" };
            }
            const ancestors = await getMemoryAncestors({
              userId,
              nodeId: nodeId,
            });
            return {
              success: true,
              node: subtree.root,
              // Ancestors give the model its position in the tree without a
              // second call, so it can reason about where to write next.
              ancestors,
              children: subtree.descendants,
              truncated: subtree.truncated,
            };
          }

          case "search": {
            if (!input.query) {
              return {
                success: false,
                error: "`query` is required for search",
              };
            }
            const nodes = await searchMemoryNodes({
              userId,
              queryText: input.query,
              kind: input.kind,
              limit: input.limit,
            });
            return { success: true, count: nodes.length, nodes };
          }

          case "update": {
            const result = await updateMemoryNode({
              userId,
              nodeId: nodeId,
              title: input.title,
              content: input.content,
              kind: input.kind,
              tags: input.tags,
              pinned: input.pinned,
            });
            if (!result.success) {
              return { success: false, error: result.error };
            }
            return { success: true, message: `Updated ${input.node_id}` };
          }

          case "move": {
            const result = await moveMemoryNode({
              userId,
              nodeId: nodeId,
              newParentId: input.parent_id,
            });
            if (!result.success) {
              return { success: false, error: result.error };
            }
            return {
              success: true,
              message: input.parent_id
                ? `Moved ${input.node_id} under ${input.parent_id}`
                : `Promoted ${input.node_id} to a root node`,
              moved_descendants: result.moved_descendants,
            };
          }

          case "archive": {
            const result = await archiveMemoryNode({
              userId,
              nodeId: nodeId,
              restore: input.restore,
            });
            if (!result.success) {
              return { success: false, error: result.error };
            }
            return {
              success: true,
              message: `${input.restore ? "Restored" : "Archived"} ${
                input.node_id
              } (${result.affected} node(s))`,
            };
          }

          case "link": {
            if (!input.to_node_id || !input.relation) {
              return {
                success: false,
                error: "`to_node_id` and `relation` are required for link",
              };
            }
            const result = await createMemoryEdge({
              userId,
              fromNodeId: nodeId,
              toNodeId: input.to_node_id,
              relation: input.relation,
              note: input.note,
            });
            if (!result.success) {
              return { success: false, error: result.error };
            }
            return {
              success: true,
              edge_id: result.edge_id,
              message: `Linked ${input.node_id} -[${input.relation}]-> ${input.to_node_id}`,
            };
          }

          case "neighbors": {
            const result = await getMemoryNeighbors({
              userId,
              nodeId: nodeId,
              limit: input.limit,
            });
            return {
              success: true,
              outgoing: result.outgoing,
              incoming: result.incoming,
            };
          }

          default: {
            // Exhaustiveness guard: a new action added to the schema without a
            // branch here fails to compile rather than silently no-opping.
            const unreachable: never = input.action;
            return {
              success: false,
              error: `Unsupported memory action: ${String(unreachable)}`,
            };
          }
        }
      } catch (error) {
        console.error("Memory tool error:", error);
        return {
          success: false,
          error: `Memory operation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  });
};
