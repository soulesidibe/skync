import { diff3Merge } from "node-diff3";
import { startMarkerLine, separatorMarkerLine, endMarkerLine } from "./conflict-markers.js";

export interface TreeEntry {
  contents: Buffer;
  mode: number;
  type: "file" | "symlink";
}

export type Tree = Map<string, TreeEntry>;

export type ConflictKind = "content" | "binary" | "delete-modify" | "add-add" | "type-change";

export interface Conflict {
  path: string;
  kind: ConflictKind;
}

export interface MergeResult {
  merged: Tree;
  conflicts: Conflict[];
  clean: boolean;
}

export interface MergeOptions {
  /**
   * Two-way "adopt" comparison used by `skync add` against a non-empty dest.
   * Always called with an empty base. Reclassifies the no-base conflict labels
   * into the spec's vocabulary (content / binary / type-change) instead of the
   * generic "add-add" used by three-way merges.
   */
  adopt?: boolean;
}

function sameContent(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.type === b.type && a.contents.equals(b.contents);
}

/** A NUL byte in the first ~8KB marks the file as binary (git's heuristic). */
export function isBinary(contents: Buffer): boolean {
  const window = contents.subarray(0, 8000);
  return window.includes(0);
}

/**
 * Local file's newline style; LF unless CRLF is present. A file that mixes both
 * styles is rejoined uniformly as CRLF, which can normalize the endings of
 * untouched lines. Acceptable here: it only runs when both sides edited the
 * same file, and skill folders (markdown/scripts) rarely mix line endings.
 */
function localNewline(contents: Buffer): "\r\n" | "\n" {
  return contents.includes(Buffer.from("\r\n")) ? "\r\n" : "\n";
}

/**
 * Normalize CRLF to LF for diffing only, then split into logical lines such
 * that joining with a newline reconstructs the text exactly (a trailing
 * newline shows up as a final empty element).
 */
function toLines(contents: Buffer): string[] {
  return contents.toString("utf8").replace(/\r\n/g, "\n").split("\n");
}

/**
 * Three-way line merge of two text files that both changed. Auto-merges
 * non-overlapping regions; overlapping regions are written in place with
 * git-style conflict markers (local above the separator, upstream below) rather
 * than aborting. `baseEntry` is undefined for an add-add conflict, in which case
 * an empty base makes the whole file a single conflict block. Returns the bytes
 * (newline style restored to local's) plus whether any conflict was emitted.
 */
function mergeText(
  baseEntry: TreeEntry | undefined,
  upstreamEntry: TreeEntry,
  localEntry: TreeEntry,
): { contents: Buffer; conflicted: boolean } {
  const regions = diff3Merge(
    toLines(localEntry.contents),
    baseEntry !== undefined ? toLines(baseEntry.contents) : [],
    toLines(upstreamEntry.contents),
  );

  const lines: string[] = [];
  let conflicted = false;
  for (const region of regions) {
    if (region.conflict) {
      conflicted = true;
      // node-diff3: conflict.a is the first arg (local), conflict.b the third
      // (upstream). Marker lines are pushed as plain strings so the single join
      // below applies the local newline style uniformly.
      lines.push(startMarkerLine, ...region.conflict.a, separatorMarkerLine, ...region.conflict.b, endMarkerLine);
      continue;
    }
    lines.push(...(region.ok ?? []));
  }

  return {
    contents: Buffer.from(lines.join(localNewline(localEntry.contents)), "utf8"),
    conflicted,
  };
}

export function mergeTrees(base: Tree, upstream: Tree, local: Tree, opts: MergeOptions = {}): MergeResult {
  const merged: Tree = new Map();
  const conflicts: Conflict[] = [];
  const adopt = opts.adopt === true;

  const paths = new Set<string>([...base.keys(), ...upstream.keys(), ...local.keys()]);

  for (const path of paths) {
    const b = base.get(path);
    const u = upstream.get(path);
    const l = local.get(path);

    const upstreamChanged = !sameContent(b, u);
    const localChanged = !sameContent(b, l);

    if (!upstreamChanged) {
      // Upstream did not touch this path: keep the local side.
      if (l !== undefined) {
        merged.set(path, l);
      }
      continue;
    }

    if (!localChanged) {
      // Only upstream changed: take upstream.
      if (u !== undefined) {
        merged.set(path, u);
      }
      continue;
    }

    // Both sides changed this path.
    if (sameContent(u, l)) {
      // Both arrived at the same content (including both deleting it).
      if (l !== undefined) {
        merged.set(path, l);
      }
      continue;
    }

    if (u === undefined || l === undefined) {
      // One side deleted, the other modified: a conflict, never a silent
      // delete. Keep the modified side (whichever still exists) in the merged
      // tree so the user sees it and can reconcile, rather than it vanishing.
      conflicts.push({ path, kind: "delete-modify" });
      merged.set(path, (l ?? u) as TreeEntry);
      continue;
    }

    if (u.type === "file" && l.type === "file" && !isBinary(u.contents) && !isBinary(l.contents)) {
      const { contents, conflicted } = mergeText(b, u, l);
      merged.set(path, { contents, mode: l.mode, type: "file" });
      if (conflicted) {
        const kind: ConflictKind = adopt ? "content" : b === undefined ? "add-add" : "content";
        conflicts.push({ path, kind });
      }
      continue;
    }

    // Binary or type-mismatched both-sides change: cannot line-merge or mark.
    // Keep the local bytes intact (no corruption) and report the conflict.
    let kind: ConflictKind;
    if (adopt) {
      kind = u.type !== l.type ? "type-change" : "binary";
    } else {
      kind = b === undefined ? "add-add" : "binary";
    }
    conflicts.push({ path, kind });
    merged.set(path, l);
  }

  // A flat tree cannot hold both a file at "foo" and a file under "foo/...":
  // one path is a file, the other implies a directory of the same name. Report
  // each such collision as a type-change conflict and drop both sides so the
  // merged tree never produces a structure that cannot be written to disk.
  const collisions = new Set<string>();
  const sortedPaths = [...merged.keys()].sort();
  for (let i = 0; i < sortedPaths.length; i += 1) {
    const filePath = sortedPaths[i];
    const prefix = `${filePath}/`;
    for (let j = i + 1; j < sortedPaths.length && sortedPaths[j].startsWith(prefix); j += 1) {
      collisions.add(filePath);
      collisions.add(sortedPaths[j]);
    }
  }
  for (const path of collisions) {
    merged.delete(path);
    // A colliding path may already carry a content/binary conflict from the
    // pass above; drop that entry so the path is reported once, as the
    // type-change that actually dropped it from the tree.
    const existing = conflicts.findIndex((c) => c.path === path);
    if (existing !== -1) {
      conflicts.splice(existing, 1);
    }
    conflicts.push({ path, kind: "type-change" });
  }

  return { merged, conflicts, clean: conflicts.length === 0 };
}
