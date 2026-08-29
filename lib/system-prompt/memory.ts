interface MemoryNode {
  readonly node_id: string;
  readonly path: string;
  readonly depth: number;
  readonly kind: string;
  readonly title: string;
  readonly content: string;
  readonly tags: string[];
  readonly pinned?: boolean;
  readonly updated_at: number;
}

/**
 * Render auto-injected structured memory.
 *
 * Injected into messages rather than the system prompt, matching
 * `generateNotesSection` — the system prompt must stay byte-stable for provider
 * prompt caching (see `buildSystemPrompt` in lib/api/chat-stream-helpers.ts).
 *
 * The selection is deliberately partial: `getMemoryContextForBackend` returns
 * pinned plus most-recently-updated nodes within a token budget. Rendering it
 * as a flat list with paths is more honest than implying a complete tree, and
 * the notice tells the model to explore rather than assume this is everything.
 *
 * Note: avoid backticks in this template literal. An unescaped backtick
 * terminates the string early and produces a confusing parse error.
 */
export const generateMemorySection = (
  nodes: MemoryNode[] | null,
  opts: { truncated?: boolean } = {},
): string => {
  if (!nodes || nodes.length === 0) {
    return "";
  }

  const lines = nodes
    .map((node) => {
      const date = new Date(node.updated_at).toISOString().split("T")[0];
      const tags = node.tags.length > 0 ? ` [${node.tags.join(", ")}]` : "";
      const pin = node.pinned ? " (pinned)" : "";
      // Path is included so the model can see tree position without a lookup,
      // which lets it choose a sensible parent for new nodes.
      return `- [${node.kind}] **${node.title}**${tags}${pin}: ${node.content} (id: ${node.node_id}, path: ${node.path})`;
    })
    .join("\n");

  const truncationNotice = opts.truncated
    ? "\nSome nodes were omitted to stay within the memory budget."
    : "";

  return `<memory>
Structured memory carried over from previous sessions. This is a PARTIAL view showing pinned and recently updated nodes.${truncationNotice}

Use the memory tool to see more: "list" to browse children of a node (omit node_id for roots), "read" for one node with its ancestors and descendants, "search" for full-text lookup, "neighbors" to follow typed links.

<memory_nodes>
${lines}
</memory_nodes>
</memory>`;
};

/**
 * Static guidance telling the agent that structured memory exists and how to
 * use it.
 *
 * Safe for the system prompt (unlike note/memory CONTENT, which is injected
 * into messages) because this text never varies per request, so provider prompt
 * caching still hits. Without it the agent only learns about memory from the
 * tool description, which is not reliably enough to change its behavior — it
 * would not think to check memory before starting work.
 *
 * Deliberately short: the system prompt is already ~20KB and every token here
 * is paid on every request.
 *
 * Note: no backticks inside this template literal. An unescaped backtick
 * terminates the string and produces a confusing parse error.
 */
export const getMemoryGuidanceSection = (): string => `<memory_usage>
You have a "memory" tool: a persistent, navigable store that survives context limits and is shared across ALL of this user's conversations. It is a tree of nodes (like directories) plus typed links between them.

- At the start of substantive work, check it. Use "list" with no node_id to see roots, or "search" for a keyword. Recover what you already know instead of asking the user to repeat context.
- When you learn something durable (a confirmed finding, a working technique, a scope detail, a decision), save it with "create" under the relevant folder. Prefer several small focused nodes over one large one.
- When new information conflicts with a stored node, use "link" with "contradicts" or "supersedes". Do not silently delete or overwrite: the disagreement is often the useful part.
- When a conclusion rests on specific evidence, "link" it with "evidence_for" so the reasoning stays auditable.

Compacted conversations are recorded here automatically, so earlier context remains reachable even after it leaves the live window.
</memory_usage>`;

export type { MemoryNode };
