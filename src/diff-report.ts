import { isBinary, type Tree, type TreeEntry } from "./treemerge.js";

/**
 * A → B classification of every path in either tree. Each path lands in exactly
 * one bucket. Mode-only changes (same type, same bytes, different file mode)
 * fold into `modified` to keep the buckets disjoint.
 */
export interface TreeDiff {
  added: string[];
  modified: string[];
  deleted: string[];
  typeChanged: string[];
}

/**
 * Compare two trees and return a per-path classification. `a` is the reference
 * (e.g. base), `b` is the other side (e.g. local or upstream). A path is:
 *   - `added` when present in b but not a
 *   - `deleted` when present in a but not b
 *   - `typeChanged` when both sides have it as different `type` (file ↔ symlink)
 *   - `modified` when both sides have it as the same type but contents or mode
 *     differ
 * Paths that match exactly (same type, same bytes, same mode) are omitted.
 * Each returned list is sorted for deterministic output.
 */
export function compareTrees(a: Tree, b: Tree): TreeDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const typeChanged: string[] = [];

  const paths = new Set<string>([...a.keys(), ...b.keys()]);
  for (const path of paths) {
    const ae = a.get(path);
    const be = b.get(path);
    if (ae === undefined) {
      added.push(path);
      continue;
    }
    if (be === undefined) {
      deleted.push(path);
      continue;
    }
    if (ae.type !== be.type) {
      typeChanged.push(path);
      continue;
    }
    if (!ae.contents.equals(be.contents) || ae.mode !== be.mode) {
      modified.push(path);
    }
  }

  added.sort();
  modified.sort();
  deleted.sort();
  typeChanged.sort();
  return { added, modified, deleted, typeChanged };
}

/**
 * Split utf8 bytes into lines such that joining with "\n" reconstructs the
 * input exactly. Mirrors the line-splitting convention TreeMerge uses for
 * three-way line merge (CRLF normalized to LF for comparison only).
 */
function toLines(contents: Buffer): string[] {
  return contents.toString("utf8").replace(/\r\n/g, "\n").split("\n");
}

/**
 * Longest common subsequence table for two line arrays. O(n*m) in time and
 * memory: fine for skill folders (markdown, scripts, configs), would need a
 * Myers-style replacement for files in the 50k-line range.
 */
function lcsTable(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        table[i][j] = table[i + 1][j + 1] + 1;
      } else {
        table[i][j] = Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
  }
  return table;
}

type DiffOp = { kind: "equal" | "del" | "add"; text: string };

