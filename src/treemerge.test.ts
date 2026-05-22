import { describe, it, expect } from "vitest";
import { mergeTrees, type Tree } from "./treemerge.js";
import { containsConflictMarkers } from "./conflict-markers.js";

function file(contents: string, mode = 0o644): { contents: Buffer; mode: number; type: "file" } {
  return { contents: Buffer.from(contents), mode, type: "file" };
}

function binary(bytes: number[], mode = 0o644): { contents: Buffer; mode: number; type: "file" } {
  return { contents: Buffer.from(bytes), mode, type: "file" };
}

function tree(entries: Record<string, { contents: Buffer; mode: number; type: "file" | "symlink" }>): Tree {
  return new Map(Object.entries(entries));
}

describe("treemerge", () => {
  it("applies an upstream-only change cleanly", () => {
    const base = tree({ "a.txt": file("x\n") });
    const upstream = tree({ "a.txt": file("y\n") });
    const local = tree({ "a.txt": file("x\n") });

    const result = mergeTrees(base, upstream, local);

    expect(result.clean).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.get("a.txt")?.contents.toString()).toBe("y\n");
  });

  it("applies disjoint upstream and local changes (non-overlapping auto-merge)", () => {
    const base = tree({ "a.txt": file("a1\n"), "b.txt": file("b1\n") });
    const upstream = tree({ "a.txt": file("a2\n"), "b.txt": file("b1\n") });
    const local = tree({ "a.txt": file("a1\n"), "b.txt": file("b2\n") });

    const result = mergeTrees(base, upstream, local);

    expect(result.clean).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.get("a.txt")?.contents.toString()).toBe("a2\n");
    expect(result.merged.get("b.txt")?.contents.toString()).toBe("b2\n");
  });

  it("adds an upstream-only new file and keeps a local-only new file", () => {
    const base = tree({ "keep.txt": file("k\n") });
    const upstream = tree({ "keep.txt": file("k\n"), "fromUpstream.txt": file("u\n") });
    const local = tree({ "keep.txt": file("k\n"), "fromLocal.txt": file("l\n") });

    const result = mergeTrees(base, upstream, local);

    expect(result.clean).toBe(true);
    expect(result.merged.get("fromUpstream.txt")?.contents.toString()).toBe("u\n");
    expect(result.merged.get("fromLocal.txt")?.contents.toString()).toBe("l\n");
  });

  it("line-merges non-overlapping edits within the same file", () => {
    const base = tree({ "f.txt": file("one\ntwo\nthree\n") });
    const upstream = tree({ "f.txt": file("ONE\ntwo\nthree\n") });
    const local = tree({ "f.txt": file("one\ntwo\nTHREE\n") });

    const result = mergeTrees(base, upstream, local);

    expect(result.clean).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.get("f.txt")?.contents.toString()).toBe("ONE\ntwo\nTHREE\n");
  });

  it("reports a binary file changed on both sides as a byte conflict, never line-merged", () => {
    const base = tree({ "img.bin": binary([0x00, 0x01, 0x02]) });
    const upstream = tree({ "img.bin": binary([0x00, 0x01, 0xff]) });
    const local = tree({ "img.bin": binary([0x00, 0x01, 0xaa]) });

    const result = mergeTrees(base, upstream, local);

    expect(result.clean).toBe(false);
    expect(result.conflicts).toEqual([{ path: "img.bin", kind: "binary" }]);
    // Binary cannot carry markers: keep the local bytes intact (no corruption,
    // no silent loss) and let the conflict report flag it.
    expect(result.merged.get("img.bin")?.contents).toEqual(Buffer.from([0x00, 0x01, 0xaa]));
  });

  it("treats a binary file changed identically on both sides as clean", () => {
    const base = tree({ "img.bin": binary([0x00, 0x01]) });
    const upstream = tree({ "img.bin": binary([0x00, 0x02]) });
    const local = tree({ "img.bin": binary([0x00, 0x02]) });

    const result = mergeTrees(base, upstream, local);

    expect(result.clean).toBe(true);
    expect(result.merged.get("img.bin")?.contents).toEqual(Buffer.from([0x00, 0x02]));
  });

  it("does not conflict on CRLF-vs-LF and preserves the local newline style", () => {
    const base = tree({ "f.txt": file("one\ntwo\nthree\n") });
    // Upstream changes line two, keeping LF.
    const upstream = tree({ "f.txt": file("one\nTWO\nthree\n") });
    // Local re-saved the same content with CRLF endings, no semantic change.
    const local = tree({ "f.txt": file("one\r\ntwo\r\nthree\r\n") });

    const result = mergeTrees(base, upstream, local);

    expect(result.clean).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.get("f.txt")?.contents.toString()).toBe("one\r\nTWO\r\nthree\r\n");
  });

  it("reports delete-vs-modify as a conflict when upstream deletes and local modifies", () => {
    const base = tree({ "f.txt": file("v1\n") });
    const upstream = tree({});
    const local = tree({ "f.txt": file("v2\n") });

    const result = mergeTrees(base, upstream, local);

    expect(result.clean).toBe(false);
    expect(result.conflicts).toEqual([{ path: "f.txt", kind: "delete-modify" }]);
    // Never a silent delete: the local edit is preserved in the merged tree.
    expect(result.merged.get("f.txt")?.contents.toString()).toBe("v2\n");
  });

  it("reports delete-vs-modify as a conflict when local deletes and upstream modifies", () => {
    const base = tree({ "f.txt": file("v1\n") });
    const upstream = tree({ "f.txt": file("v2\n") });
    const local = tree({});

    const result = mergeTrees(base, upstream, local);

    expect(result.clean).toBe(false);
    expect(result.conflicts).toEqual([{ path: "f.txt", kind: "delete-modify" }]);
    // Never a silent delete: when local deleted, keep the modified upstream side
    // so the file reappears for the user to reconcile rather than vanishing.
    expect(result.merged.get("f.txt")?.contents.toString()).toBe("v2\n");
  });

  it("deletes a file that upstream removed and local left untouched", () => {
    const base = tree({ "gone.txt": file("x\n"), "keep.txt": file("k\n") });
    const upstream = tree({ "keep.txt": file("k\n") });
    const local = tree({ "gone.txt": file("x\n"), "keep.txt": file("k\n") });

    const result = mergeTrees(base, upstream, local);

    expect(result.clean).toBe(true);
    expect(result.merged.has("gone.txt")).toBe(false);
    expect(result.merged.has("keep.txt")).toBe(true);
  });

  it("treats an identical add on both sides as clean", () => {
    const base = tree({});
    const upstream = tree({ "new.txt": file("same\n") });
    const local = tree({ "new.txt": file("same\n") });

    const result = mergeTrees(base, upstream, local);

    expect(result.clean).toBe(true);
    expect(result.merged.get("new.txt")?.contents.toString()).toBe("same\n");
  });

  it("writes git-style markers in place for an overlapping text conflict (local above upstream)", () => {
    const base = tree({ "f.txt": file("shared\n") });
    const upstream = tree({ "f.txt": file("upstream change\n") });
    const local = tree({ "f.txt": file("local change\n") });

    const result = mergeTrees(base, upstream, local);

    expect(result.clean).toBe(false);
    expect(result.conflicts).toEqual([{ path: "f.txt", kind: "content" }]);

    const merged = result.merged.get("f.txt")?.contents.toString() ?? "";
    expect(containsConflictMarkers(Buffer.from(merged))).toBe(true);
    // Local is rendered above the separator, upstream below it.
    expect(merged).toContain("local change");
    expect(merged).toContain("upstream change");
    expect(merged.indexOf("local change")).toBeLessThan(merged.indexOf("upstream change"));
    expect(merged.indexOf("<<<<<<<")).toBeLessThan(merged.indexOf("======="));
    expect(merged.indexOf("=======")).toBeLessThan(merged.indexOf(">>>>>>>"));
  });

  it("preserves the local newline style when writing conflict markers", () => {
    const base = tree({ "f.txt": file("shared\n") });
    const upstream = tree({ "f.txt": file("upstream\n") });
    const local = tree({ "f.txt": file("local\r\n") });

    const result = mergeTrees(base, upstream, local);

    const merged = result.merged.get("f.txt")?.contents.toString() ?? "";
    // Local used CRLF, so the marked output joins with CRLF throughout.
    expect(merged).toContain("\r\n");
    expect(merged).not.toMatch(/[^\r]\n/);
  });

  it("writes markers for a divergent add on both sides (add-add, empty base)", () => {
    const base = tree({});
    const upstream = tree({ "new.txt": file("from upstream\n") });
    const local = tree({ "new.txt": file("from local\n") });

    const result = mergeTrees(base, upstream, local);

    expect(result.clean).toBe(false);
    expect(result.conflicts).toEqual([{ path: "new.txt", kind: "add-add" }]);
    const merged = result.merged.get("new.txt")?.contents.toString() ?? "";
    expect(containsConflictMarkers(Buffer.from(merged))).toBe(true);
    expect(merged).toContain("from local");
    expect(merged).toContain("from upstream");
  });

  it("reports a file-vs-directory collision as a type-change conflict", () => {
    const base = tree({});
    const upstream = tree({ "foo/bar.txt": file("nested\n") });
    const local = tree({ foo: file("i am a file\n") });

    const result = mergeTrees(base, upstream, local);

    expect(result.clean).toBe(false);
    expect(result.conflicts.some((c) => c.kind === "type-change")).toBe(true);
    // Neither colliding side is written, so no broken tree is produced.
    expect(result.merged.has("foo")).toBe(false);
    expect(result.merged.has("foo/bar.txt")).toBe(false);
  });
});
