import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, GitError } from "./git.js";

describe("git", () => {
  it("runs git and returns stdout", async () => {
    const { stdout } = await git(["--version"]);
    expect(stdout).toMatch(/git version/);
  });

  it("throws GitError with an actionable message when the binary is missing", async () => {
    const opts = { gitPath: "/nonexistent/definitely/not/git" };
    await expect(git(["--version"], opts)).rejects.toThrow(GitError);
    await expect(git(["--version"], opts)).rejects.toThrow(/git not found/i);
  });

  it("throws GitError surfacing the failure on a non-zero exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-git-"));
    try {
      // Not a git repo, so rev-parse fails non-zero (binary present).
      await expect(
        git(["rev-parse", "--verify", "HEAD"], { cwd: dir }),
      ).rejects.toThrow(GitError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
