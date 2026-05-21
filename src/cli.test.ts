import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const cliPath = join(repoRoot, "dist", "cli.js");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the built CLI in a given working directory with an isolated HOME so the
 * global manifest never bleeds in from the test machine.
 */
async function runCli(args: string[], cwd: string, home: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await run("node", [cliPath, ...args], {
      cwd,
      env: { ...process.env, HOME: home, NO_COLOR: "1" },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("skync list (CLI)", () => {
  beforeAll(() => {
    // The dist build must exist before these integration tests run. Fail fast
    // with an actionable message instead of a confusing per-case spawn error.
    try {
      statSync(cliPath);
    } catch {
      throw new Error(`built CLI not found at ${cliPath}. Run npm run build first.`);
    }
  });

  it("prints an empty-state message and exits 0 with no manifests", async () => {
    const work = await mkdtemp(join(tmpdir(), "skync-empty-"));
    const home = await mkdtemp(join(tmpdir(), "skync-home-"));
    try {
      const res = await runCli(["list"], work, home);
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/no tracked skills/i);
    } finally {
      await rm(work, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("lists skills from a project manifest and exits 0", async () => {
    const work = await mkdtemp(join(tmpdir(), "skync-proj-"));
    const home = await mkdtemp(join(tmpdir(), "skync-home-"));
    try {
      await writeFile(
        join(work, "skync.yaml"),
        `remotes:\n  pocock:\n    repo: https://github.com/mattpocock/skills.git\nskills:\n  - name: gridmy\n    remote: pocock\n    src: skills/gridmy\n    dest: ~/.claude/skills/gridmy\n`,
      );
      const res = await runCli(["list"], work, home);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("gridmy");
      expect(res.stdout).toContain("pocock");
      expect(res.stdout).toContain(join(home, ".claude/skills/gridmy"));
    } finally {
      await rm(work, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reports a clean validation error and exits 1 on a malformed manifest", async () => {
    const work = await mkdtemp(join(tmpdir(), "skync-bad-"));
    const home = await mkdtemp(join(tmpdir(), "skync-home-"));
    try {
      await writeFile(
        join(work, "skync.yaml"),
        `skills:\n  - name: a\n    remote: ghost\n    src: x\n    dest: y\n`,
      );
      const res = await runCli(["list"], work, home);
      expect(res.code).toBe(1);
      expect(res.stderr).toMatch(/unknown remote 'ghost'/);
      // Not a stack trace.
      expect(res.stderr).not.toMatch(/at .*\(.*:\d+:\d+\)/);
    } finally {
      await rm(work, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
