import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { swapDirAtomic, recoverPendingSwap, OLD_DIR_SUFFIX } from "./atomic.js";

describe("swapDirAtomic", () => {
  it("replaces an existing dest with the staging tree and leaves no temp behind", async () => {
    const work = await mkdtemp(join(tmpdir(), "skync-swap-"));
    try {
      const dest = join(work, "dest");
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, "old.txt"), "old\n");

      const staging = join(work, "dest.skync-staging");
      await mkdir(staging, { recursive: true });
      await writeFile(join(staging, "new.txt"), "new\n");

      await swapDirAtomic(dest, staging);

      // dest now holds exactly the staging contents.
      expect(await readdir(dest)).toEqual(["new.txt"]);
      expect(await readFile(join(dest, "new.txt"), "utf8")).toBe("new\n");

      // No staging or sidecar dirs left in the parent.
      const leftovers = (await readdir(work)).filter((e) => e !== "dest");
      expect(leftovers).toEqual([]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("recovers a crash mid-swap by restoring the saved-aside dir", async () => {
    const work = await mkdtemp(join(tmpdir(), "skync-recover-"));
    try {
      const dest = join(work, "dest");
      // Simulate a crash after dest was moved aside but before staging landed:
      // dest is absent, the .skync-old sidecar holds the old tree.
      const old = join(dirname(dest), `${basename(dest)}${OLD_DIR_SUFFIX}`);
      await mkdir(old, { recursive: true });
      await writeFile(join(old, "old.txt"), "old\n");

      await recoverPendingSwap(dest);

      expect(await readFile(join(dest, "old.txt"), "utf8")).toBe("old\n");
      const leftovers = (await readdir(work)).filter((e) => e !== "dest");
      expect(leftovers).toEqual([]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