/** Walk the LCS table to produce a flat add/del/equal script. */
function diffOps(a: string[], b: string[]): DiffOp[] {
  const table = lcsTable(a, b);
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "equal", text: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: "del", text: a[i] });
      i += 1;
    } else {
      ops.push({ kind: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    ops.push({ kind: "del", text: a[i] });
    i += 1;
  }
  while (j < b.length) {
    ops.push({ kind: "add", text: b[j] });
    j += 1;
  }
  return ops;
}

/**
 * Process the op list one op at a time into unified-diff hunks. Inside a hunk,
 * equal ops accumulate as trailing context; once 2*CONTEXT equals have piled up
 * without a new change we close the hunk (keeping CONTEXT trailing context
 * lines) and shift the rest into the leading-context buffer for the next hunk.
 */

/** A contiguous slice of the op script paired with its line offsets in a, b. */
interface Hunk {
  aStart: number; // 1-based start in a
  aLines: number;
  bStart: number; // 1-based start in b
  bLines: number;
  lines: string[]; // prefixed with " ", "-", or "+"
}

const CONTEXT = 3;

/**
 * Group the ops into unified-diff hunks. Equal runs longer than 2*CONTEXT lines
 * are collapsed into trailing context for one hunk and leading context for the
 * next; shorter equal runs join two changes into a single hunk.
 */
function opsToHunks(ops: DiffOp[]): Hunk[] {
  const hunks: Hunk[] = [];
  let aLine = 1;
  let bLine = 1;
  let current: Hunk | null = null;
  let leadingBuf: string[] = []; // equal texts waiting to attach as leading context
  let trailingCount = 0; // equal lines appended to `current` since the last change

  for (const op of ops) {
    if (op.kind === "equal") {
      if (current === null) {
        leadingBuf.push(op.text);
        if (leadingBuf.length > CONTEXT) leadingBuf.shift();
        aLine += 1;
        bLine += 1;
        continue;
      }
      current.lines.push(` ${op.text}`);
      current.aLines += 1;
      current.bLines += 1;
      aLine += 1;
      bLine += 1;
      trailingCount += 1;
      if (trailingCount === 2 * CONTEXT) {
        // Hold CONTEXT trailing in this hunk; spill the rest into leading
        // context for the next hunk so we don't merge changes that are far apart.
        const cut = current.lines.splice(current.lines.length - CONTEXT, CONTEXT);
        current.aLines -= CONTEXT;
        current.bLines -= CONTEXT;
        hunks.push(current);
        current = null;
        leadingBuf = cut.map((l) => l.slice(1));
        trailingCount = 0;
      }
      continue;
    }
    // Change op. Open a hunk if needed, then attach.
    if (current === null) {
      const leading = leadingBuf;
      current = {
        aStart: aLine - leading.length,
        aLines: leading.length,
        bStart: bLine - leading.length,
        bLines: leading.length,
        lines: leading.map((t) => ` ${t}`),
      };
      leadingBuf = [];
    }
    trailingCount = 0;
    if (op.kind === "del") {
      current.lines.push(`-${op.text}`);
      current.aLines += 1;
      aLine += 1;
    } else {
      current.lines.push(`+${op.text}`);
      current.bLines += 1;
      bLine += 1;
    }
  }
  if (current !== null) {
    // Trim trailing equals past CONTEXT at end of file.
    if (trailingCount > CONTEXT) {
      const excess = trailingCount - CONTEXT;
      current.lines.splice(current.lines.length - excess, excess);
      current.aLines -= excess;
      current.bLines -= excess;
    }
    hunks.push(current);
  }
  // Git convention: zero-length side uses start 0 ("after line 0").
  for (const h of hunks) {
    if (h.aLines === 0) h.aStart = 0;
    if (h.bLines === 0) h.bStart = 0;
  }
  return hunks;
}

function formatHunkHeader(h: Hunk): string {
  const a = h.aLines === 1 ? `${h.aStart}` : `${h.aStart},${h.aLines}`;
  const b = h.bLines === 1 ? `${h.bStart}` : `${h.bStart},${h.bLines}`;
  return `@@ -${a} +${b} @@`;
}

/**
 * Render a minimal unified diff for two byte buffers, using git's `--- a/` and
 * `+++ b/` headers (with `/dev/null` for an added or deleted file). For changes
 * that cannot be expressed as text hunks (binary, symlink target change, type
 * mismatch, mode-only change) the caller routes to a one-line summary above.
 */
function formatTextDiff(aPath: string, bPath: string, a: Buffer, b: Buffer): string {
  // Treat /dev/null as zero lines (not one phantom empty), so an add or delete
  // produces a clean "@@ -0,0 +1,N @@" hunk instead of a spurious equal trailer.
  const aLines = aPath === "/dev/null" ? [] : toLines(a);
  const bLines = bPath === "/dev/null" ? [] : toLines(b);
  const ops = diffOps(aLines, bLines);
  const hunks = opsToHunks(ops);
  const out: string[] = [`--- ${aPath}`, `+++ ${bPath}`];
  for (const h of hunks) {
    out.push(formatHunkHeader(h));
    out.push(...h.lines);
  }
  return out.join("\n") + "\n";
}

/**
 * Render a per-file diff block. The caller has already classified the change
 * (via compareTrees); this picks the right representation:
 *   - text change: unified diff with git-style headers (`/dev/null` on adds/deletes)
 *   - binary file: "Binary files ... differ" summary line
 *   - symlink target change: one-line summary
 *   - type change (file ↔ symlink): one-line summary
 *   - mode-only change (same bytes, same type): one-line summary
 * Never called with both sides undefined; that is a caller bug.
 */
export function formatFileDiff(args: {
  path: string;
  base: TreeEntry | undefined;
  other: TreeEntry | undefined;
}): string {
  const { path, base, other } = args;
  const aPath = `a/${path}`;
  const bPath = `b/${path}`;

  if (base === undefined && other === undefined) {
    throw new Error(`formatFileDiff called with both sides undefined for '${path}'`);
  }

  // Added.
  if (base === undefined) {
    const o = other as TreeEntry;
    if (o.type === "symlink") {
      return `Symlink added: ${path} -> ${o.contents.toString()}\n`;
    }
    if (isBinary(o.contents)) {
      return `Binary file added: ${path}\n`;
    }
    return formatTextDiff("/dev/null", bPath, Buffer.alloc(0), o.contents);
  }

  // Deleted.
  if (other === undefined) {
    if (base.type === "symlink") {
      return `Symlink deleted: ${path} -> ${base.contents.toString()}\n`;
    }
    if (isBinary(base.contents)) {
      return `Binary file deleted: ${path}\n`;
    }
    return formatTextDiff(aPath, "/dev/null", base.contents, Buffer.alloc(0));
  }

  // Type change (file ↔ symlink).
  if (base.type !== other.type) {
    return `Type changed (${base.type} -> ${other.type}): ${path}\n`;
  }

  // Both symlinks.
  if (base.type === "symlink") {
    const aT = base.contents.toString();
    const bT = other.contents.toString();
    if (aT === bT) {
      return `Symlink mode changed (${base.mode.toString(8)} -> ${other.mode.toString(8)}): ${path}\n`;
    }
    return `Symlink target changed: ${path}: ${aT} -> ${bT}\n`;
  }

  // Both files: binary?
  if (isBinary(base.contents) || isBinary(other.contents)) {
    return `Binary files ${aPath} and ${bPath} differ\n`;
  }

  // Contents identical but mode differs.
  if (base.contents.equals(other.contents)) {
    return `Mode changed (${base.mode.toString(8)} -> ${other.mode.toString(8)}): ${path}\n`;
  }

  return formatTextDiff(aPath, bPath, base.contents, other.contents);
}
