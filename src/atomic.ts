import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
