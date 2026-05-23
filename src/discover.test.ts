import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSkill,
  DiscoveryNoMatchError,
  DiscoveryMultipleMatchError,
} from "./discover.js";

const run = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

interface FileEntry {
  path: string;
  contents: string | Buffer;
}

/**
 * Build a throwaway git repo from a flat list of files, commit them, and return
 * the repo path plus the resulting SHA. Mirrors the integration-test pattern in
 * cli.test.ts but stays focused on tree shape (no remote, no clone).
 */
async function buildRepo(files: FileEntry[]): Promise<{ repo: string; sha: string }> {
  const repo = await mkdtemp(join(tmpdir(), "skync-discover-"));
  for (const entry of files) {
    const abs = join(repo, entry.path);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, entry.contents);
  }
  await run("git", ["init", "-q", "-b", "main"], { cwd: repo, env: GIT_ENV });
  await run("git", ["add", "-A"], { cwd: repo, env: GIT_ENV });
  await run("git", ["commit", "-q", "-m", "init"], { cwd: repo, env: GIT_ENV });
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: repo, env: GIT_ENV });
  return { repo, sha: stdout.trim() };
}

function frontmatter(name: unknown, body = ""): string {
  const yamlValue =
    typeof name === "string"
      ? name
      : name === null
        ? "null"
        : JSON.stringify(name);
  return `---\nname: ${yamlValue}\n---\n${body}`;
}

describe("discoverSkill", () => {
  it("returns the folder path on an exact intersection match", async () => {
    const { repo, sha } = await buildRepo([
      { path: "skills/demo/SKILL.md", contents: frontmatter("demo", "demo skill\n") },
    ]);
    const path = await discoverSkill(repo, sha, "demo");
    expect(path).toBe("skills/demo");
  });

  it("rejects a folder-name match whose frontmatter name differs", async () => {
    const { repo, sha } = await buildRepo([
      { path: "skills/demo/SKILL.md", contents: frontmatter("other", "body\n") },
    ]);
    await expect(discoverSkill(repo, sha, "demo")).rejects.toBeInstanceOf(
      DiscoveryNoMatchError,
    );
  });

  it("rejects a frontmatter match whose folder name differs", async () => {
    const { repo, sha } = await buildRepo([
      { path: "skills/wrongfolder/SKILL.md", contents: frontmatter("demo", "body\n") },
    ]);
    await expect(discoverSkill(repo, sha, "demo")).rejects.toBeInstanceOf(
      DiscoveryNoMatchError,
    );
  });

  it("rejects a SKILL.md with no frontmatter at all", async () => {
    const { repo, sha } = await buildRepo([
      { path: "skills/demo/SKILL.md", contents: "no frontmatter here\n" },
    ]);
    await expect(discoverSkill(repo, sha, "demo")).rejects.toBeInstanceOf(
      DiscoveryNoMatchError,
    );
  });

  it("rejects a SKILL.md whose frontmatter has no closing fence", async () => {
    const { repo, sha } = await buildRepo([
      { path: "skills/demo/SKILL.md", contents: "---\nname: demo\nno close fence\n" },
    ]);
    await expect(discoverSkill(repo, sha, "demo")).rejects.toBeInstanceOf(
      DiscoveryNoMatchError,
    );
  });

  it("rejects a SKILL.md whose frontmatter parses to a non-object", async () => {
    const { repo, sha } = await buildRepo([
      { path: "skills/demo/SKILL.md", contents: "---\n- demo\n---\nbody\n" },
    ]);
    await expect(discoverSkill(repo, sha, "demo")).rejects.toBeInstanceOf(
      DiscoveryNoMatchError,
    );
  });

  it("rejects a SKILL.md whose name field is a non-string value", async () => {
    for (const value of [123, null, ["demo"], { nested: "demo" }]) {
      const { repo, sha } = await buildRepo([
        { path: "skills/demo/SKILL.md", contents: frontmatter(value, "body\n") },
      ]);
      await expect(discoverSkill(repo, sha, "demo")).rejects.toBeInstanceOf(
        DiscoveryNoMatchError,
      );
    }
  });

  it("rejects a SKILL.md missing the name field entirely", async () => {
    const { repo, sha } = await buildRepo([
      { path: "skills/demo/SKILL.md", contents: "---\ndescription: x\n---\nbody\n" },
    ]);
    await expect(discoverSkill(repo, sha, "demo")).rejects.toBeInstanceOf(
      DiscoveryNoMatchError,
    );
  });

  it("matches when the file has CRLF line endings and a BOM", async () => {
    const bom = "﻿";
    const contents = `${bom}---\r\nname: demo\r\n---\r\nbody\r\n`;
    const { repo, sha } = await buildRepo([
      { path: "skills/demo/SKILL.md", contents },
    ]);
    const path = await discoverSkill(repo, sha, "demo");
    expect(path).toBe("skills/demo");
  });

  it("matches when the file ends with the closing fence and no trailing newline", async () => {
    const { repo, sha } = await buildRepo([
      { path: "skills/demo/SKILL.md", contents: "---\nname: demo\n---" },
    ]);
    const path = await discoverSkill(repo, sha, "demo");
    expect(path).toBe("skills/demo");
  });

  it("reports multiple candidates sorted lexicographically", async () => {
    const { repo, sha } = await buildRepo([
      { path: "skills/demo/SKILL.md", contents: frontmatter("demo") },
      { path: "vendor/skills/demo/SKILL.md", contents: frontmatter("demo") },
    ]);
    await expect(discoverSkill(repo, sha, "demo")).rejects.toMatchObject({
      candidates: ["skills/demo", "vendor/skills/demo"],
    });
    await expect(discoverSkill(repo, sha, "demo")).rejects.toBeInstanceOf(
      DiscoveryMultipleMatchError,
    );
  });

  it("ignores SKILL.md files inside denylisted directories at any depth", async () => {
    const { repo, sha } = await buildRepo([
      { path: "node_modules/demo/SKILL.md", contents: frontmatter("demo") },
      { path: "build/demo/SKILL.md", contents: frontmatter("demo") },
      { path: "dist/demo/SKILL.md", contents: frontmatter("demo") },
      { path: "target/demo/SKILL.md", contents: frontmatter("demo") },
      { path: ".venv/demo/SKILL.md", contents: frontmatter("demo") },
      { path: "top/node_modules/demo/SKILL.md", contents: frontmatter("demo") },
      { path: "skills/demo/SKILL.md", contents: frontmatter("demo") },
    ]);
    const path = await discoverSkill(repo, sha, "demo");
    expect(path).toBe("skills/demo");
  });

  it("ignores a SKILL.md at the repo root", async () => {
    const { repo, sha } = await buildRepo([
      { path: "SKILL.md", contents: frontmatter("demo") },
    ]);
    await expect(discoverSkill(repo, sha, "demo")).rejects.toBeInstanceOf(
      DiscoveryNoMatchError,
    );
  });

  it("raises NoMatchError carrying the requested name and the SHA", async () => {
    const { repo, sha } = await buildRepo([
      { path: "skills/other/SKILL.md", contents: frontmatter("other") },
    ]);
    await expect(discoverSkill(repo, sha, "demo")).rejects.toMatchObject({
      skillName: "demo",
      sha,
    });
  });
});
