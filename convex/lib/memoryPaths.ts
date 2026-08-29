/**
 * Pure path arithmetic for the structured-memory tree.
 *
 * Extracted from `convex/memory.ts` so it can be unit tested without a Convex
 * harness (this repo has no `convex-test` dependency). Every function here is
 * pure string manipulation — no database access — and a bug in any of them
 * silently corrupts tree structure rather than throwing, so they are the part
 * most worth covering directly.
 *
 * Paths join `node_id`s with `/`, e.g. `root/child/grandchild`. IDs are used
 * rather than titles so renaming a node can never invalidate a descendant path.
 */

export const PATH_SEP = "/";

/**
 * Sentinel for the exclusive upper bound of a prefix range scan.
 *
 * Correctness depends on node IDs being restricted to `[0-9a-z]` (see
 * `generateId` in convex/memory.ts), so every real path character sorts below
 * U+FFFF. It is NOT a universally safe upper bound: astral-plane characters
 * (U+10000+) sort above U+FFFF and would escape the range. If ID generation
 * ever admits arbitrary characters, revisit this.
 */
const PREFIX_UPPER_SENTINEL = "\uffff";

/** Path of a new child under `parentPath`; pass null for a root node. */
export function buildNodePath(
  parentPath: string | null | undefined,
  nodeId: string,
): string {
  return parentPath ? `${parentPath}${PATH_SEP}${nodeId}` : nodeId;
}

/**
 * Inclusive lower bound for a subtree scan: the node's own path plus the
 * separator.
 *
 * The trailing separator is load-bearing. Scanning by the bare path would also
 * match sibling nodes whose ids merely share a prefix — `abc` would match
 * `abcd` — and those siblings would then be rewritten as if they were
 * descendants.
 */
export function subtreePrefix(path: string): string {
  return `${path}${PATH_SEP}`;
}

/** Exclusive upper bound matching `subtreePrefix`. */
export function prefixUpperBound(prefix: string): string {
  return `${prefix}${PREFIX_UPPER_SENTINEL}`;
}

/**
 * Whether `candidatePath` is the subtree root itself or sits inside it.
 *
 * Used as the cycle guard on move: reparenting a node into its own descendant
 * would detach the subtree into an unreachable loop.
 */
export function isInsideSubtree(
  candidatePath: string,
  subtreeRootPath: string,
): boolean {
  return (
    candidatePath === subtreeRootPath ||
    candidatePath.startsWith(subtreePrefix(subtreeRootPath))
  );
}

/**
 * Rewrite a descendant's path after its ancestor moved, swapping only the
 * ancestor portion and preserving the tail.
 *
 * Assumes `descendantPath` is a strict descendant of `oldRootPath` — which the
 * caller guarantees by selecting rows with `subtreePrefix(oldRootPath)`.
 * Returns the path unchanged if that does not hold, so a mis-selected row is
 * left alone rather than mangled.
 */
export function rebaseDescendantPath(
  descendantPath: string,
  oldRootPath: string,
  newRootPath: string,
): string {
  if (!descendantPath.startsWith(subtreePrefix(oldRootPath))) {
    return descendantPath;
  }
  return `${newRootPath}${descendantPath.slice(oldRootPath.length)}`;
}

/**
 * Ancestor ids from a path, root first, excluding the node itself.
 * `a/b/c` yields `["a", "b"]`.
 */
export function ancestorIdsFromPath(path: string): string[] {
  return path.split(PATH_SEP).slice(0, -1);
}

/**
 * Depth implied by a path (root = 0). Depth is also stored on the row for
 * indexed queries; this derives it for validation and for move arithmetic.
 */
export function depthFromPath(path: string): number {
  return path.split(PATH_SEP).length - 1;
}
