import { diff3Merge } from "node-diff3";

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

function sameContent(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.type === b.type && a.contents.equals(b.contents);
}

/** A NUL byte in the first ~8KB marks the file as binary (git's heuristic). */
function isBinary(contents: Buffer): boolean {
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
 * Three-way line merge of two text files that both changed. Returns the merged
 * bytes (newline style restored to local's) or null when regions overlap.
 */
function mergeText(baseEntry: TreeEntry, upstreamEntry: TreeEntry, localEntry: TreeEntry): Buffer | null {
  const regions = diff3Merge(
    toLines(localEntry.contents),
    toLines(baseEntry.contents),
    toLines(upstreamEntry.contents),
  );

  const lines: string[] = [];
  for (const region of regions) {
    if (region.conflict) {
      return null;
    }
    lines.push(...(region.ok ?? []));
  }

  return Buffer.from(lines.join(localNewline(localEntry.contents)), "utf8");
}

export function mergeTrees(base: Tree, upstream: Tree, local: Tree): MergeResult {
  const merged: Tree = new Map();
  const conflicts: Conflict[] = [];

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
      // delete. Keep the local side in the merged tree so nothing is lost.
      conflicts.push({ path, kind: "delete-modify" });
      if (l !== undefined) {
        merged.set(path, l);
      }
      continue;
    }

    if (u.type === "file" && l.type === "file" && !isBinary(u.contents) && !isBinary(l.contents)) {
      const text = b !== undefined ? mergeText(b, u, l) : null;
      if (text !== null) {
        merged.set(path, { contents: text, mode: l.mode, type: "file" });
        continue;
      }
      conflicts.push({ path, kind: b === undefined ? "add-add" : "content" });
      continue;
    }

    conflicts.push({ path, kind: b === undefined ? "add-add" : "binary" });
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
    conflicts.push({ path, kind: "type-change" });
  }

  return { merged, conflicts, clean: conflicts.length === 0 };
}
