import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, readlink, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTree, writeTree } from "./tree-io.js";

describe("tree-io", () => {
  it("reads a directory into a flat tree with posix paths, modes, and symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-readtree-"));
    try {
      await mkdir(join(dir, "nested"), { recursive: true });
      await writeFile(join(dir, "doc.md"), "hello\n");
      await writeFile(join(dir, "nested", "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
      await symlink("doc.md", join(dir, "link"));

      const tree = await readTree(dir);

      expect([...tree.keys()].sort()).toEqual(["doc.md", "link", "nested/run.sh"]);
      expect(tree.get("doc.md")?.contents.toString()).toBe("hello\n");
      expect(tree.get("nested/run.sh")?.mode & 0o111).not.toBe(0);
      expect(tree.get("link")?.type).toBe("symlink");
      expect(tree.get("link")?.contents.toString()).toBe("doc.md");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty tree for a missing directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-readtree-"));
    try {
      const tree = await readTree(join(dir, "does-not-exist"));
      expect(tree.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes a tree to disk preserving modes and symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-writetree-"));
    try {
      const out = join(dir, "out");
      const tree = await (async () => {
        const t = new Map();
        t.set("a/b.txt", { contents: Buffer.from("body\n"), mode: 0o644, type: "file" });
        t.set("script.sh", { contents: Buffer.from("#!/bin/sh\n"), mode: 0o755, type: "file" });
        t.set("ln", { contents: Buffer.from("a/b.txt"), mode: 0o777, type: "symlink" });
        return t;
      })();

      await writeTree(out, tree);

      const { readFile } = await import("node:fs/promises");
      expect(await readFile(join(out, "a", "b.txt"), "utf8")).toBe("body\n");
      expect((await stat(join(out, "script.sh"))).mode & 0o111).not.toBe(0);
      expect(await readlink(join(out, "ln"))).toBe("a/b.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
