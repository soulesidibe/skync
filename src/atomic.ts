import { cp, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { isNotFound } from "./util.js";

/** Suffix for the saved-aside copy of dest during an atomic directory swap. */
export const OLD_DIR_SUFFIX = ".skync-old";

function tempSibling(target: string, label: string): string {
  return `${target}.${label}-${process.pid}-${Date.now()}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isNotFound(err)) {
      return false;
    }
    throw err;
  }
}

/**
 * Write a file atomically: create the parent dir, write to a temp file in the
 * SAME directory (so the rename stays on one filesystem), then rename over the
 * target. A reader sees either the old file or the new one, never a partial.
 */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, path);
}

/**
 * Replace `target` with a recursive copy of `srcDir`, atomically. Copies into a
 * temp sibling (same filesystem) preserving modes and symlinks, then swaps it
 * into place so a reader sees the whole old tree or the whole new one.
 */
export async function copyDirAtomic(target: string, srcDir: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = tempSibling(target, "tmp");
  await rm(tmp, { recursive: true, force: true });
  await cp(srcDir, tmp, { recursive: true, preserveTimestamps: true });
  await rm(target, { recursive: true, force: true });
  await rename(tmp, target);
}

function oldDirFor(dest: string): string {
  return join(dirname(dest), `${basename(dest)}${OLD_DIR_SUFFIX}`);
}

/**
 * Swap a fully-built `stagingDir` into `dest`. The staging dir must already sit
 * on the same filesystem as `dest` (build it via `stagingPathFor`). If `dest`
 * exists it is first moved to a fixed `<dest>.skync-old` sidecar, then staging
 * is renamed into place and the sidecar removed. A crash between the two renames
 * leaves the sidecar behind; `recoverPendingSwap` restores it on the next run.
 */
export async function swapDirAtomic(dest: string, stagingDir: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const old = oldDirFor(dest);
  await rm(old, { recursive: true, force: true });
  if (await exists(dest)) {
    await rename(dest, old);
  }
  await rename(stagingDir, dest);
  await rm(old, { recursive: true, force: true });
}

/**
 * Recover from a crash during `swapDirAtomic`: if the `<dest>.skync-old` sidecar
 * exists and `dest` is absent (crash between the two renames), restore the old
 * tree so `dest` is fully old. Safe to call before every update.
 */
export async function recoverPendingSwap(dest: string): Promise<void> {
  const old = oldDirFor(dest);
  if ((await exists(old)) && !(await exists(dest))) {
    await rename(old, dest);
  }
}

/** A same-filesystem staging path for building a new `dest` tree before swap. */
export function stagingPathFor(dest: string): string {
  return tempSibling(dest, "skync-staging");
}
