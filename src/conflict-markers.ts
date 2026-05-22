import { isBinary, type Tree } from "./treemerge.js";

/**
 * Git-style conflict marker pieces. TreeMerge emits these into a conflicted
 * text file and `update`/`resolve` scan for them, so the strings live in one
 * place to keep writer and reader from drifting apart.
 */
export const START_MARKER = "<<<<<<<";
export const SEPARATOR_MARKER = "=======";
export const END_MARKER = ">>>>>>>";
export const LOCAL_LABEL = "local";
export const UPSTREAM_LABEL = "upstream";

/** The exact lines TreeMerge writes (label after a space, git convention). */
export const startMarkerLine = `${START_MARKER} ${LOCAL_LABEL}`;
export const separatorMarkerLine = SEPARATOR_MARKER;
export const endMarkerLine = `${END_MARKER} ${UPSTREAM_LABEL}`;

// Anchored to line starts. The start/end markers allow a trailing label after a
// space (matching what we emit); the separator stands alone. Requiring all
// three guards against false positives from prose that mentions one marker.
const START_RE = /^<{7}(?: |$)/m;
const SEPARATOR_RE = /^={7}$/m;
const END_RE = /^>{7}(?: |$)/m;

/**
 * Whether a file's bytes carry an unresolved git-style conflict. Binary files
 * are skipped (markers are a text concept). Requires the full marker triple at
 * line starts, so a doc that merely mentions `<<<<<<<` is not flagged. This
 * shares git's residual limitation: a text file that legitimately contains all
 * three anchored markers reads as conflicted.
 */
export function containsConflictMarkers(contents: Buffer): boolean {
  if (isBinary(contents)) {
    return false;
  }
  const text = contents.toString("utf8");
  return START_RE.test(text) && SEPARATOR_RE.test(text) && END_RE.test(text);
}

/** The sorted paths of files in a tree that still carry conflict markers. */
export function treeConflictMarkerPaths(tree: Tree): string[] {
  const paths: string[] = [];
  for (const [path, entry] of tree) {
    if (entry.type === "file" && containsConflictMarkers(entry.contents)) {
      paths.push(path);
    }
  }
  return paths.sort();
}
