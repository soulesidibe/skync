import { mkdir, readdir, readFile, readlink, lstat, symlink, writeFile, chmod } from "node:fs/promises";
import { join, dirname, relative, sep } from "node:path";
import { isNotFound } from "./util.js";
import type { Tree } from "./treemerge.js";

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/**
 * Read a directory tree into the flat in-memory shape TreeMerge operates on.
 * Keys are posix-style relative paths; files carry their bytes and mode,
 * symlinks carry their link target as bytes. A missing directory yields an
 * empty tree (a never-synced or fully-removed skill). Empty directories are
 * intentionally not recorded, matching git/`git archive` semantics (the
 * upstream source materialized via git never carries empty dirs either).
 */
export async function readTree(dir: string): Promise<Tree> {
  const tree: Tree = new Map();

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      if (isNotFound(err)) {
        return;
      }
      throw err;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const key = toPosix(relative(dir, full));
      if (entry.isSymbolicLink()) {
        const target = await readlink(full);
        tree.set(key, { contents: Buffer.from(target), mode: 0o777, type: "symlink" });
        continue;
      }
      const [contents, info] = await Promise.all([readFile(full), lstat(full)]);
      tree.set(key, { contents, mode: info.mode & 0o777, type: "file" });
    }
  }

  await walk(dir);
  return tree;
}

/**
 * Materialize a tree to disk under `dir`, creating parent directories,
 * restoring file modes, and recreating symlinks. The caller is responsible for
 * `dir` being empty or fresh (e.g. a staging dir).
 */
export async function writeTree(dir: string, tree: Tree): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [key, entry] of tree) {
    const full = join(dir, key);
    await mkdir(dirname(full), { recursive: true });
    if (entry.type === "symlink") {
      await symlink(entry.contents.toString(), full);
      continue;
    }
    await writeFile(full, entry.contents);
    await chmod(full, entry.mode);
  }
}
