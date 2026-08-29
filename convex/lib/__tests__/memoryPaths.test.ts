/**
 * Tests for the structured-memory path arithmetic.
 *
 * These functions are pure string manipulation, and a bug in any of them
 * corrupts tree structure silently rather than throwing — a mis-scoped prefix
 * scan rewrites unrelated nodes, and a missed cycle check detaches a subtree
 * into an unreachable loop. Since this repo has no `convex-test` harness, this
 * is the layer where tree correctness can actually be verified.
 */
import {
  ancestorIdsFromPath,
  buildNodePath,
  depthFromPath,
  isInsideSubtree,
  prefixUpperBound,
  rebaseDescendantPath,
  subtreePrefix,
  PATH_SEP,
} from "@/convex/lib/memoryPaths";

describe("buildNodePath", () => {
  it("returns the bare id for a root node", () => {
    expect(buildNodePath(null, "abc")).toBe("abc");
    expect(buildNodePath(undefined, "abc")).toBe("abc");
    // Empty string is falsy and must be treated as "no parent" rather than
    // producing a leading separator like "/abc".
    expect(buildNodePath("", "abc")).toBe("abc");
  });

  it("joins parent and child with the separator", () => {
    expect(buildNodePath("root", "child")).toBe("root/child");
    expect(buildNodePath("a/b", "c")).toBe("a/b/c");
  });
});

describe("subtreePrefix", () => {
  it("appends a trailing separator", () => {
    expect(subtreePrefix("abc")).toBe("abc/");
  });

  it("does not match a sibling whose id merely shares a prefix", () => {
    // The core reason the trailing separator exists. Scanning by the bare path
    // "abc" would also match "abcd", and that sibling would then be rewritten
    // as though it were a descendant.
    const prefix = subtreePrefix("abc");
    expect("abcd".startsWith(prefix)).toBe(false);
    expect("abc/child".startsWith(prefix)).toBe(true);
  });
});

describe("prefixUpperBound", () => {
  it("sorts above any path sharing the prefix", () => {
    const prefix = "abc/";
    const upper = prefixUpperBound(prefix);
    // Node ids are [0-9a-z], so every real descendant sorts inside the range.
    for (const id of ["0", "9", "a", "z", "m5k2p"]) {
      const path = `${prefix}${id}`;
      expect(path >= prefix).toBe(true);
      expect(path < upper).toBe(true);
    }
  });

  it("excludes the next sibling prefix from the range", () => {
    // "abd..." must fall outside the bounds for "abc/".
    const upper = prefixUpperBound("abc/");
    expect("abd/child" < upper).toBe(false);
  });
});

describe("isInsideSubtree", () => {
  const root = "a/b";

  it("treats the subtree root as inside itself", () => {
    // Move must reject reparenting a node onto itself.
    expect(isInsideSubtree(root, root)).toBe(true);
  });

  it("detects direct and deep descendants", () => {
    expect(isInsideSubtree("a/b/c", root)).toBe(true);
    expect(isInsideSubtree("a/b/c/d/e", root)).toBe(true);
  });

  it("rejects ancestors, siblings, and unrelated nodes", () => {
    expect(isInsideSubtree("a", root)).toBe(false);
    expect(isInsideSubtree("a/c", root)).toBe(false);
    expect(isInsideSubtree("x/y", root)).toBe(false);
  });

  it("rejects a sibling whose id extends the root id", () => {
    // "a/bb" is a sibling of "a/b", not a child. A naive startsWith without
    // the separator would wrongly report it as inside.
    expect(isInsideSubtree("a/bb", root)).toBe(false);
    expect(isInsideSubtree("a/bb/c", root)).toBe(false);
  });
});

describe("rebaseDescendantPath", () => {
  it("swaps the ancestor portion and preserves the tail", () => {
    expect(rebaseDescendantPath("a/b/c", "a/b", "x/y")).toBe("x/y/c");
    expect(rebaseDescendantPath("a/b/c/d", "a/b", "z")).toBe("z/c/d");
  });

  it("handles promotion to a root", () => {
    expect(rebaseDescendantPath("a/b/c", "a/b", "b")).toBe("b/c");
  });

  it("handles nesting deeper", () => {
    expect(rebaseDescendantPath("a/c", "a", "a/b")).toBe("a/b/c");
  });

  it("leaves a non-descendant untouched", () => {
    // Defensive: callers select rows by subtreePrefix, so this should not
    // occur. If a row is mis-selected it must be left alone, not mangled.
    expect(rebaseDescendantPath("x/y", "a/b", "z")).toBe("x/y");
    // Sibling sharing a prefix is not a descendant.
    expect(rebaseDescendantPath("a/bb", "a/b", "z")).toBe("a/bb");
    // The root itself is not rebased here; the caller patches it separately.
    expect(rebaseDescendantPath("a/b", "a/b", "z")).toBe("a/b");
  });

  it("round-trips a move and its inverse", () => {
    const original = "a/b/c/d";
    const moved = rebaseDescendantPath(original, "a/b", "x");
    expect(moved).toBe("x/c/d");
    expect(rebaseDescendantPath(moved, "x", "a/b")).toBe(original);
  });
});

describe("ancestorIdsFromPath", () => {
  it("returns an empty list for a root node", () => {
    expect(ancestorIdsFromPath("abc")).toEqual([]);
  });

  it("returns ancestors root-first, excluding the node itself", () => {
    expect(ancestorIdsFromPath("a/b/c")).toEqual(["a", "b"]);
    expect(ancestorIdsFromPath("a/b/c/d")).toEqual(["a", "b", "c"]);
  });
});

describe("depthFromPath", () => {
  it("counts a root node as depth 0", () => {
    expect(depthFromPath("abc")).toBe(0);
  });

  it("counts one level per separator", () => {
    expect(depthFromPath("a/b")).toBe(1);
    expect(depthFromPath("a/b/c")).toBe(2);
  });

  it("agrees with the length of the ancestor chain", () => {
    // Depth is also stored on the row for indexed queries; the two derivations
    // must not disagree.
    for (const path of ["a", "a/b", "a/b/c", "a/b/c/d/e"]) {
      expect(depthFromPath(path)).toBe(ancestorIdsFromPath(path).length);
    }
  });
});

describe("path invariants", () => {
  it("keeps buildNodePath and depthFromPath consistent as a tree grows", () => {
    let path = buildNodePath(null, "r");
    expect(depthFromPath(path)).toBe(0);

    for (let expectedDepth = 1; expectedDepth <= 5; expectedDepth++) {
      path = buildNodePath(path, `n${expectedDepth}`);
      expect(depthFromPath(path)).toBe(expectedDepth);
    }
    expect(path).toBe("r/n1/n2/n3/n4/n5");
  });

  it("uses a separator that cannot appear in generated node ids", () => {
    // Node ids come from base-36 encoding ([0-9a-z]), so the separator is
    // unambiguous and paths can be split safely.
    expect(PATH_SEP).toBe("/");
    expect(/^[0-9a-z]+$/.test(PATH_SEP)).toBe(false);
  });
});
