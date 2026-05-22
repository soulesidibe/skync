import { describe, it, expect } from "vitest";
import {
  containsConflictMarkers,
  treeConflictMarkerPaths,
  startMarkerLine,
  separatorMarkerLine,
  endMarkerLine,
} from "./conflict-markers.js";
import type { Tree } from "./treemerge.js";

function file(contents: string): { contents: Buffer; mode: number; type: "file" } {
  return { contents: Buffer.from(contents), mode: 0o644, type: "file" };
}

function tree(entries: Record<string, { contents: Buffer; mode: number; type: "file" | "symlink" }>): Tree {
  return new Map(Object.entries(entries));
}

const conflicted = [
  "intro\n",
  `${startMarkerLine}\n`,
  "mine\n",
  `${separatorMarkerLine}\n`,
  "theirs\n",
  `${endMarkerLine}\n`,
  "tail\n",
].join("");

describe("containsConflictMarkers", () => {
  it("detects a file carrying the full git-style marker triple", () => {
    expect(containsConflictMarkers(Buffer.from(conflicted))).toBe(true);
  });

  it("returns false for ordinary text", () => {
    expect(containsConflictMarkers(Buffer.from("just\nsome\nlines\n"))).toBe(false);
  });

  it("does not false-positive on prose that mentions a single marker", () => {
    // A doc explaining merges may show one marker but not the full anchored triple.
    const doc = "Resolve by deleting the <<<<<<< HEAD line in your editor.\n";
    expect(containsConflictMarkers(Buffer.from(doc))).toBe(false);
  });

  it("requires the markers at line starts, not mid-line", () => {
    const inline = "a ======= b\nx <<<<<<< y\nq >>>>>>> z\n";
    expect(containsConflictMarkers(Buffer.from(inline))).toBe(false);
  });

  it("skips binary content", () => {
    const bytes = Buffer.from([0x00, 0x3c, 0x3c, 0x3c, 0x3c, 0x3c, 0x3c, 0x3c]);
    expect(containsConflictMarkers(bytes)).toBe(false);
  });
});

describe("treeConflictMarkerPaths", () => {
  it("returns the sorted paths of files carrying markers, skipping clean ones", () => {
    const t = tree({
      "z.md": file(conflicted),
      "a.md": file(conflicted),
      "clean.md": file("nothing here\n"),
    });
    expect(treeConflictMarkerPaths(t)).toEqual(["a.md", "z.md"]);
  });

  it("returns an empty array for a clean tree", () => {
    const t = tree({ "a.md": file("ok\n") });
    expect(treeConflictMarkerPaths(t)).toEqual([]);
  });
});
