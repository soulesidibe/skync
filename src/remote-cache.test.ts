import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureRemoteClone,
  resolveRef,
  materializeSrc,
  cacheKeyForRepo,
  RemoteCacheError,
} from "./remote-cache.js";

const run = promisify(execFile);

// Isolate fixture git from the developer's global/system config so default
// branch name, hooks, and identity are deterministic.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function fixtureGit(args: string[], cwd: string): Promise<void> {
  await run("git", args, { cwd, env: GIT_ENV });
}

async function revParse(repo: string, ref: string): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", ref], { cwd: repo, env: GIT_ENV });
  return stdout.trim();
}

let fixture: string;
let fileUrl: string;
let tagSha: string;

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), "skync-fixture-"));
  await mkdir(join(fixture, "skills", "demo"), { recursive: true });
  await writeFile(join(fixture, "README.md"), "root\n");
  await writeFile(join(fixture, "skills", "demo", "SKILL.md"), "demo v1\n");
  await writeFile(join(fixture, "skills", "demo", "extra.txt"), "x\n");
  await fixtureGit(["init", "-q", "-b", "main"], fixture);
  await fixtureGit(["add", "-A"], fixture);
  await fixtureGit(["commit", "-q", "-m", "init"], fixture);
  await fixtureGit(["tag", "v1"], fixture);
  tagSha = await revParse(fixture, "v1");
  fileUrl = `file://${fixture}`;
});

afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe("cacheKeyForRepo", () => {
  it("is stable across equivalent URL spellings", () => {
    expect(cacheKeyForRepo("https://github.com/u/r.git")).toBe(
      cacheKeyForRepo("https://github.com/u/r/"),
    );
  });

  it("differs for different repos", () => {
    expect(cacheKeyForRepo("https://github.com/u/a")).not.toBe(
      cacheKeyForRepo("https://github.com/u/b"),
    );
  });
});

describe("RemoteCache (against a local fixture repo)", () => {
  it("resolves a branch, tag, and SHA to the same concrete commit", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "skync-cache-"));
    try {
      const repoPath = await ensureRemoteClone(cacheDir, fileUrl);
      const expected = await revParse(fixture, "main");
      expect(await resolveRef(repoPath, "main")).toBe(expected);
      expect(await resolveRef(repoPath, "v1")).toBe(tagSha);
      expect(await resolveRef(repoPath, expected)).toBe(expected);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("throws RemoteCacheError for an unknown ref", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "skync-cache-"));
    try {
      const repoPath = await ensureRemoteClone(cacheDir, fileUrl);
      await expect(resolveRef(repoPath, "no-such-ref")).rejects.toThrow(
        RemoteCacheError,
      );
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("materializes only the src subtree at a SHA", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "skync-cache-"));
    const dest = await mkdtemp(join(tmpdir(), "skync-dest-"));
    try {
      const repoPath = await ensureRemoteClone(cacheDir, fileUrl);
      const sha = await resolveRef(repoPath, "main");
      await materializeSrc(repoPath, sha, "skills/demo", dest);
      const entries = (await readdir(dest)).sort();
      expect(entries).toEqual(["SKILL.md", "extra.txt"]);
      // Files above the src path must not leak in.
      expect(entries).not.toContain("README.md");
      expect(await readFile(join(dest, "SKILL.md"), "utf8")).toBe("demo v1\n");
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });

  it("re-fetches and sees a new SHA after the fixture advances", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "skync-cache-"));
    const dest = await mkdtemp(join(tmpdir(), "skync-dest-"));
    try {
      const repoPath = await ensureRemoteClone(cacheDir, fileUrl);
      const sha1 = await resolveRef(repoPath, "main");

      // Advance the fixture.
      await writeFile(join(fixture, "skills", "demo", "SKILL.md"), "demo v2\n");
      await fixtureGit(["add", "-A"], fixture);
      await fixtureGit(["commit", "-q", "-m", "v2"], fixture);

      await ensureRemoteClone(cacheDir, fileUrl); // fetch into existing cache
      const sha2 = await resolveRef(repoPath, "main");
      expect(sha2).not.toBe(sha1);

      await materializeSrc(repoPath, sha2, "skills/demo", dest);
      expect(await readFile(join(dest, "SKILL.md"), "utf8")).toBe("demo v2\n");
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });

  it("reports a clear error when the git binary is missing", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "skync-cache-"));
    try {
      await expect(
        ensureRemoteClone(cacheDir, fileUrl, {
          gitPath: "/nonexistent/definitely/not/git",
        }),
      ).rejects.toThrow(/git not found/i);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
