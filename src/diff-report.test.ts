import { describe, it, expect } from "vitest";
import { compareTrees, formatFileDiff } from "./diff-report.js";
import type { Tree, TreeEntry } from "./treemerge.js";

function file(text: string, mode = 0o644): TreeEntry {
  return { contents: Buffer.from(text), mode, type: "file" };
}

function bin(bytes: number[], mode = 0o644): TreeEntry {
  return { contents: Buffer.from([...bytes, 0, ...bytes]), mode, type: "file" };
}

function link(target: string, mode = 0o777): TreeEntry {
  return { contents: Buffer.from(target), mode, type: "symlink" };
}

describe("compareTrees", () => {
  it("classifies identical trees as no diffs", () => {
    const a: Tree = new Map([
      ["a.md", file("hi\n")],
      ["b.md", file("ho\n")],
    ]);
    const b: Tree = new Map([
      ["a.md", file("hi\n")],
      ["b.md", file("ho\n")],
    ]);
    expect(compareTrees(a, b)).toEqual({ added: [], modified: [], deleted: [], typeChanged: [] });
  });

  it("detects added paths only in b", () => {
    const a: Tree = new Map([["a.md", file("hi\n")]]);
    const b: Tree = new Map([
      ["a.md", file("hi\n")],
      ["new.md", file("new\n")],
    ]);
    expect(compareTrees(a, b)).toEqual({
      added: ["new.md"],
      modified: [],
      deleted: [],
      typeChanged: [],
    });
  });

  it("detects deleted paths only in a", () => {
    const a: Tree = new Map([
      ["a.md", file("hi\n")],
      ["gone.md", file("gone\n")],
    ]);
    const b: Tree = new Map([["a.md", file("hi\n")]]);
    expect(compareTrees(a, b)).toEqual({
      added: [],
      modified: [],
      deleted: ["gone.md"],
      typeChanged: [],
    });
  });

  it("detects modified content", () => {
    const a: Tree = new Map([["a.md", file("hi\n")]]);
    const b: Tree = new Map([["a.md", file("ho\n")]]);
    expect(compareTrees(a, b).modified).toEqual(["a.md"]);
  });

  it("detects mode-only change as modified", () => {
    const a: Tree = new Map([["s.sh", file("#!/bin/sh\n", 0o644)]]);
    const b: Tree = new Map([["s.sh", file("#!/bin/sh\n", 0o755)]]);
    expect(compareTrees(a, b).modified).toEqual(["s.sh"]);
  });

  it("detects type change (file -> symlink)", () => {
    const a: Tree = new Map([["x", file("body\n")]]);
    const b: Tree = new Map([["x", link("target")]]);
    expect(compareTrees(a, b).typeChanged).toEqual(["x"]);
  });

  it("treats equal-bytes symlinks as unchanged", () => {
    const a: Tree = new Map([["x", link("target")]]);
    const b: Tree = new Map([["x", link("target")]]);
    expect(compareTrees(a, b)).toEqual({ added: [], modified: [], deleted: [], typeChanged: [] });
  });

  it("treats different-target symlinks as modified", () => {
    const a: Tree = new Map([["x", link("old")]]);
    const b: Tree = new Map([["x", link("new")]]);
    expect(compareTrees(a, b).modified).toEqual(["x"]);
  });

  it("sorts each bucket", () => {
    const a: Tree = new Map([
      ["z.md", file("z\n")],
      ["a.md", file("a\n")],
    ]);
    const b: Tree = new Map([
      ["m.md", file("m\n")],
      ["b.md", file("b\n")],
    ]);
    const d = compareTrees(a, b);
    expect(d.added).toEqual(["b.md", "m.md"]);
    expect(d.deleted).toEqual(["a.md", "z.md"]);
  });
});

describe("formatFileDiff", () => {
  it("renders added text file against /dev/null with +lines", () => {
    const out = formatFileDiff({ path: "new.md", base: undefined, other: file("hello\nworld\n") });
    expect(out).toContain("--- /dev/null");
    expect(out).toContain("+++ b/new.md");
    expect(out).toContain("+hello");
    expect(out).toContain("+world");
    // No deletion lines (the `--- ` header is not a deletion).
    expect(out).not.toMatch(/^-[^-]/m);
  });

  it("renders deleted text file with /dev/null on the b side and -lines", () => {
    const out = formatFileDiff({ path: "gone.md", base: file("hello\n"), other: undefined });
    expect(out).toContain("--- a/gone.md");
    expect(out).toContain("+++ /dev/null");
    expect(out).toContain("-hello");
  });

  it("renders a modified text file with both - and + lines and a hunk header", () => {
    const out = formatFileDiff({ path: "a.md", base: file("one\ntwo\nthree\n"), other: file("one\nTWO\nthree\n") });
    expect(out).toMatch(/^---/m);
    expect(out).toMatch(/^\+\+\+/m);
    expect(out).toMatch(/^@@ /m);
    expect(out).toContain("-two");
    expect(out).toContain("+TWO");
    expect(out).toContain(" one");
    expect(out).toContain(" three");
  });

  it("summarizes binary files instead of dumping bytes", () => {
    const out = formatFileDiff({ path: "logo.png", base: bin([1, 2, 3]), other: bin([9, 8, 7]) });
    expect(out).toMatch(/^Binary files .* differ$/m);
    expect(out).not.toContain("@@");
  });

  it("summarizes binary file addition", () => {
    const out = formatFileDiff({ path: "logo.png", base: undefined, other: bin([1, 2, 3]) });
    expect(out).toMatch(/^Binary file added: logo\.png/m);
  });

  it("summarizes binary file deletion", () => {
    const out = formatFileDiff({ path: "logo.png", base: bin([1, 2, 3]), other: undefined });
    expect(out).toMatch(/^Binary file deleted: logo\.png/m);
  });

  it("summarizes a symlink added", () => {
    const out = formatFileDiff({ path: "link", base: undefined, other: link("./target") });
    expect(out).toMatch(/^Symlink added: link -> \.\/target/m);
  });

  it("summarizes a symlink target change", () => {
    const out = formatFileDiff({ path: "link", base: link("./a"), other: link("./b") });
    expect(out).toMatch(/Symlink target changed: link: \.\/a -> \.\/b/);
  });

  it("summarizes a type change (file <-> symlink)", () => {
    const out = formatFileDiff({ path: "x", base: file("body\n"), other: link("./target") });
    expect(out).toMatch(/^Type changed \(file -> symlink\): x/m);
  });

  it("summarizes a mode-only change on identical bytes", () => {
    const out = formatFileDiff({
      path: "run.sh",
      base: file("#!/bin/sh\necho hi\n", 0o644),
      other: file("#!/bin/sh\necho hi\n", 0o755),
    });
    expect(out).toMatch(/^Mode changed \(644 -> 755\): run\.sh/m);
    expect(out).not.toContain("@@");
  });

  it("throws when called with both sides undefined", () => {
    expect(() =>
      formatFileDiff({ path: "x", base: undefined, other: undefined }),
    ).toThrow();
  });
});
