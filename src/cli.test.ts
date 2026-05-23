import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const cliPath = join(repoRoot, "dist", "cli.js");

// Git env isolated from the developer's global/system config for deterministic
// fixture repos (default branch name, identity, hooks).
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/**
 * Create a small fixture git repo with a `skills/demo` subtree and return a
 * `file://` URL for it.
 */
async function createFixtureRepo(): Promise<{ dir: string; url: string }> {
  const dir = await mkdtemp(join(tmpdir(), "skync-fixture-"));
  await mkdir(join(dir, "skills", "demo"), { recursive: true });
  await writeFile(join(dir, "README.md"), "root\n");
  await writeFile(join(dir, "skills", "demo", "SKILL.md"), "demo v1\n");
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir, env: GIT_ENV });
  await run("git", ["add", "-A"], { cwd: dir, env: GIT_ENV });
  await run("git", ["commit", "-q", "-m", "init"], { cwd: dir, env: GIT_ENV });
  return { dir, url: `file://${dir}` };
}

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

describe("skync add (CLI)", () => {
  it("vendors a fresh project skill: dest, base, manifest, and state", async () => {
    const fixture = await createFixtureRepo();
    const work = await mkdtemp(join(tmpdir(), "skync-add-"));
    const home = await mkdtemp(join(tmpdir(), "skync-home-"));
    try {
      const res = await runCli(
        ["add", "demo", "--repo", fixture.url, "--src", "skills/demo", "--dest", "vendor/demo"],
        work,
        home,
      );
      expect(res.code).toBe(0);

      // dest received only the subtree contents.
      expect(await readFile(join(work, "vendor/demo/SKILL.md"), "utf8")).toBe("demo v1\n");
      // base mirrors the synced upstream.
      expect(await readFile(join(work, ".skync/base/demo/SKILL.md"), "utf8")).toBe("demo v1\n");

      // manifest gained the skill and an auto-named remote.
      const manifest = await readFile(join(work, "skync.yaml"), "utf8");
      expect(manifest).toContain("name: demo");
      expect(manifest).toContain("src: skills/demo");

      // state.json recorded a concrete 40-char SHA.
      const state = JSON.parse(await readFile(join(work, ".skync/state.json"), "utf8"));
      expect(state.skills.demo.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(state.skills.demo.src).toBe("skills/demo");
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("vendors a fresh global skill under the global state dir", async () => {
    const fixture = await createFixtureRepo();
    const work = await mkdtemp(join(tmpdir(), "skync-add-"));
    const home = await mkdtemp(join(tmpdir(), "skync-home-"));
    try {
      const res = await runCli(
        [
          "add",
          "demo",
          "--global",
          "--repo",
          fixture.url,
          "--src",
          "skills/demo",
          "--dest",
          "~/.claude/skills/demo",
        ],
        work,
        home,
      );
      expect(res.code).toBe(0);
      expect(await readFile(join(home, ".claude/skills/demo/SKILL.md"), "utf8")).toBe("demo v1\n");
      const manifest = await readFile(join(home, ".config/skync/manifest.yaml"), "utf8");
      expect(manifest).toContain("name: demo");
      const state = JSON.parse(
        await readFile(join(home, ".config/skync/.skync/state.json"), "utf8"),
      );
      expect(state.skills.demo.sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("adopts an existing non-empty dest: leaves it untouched, seeds base from upstream", async () => {
    const fixture = await createFixtureRepo();
    const work = await mkdtemp(join(tmpdir(), "skync-add-"));
    const home = await mkdtemp(join(tmpdir(), "skync-home-"));
    try {
      // A pre-existing, locally-modified dest. Its content diverges from
      // upstream and it carries an extra file that upstream does not have.
      await mkdir(join(work, "vendor/demo"), { recursive: true });
      await writeFile(join(work, "vendor/demo/SKILL.md"), "mine\n");
      await writeFile(join(work, "vendor/demo/local.md"), "local only\n");

      const res = await runCli(
        ["add", "demo", "--repo", fixture.url, "--src", "skills/demo", "--dest", "vendor/demo"],
        work,
        home,
      );
      expect(res.code).toBe(0);

      // dest is adopted as-is: local edits and local-only files survive.
      expect(await readFile(join(work, "vendor/demo/SKILL.md"), "utf8")).toBe("mine\n");
      expect(await readFile(join(work, "vendor/demo/local.md"), "utf8")).toBe("local only\n");

      // base is seeded from current upstream, not from the adopted dest.
      expect(await readFile(join(work, ".skync/base/demo/SKILL.md"), "utf8")).toBe("demo v1\n");

      // manifest gained the skill.
      const manifest = await readFile(join(work, "skync.yaml"), "utf8");
      expect(manifest).toContain("name: demo");
      expect(manifest).toContain("src: skills/demo");

      // state.json recorded the resolved upstream SHA.
      const state = JSON.parse(await readFile(join(work, ".skync/state.json"), "utf8"));
      expect(state.skills.demo.sha).toMatch(/^[0-9a-f]{40}$/);

      // output communicates the adopt path and the predating-changes limitation.
      expect(res.stdout).toMatch(/adopted/i);
      expect(res.stdout).toMatch(/kept existing/i);
      expect(res.stdout).toMatch(/baked into base/i);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});

async function commitToFixture(dir: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [rel, contents] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), contents);
  }
  await run("git", ["add", "-A"], { cwd: dir, env: GIT_ENV });
  await run("git", ["commit", "-q", "-m", message], { cwd: dir, env: GIT_ENV });
}

async function demoStateSha(work: string): Promise<string> {
  const state = JSON.parse(await readFile(join(work, ".skync/state.json"), "utf8"));
  return state.skills.demo.sha as string;
}

describe("skync update (CLI)", () => {
  it("applies a non-overlapping upstream change and preserves a local edit", async () => {
    const fixture = await createFixtureRepo();
    const work = await mkdtemp(join(tmpdir(), "skync-update-"));
    const home = await mkdtemp(join(tmpdir(), "skync-home-"));
    try {
      const add = await runCli(
        ["add", "demo", "--repo", fixture.url, "--src", "skills/demo", "--dest", "vendor/demo"],
        work,
        home,
      );
      expect(add.code).toBe(0);
      const before = await demoStateSha(work);

      // Local edit to a file upstream does not touch.
      await writeFile(join(work, "vendor/demo/SKILL.md"), "demo v1 local edit\n");
      // Upstream adds a new file (non-overlapping).
      await commitToFixture(fixture.dir, { "skills/demo/EXTRA.md": "extra\n" }, "add extra");

      const res = await runCli(["update", "demo"], work, home);
      expect(res.code).toBe(0);

      // Upstream addition landed; local edit preserved.
      expect(await readFile(join(work, "vendor/demo/EXTRA.md"), "utf8")).toBe("extra\n");
      expect(await readFile(join(work, "vendor/demo/SKILL.md"), "utf8")).toBe("demo v1 local edit\n");

      // Base advanced to upstream (now carries EXTRA.md) and state SHA changed.
      expect(await readFile(join(work, ".skync/base/demo/EXTRA.md"), "utf8")).toBe("extra\n");
      const after = await demoStateSha(work);
      expect(after).not.toBe(before);
      expect(after).toMatch(/^[0-9a-f]{40}$/);

      // A pre-merge snapshot exists under backups/.
      const snaps = await readdir(join(work, ".skync/backups/demo"));
      expect(snaps.length).toBe(1);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("writes conflict markers in place, exits 2, and does not advance base or state", async () => {
    const fixture = await createFixtureRepo();
    const work = await mkdtemp(join(tmpdir(), "skync-update-"));
    const home = await mkdtemp(join(tmpdir(), "skync-home-"));
    try {
      const add = await runCli(
        ["add", "demo", "--repo", fixture.url, "--src", "skills/demo", "--dest", "vendor/demo"],
        work,
        home,
      );
      expect(add.code).toBe(0);
      const before = await demoStateSha(work);

      // Both sides change the same line differently => overlapping conflict.
      await writeFile(join(work, "vendor/demo/SKILL.md"), "demo local\n");
      await commitToFixture(fixture.dir, { "skills/demo/SKILL.md": "demo upstream\n" }, "edit skill");

      const res = await runCli(["update", "demo"], work, home);
      expect(res.code).toBe(2);
      // Names the conflicted skill, the specific file, and points to the exits.
      expect(res.stdout).toMatch(/conflict/i);
      expect(res.stdout).toContain("SKILL.md");
      expect(res.stdout).toMatch(/resolve/i);
      expect(res.stdout).toMatch(/rollback/i);

      // dest now carries git-style markers with both sides.
      const dest = await readFile(join(work, "vendor/demo/SKILL.md"), "utf8");
      expect(dest).toContain("<<<<<<<");
      expect(dest).toContain("=======");
      expect(dest).toContain(">>>>>>>");
      expect(dest).toContain("demo local");
      expect(dest).toContain("demo upstream");

      // Base and state SHA are NOT advanced while the conflict is unresolved.
      expect(await readFile(join(work, ".skync/base/demo/SKILL.md"), "utf8")).toBe("demo v1\n");
      expect(await demoStateSha(work)).toBe(before);

      // A pre-merge snapshot exists so the user can roll back.
      const snaps = await readdir(join(work, ".skync/backups/demo"));
      expect(snaps.length).toBe(1);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("records pendingSha in state.json when a conflict is written, without advancing sha", async () => {
    const fixture = await createFixtureRepo();
    const work = await mkdtemp(join(tmpdir(), "skync-update-"));
    const home = await mkdtemp(join(tmpdir(), "skync-home-"));
    try {
      const add = await runCli(
        ["add", "demo", "--repo", fixture.url, "--src", "skills/demo", "--dest", "vendor/demo"],
        work,
        home,
      );
      expect(add.code).toBe(0);
      const baseSha = await demoStateSha(work);

      await writeFile(join(work, "vendor/demo/SKILL.md"), "demo local\n");
      await commitToFixture(fixture.dir, { "skills/demo/SKILL.md": "demo upstream\n" }, "edit skill");
      const res = await runCli(["update", "demo"], work, home);
      expect(res.code).toBe(2);

      // sha unchanged (base did not advance), pendingSha records the upstream
      // commit whose tree produced the in-place markers.
      const state = JSON.parse(await readFile(join(work, ".skync/state.json"), "utf8"));
      expect(state.skills.demo.sha).toBe(baseSha);
      expect(state.skills.demo.pendingSha).toMatch(/^[0-9a-f]{40}$/);
      expect(state.skills.demo.pendingSha).not.toBe(baseSha);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses to update a skill that still has unresolved markers, pointing to resolve/rollback", async () => {
    const fixture = await createFixtureRepo();
    const work = await mkdtemp(join(tmpdir(), "skync-update-"));
    const home = await mkdtemp(join(tmpdir(), "skync-home-"));
    try {
      const add = await runCli(
        ["add", "demo", "--repo", fixture.url, "--src", "skills/demo", "--dest", "vendor/demo"],
        work,
        home,
      );
      expect(add.code).toBe(0);

      // First conflicting update leaves markers in dest.
      await writeFile(join(work, "vendor/demo/SKILL.md"), "demo local\n");
      await commitToFixture(fixture.dir, { "skills/demo/SKILL.md": "demo upstream\n" }, "edit skill");
      const first = await runCli(["update", "demo"], work, home);
      expect(first.code).toBe(2);
      const conflicted = await readFile(join(work, "vendor/demo/SKILL.md"), "utf8");

      // Upstream moves again; a second update must refuse while markers remain.
      await commitToFixture(fixture.dir, { "skills/demo/SKILL.md": "demo upstream v3\n" }, "edit again");
      const res = await runCli(["update", "demo"], work, home);
      expect(res.code).toBe(1);
      expect(res.stderr).toMatch(/unresolved conflict/i);
      expect(res.stderr).toMatch(/SKILL.md/);
      expect(res.stderr).toMatch(/resolve/i);
      expect(res.stderr).toMatch(/rollback/i);
      expect(res.stderr).not.toMatch(/at .*\(.*:\d+:\d+\)/);

      // dest is left exactly as it was; the refused update touched nothing.
      expect(await readFile(join(work, "vendor/demo/SKILL.md"), "utf8")).toBe(conflicted);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses a second update when pendingSha is set even after markers are scrubbed", async () => {
    // B2 regression: pendingSha, not the presence of marker triples, is the
    // canonical "this skill is mid-conflict" flag. A user who strips markers by
    // hand without running resolve must still be refused.
    const fixture = await createFixtureRepo();
    const work = await mkdtemp(join(tmpdir(), "skync-update-"));
    const home = await mkdtemp(join(tmpdir(), "skync-home-"));
    try {
      const add = await runCli(
        ["add", "demo", "--repo", fixture.url, "--src", "skills/demo", "--dest", "vendor/demo"],
        work,
        home,
      );
      expect(add.code).toBe(0);

      await writeFile(join(work, "vendor/demo/SKILL.md"), "demo local\n");
      await commitToFixture(fixture.dir, { "skills/demo/SKILL.md": "demo upstream\n" }, "edit skill");
      expect((await runCli(["update", "demo"], work, home)).code).toBe(2);

      // Hand-strip every marker without running resolve.
      await writeFile(join(work, "vendor/demo/SKILL.md"), "scrubbed by hand\n");

      const res = await runCli(["update", "demo"], work, home);
      expect(res.code).toBe(1);
      expect(res.stderr).toMatch(/unresolved conflict/i);
      // The detail names the pending upstream prefix, not a marker path.
      expect(res.stderr).toMatch(/pending upstream [0-9a-f]{12}/);
      expect(res.stderr).toMatch(/resolve/i);
      expect(res.stderr).toMatch(/rollback/i);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});

/**
 * Shared setup for resolve tests: add the demo skill, produce an overlapping
 * conflict via an update, and return the work/home/fixture handles plus the
 * SHA recorded as pending. Caller owns cleanup.
 */
async function setupConflict(): Promise<{
  fixture: { dir: string; url: string };
  work: string;
  home: string;
  baseSha: string;
  pendingSha: string;
}> {
  const fixture = await createFixtureRepo();
  const work = await mkdtemp(join(tmpdir(), "skync-resolve-"));
  const home = await mkdtemp(join(tmpdir(), "skync-home-"));
  const add = await runCli(
    ["add", "demo", "--repo", fixture.url, "--src", "skills/demo", "--dest", "vendor/demo"],
    work,
    home,
  );
  if (add.code !== 0) throw new Error(`setup add failed: ${add.stderr}`);
  const baseSha = await demoStateSha(work);

  await writeFile(join(work, "vendor/demo/SKILL.md"), "demo local\n");
  await commitToFixture(fixture.dir, { "skills/demo/SKILL.md": "demo upstream\n" }, "edit skill");
  const upd = await runCli(["update", "demo"], work, home);
  if (upd.code !== 2) throw new Error(`setup update expected exit 2, got ${upd.code}: ${upd.stderr}`);

  const state = JSON.parse(await readFile(join(work, ".skync/state.json"), "utf8"));
  return { fixture, work, home, baseSha, pendingSha: state.skills.demo.pendingSha as string };
}

describe("skync resolve (CLI)", () => {
  it("errors when conflict markers remain in dest", async () => {
    const { fixture, work, home } = await setupConflict();
    try {
      const res = await runCli(["resolve", "demo"], work, home);
      expect(res.code).toBe(1);
      expect(res.stderr).toMatch(/still has conflict markers/i);
      expect(res.stderr).toContain("SKILL.md");
      expect(res.stderr).not.toMatch(/at .*\(.*:\d+:\d+\)/);

      // dest is untouched; state still records the pending SHA.
      const state = JSON.parse(await readFile(join(work, ".skync/state.json"), "utf8"));
      expect(state.skills.demo.pendingSha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("snapshots, advances base, and updates state.json when markers are gone", async () => {
    const { fixture, work, home, baseSha, pendingSha } = await setupConflict();
    try {
      // One snapshot from the conflicting update; resolve should add a second.
      const snapsBefore = await readdir(join(work, ".skync/backups/demo"));
      expect(snapsBefore.length).toBe(1);

      // User edits the markers out. Content is the user's choice; resolve only
      // verifies no markers remain, then accepts dest as-is.
      await writeFile(join(work, "vendor/demo/SKILL.md"), "merged content\n");

      const res = await runCli(["resolve", "demo"], work, home);
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/resolved/i);
      expect(res.stdout).toContain(pendingSha.slice(0, 12));

      // Base advanced to the pending upstream tree.
      expect(await readFile(join(work, ".skync/base/demo/SKILL.md"), "utf8")).toBe(
        "demo upstream\n",
      );

      // state.sha moved to pendingSha; pendingSha cleared.
      const state = JSON.parse(await readFile(join(work, ".skync/state.json"), "utf8"));
      expect(state.skills.demo.sha).toBe(pendingSha);
      expect(state.skills.demo.sha).not.toBe(baseSha);
      expect(state.skills.demo.pendingSha).toBeUndefined();

      // Resolution snapshot was taken.
      const snapsAfter = await readdir(join(work, ".skync/backups/demo"));
      expect(snapsAfter.length).toBe(2);

      // dest preserves the user's resolution.
      expect(await readFile(join(work, "vendor/demo/SKILL.md"), "utf8")).toBe("merged content\n");
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("makes a subsequent update against unchanged upstream report up-to-date", async () => {
    const { fixture, work, home } = await setupConflict();
    try {
      await writeFile(join(work, "vendor/demo/SKILL.md"), "merged content\n");
      expect((await runCli(["resolve", "demo"], work, home)).code).toBe(0);

      const upd = await runCli(["update", "demo"], work, home);
      expect(upd.code).toBe(0);
      expect(upd.stdout).toMatch(/up to date/i);
      // No re-introduced markers in dest.
      const dest = await readFile(join(work, "vendor/demo/SKILL.md"), "utf8");
      expect(dest).not.toContain("<<<<<<<");
      expect(dest).toBe("merged content\n");
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("is an idempotent no-op on a skill with no pending conflict", async () => {
    const fixture = await createFixtureRepo();
    const work = await mkdtemp(join(tmpdir(), "skync-resolve-"));
    const home = await mkdtemp(join(tmpdir(), "skync-home-"));
    try {
      const add = await runCli(
        ["add", "demo", "--repo", fixture.url, "--src", "skills/demo", "--dest", "vendor/demo"],
        work,
        home,
      );
      expect(add.code).toBe(0);

      const first = await runCli(["resolve", "demo"], work, home);
      expect(first.code).toBe(0);
      expect(first.stdout).toMatch(/no pending conflict/i);

      // State is untouched.
      const stateBefore = await readFile(join(work, ".skync/state.json"), "utf8");

      // Second call also a no-op (and leaves state byte-for-byte identical).
      const second = await runCli(["resolve", "demo"], work, home);
      expect(second.code).toBe(0);
      expect(second.stdout).toMatch(/no pending conflict/i);
      expect(await readFile(join(work, ".skync/state.json"), "utf8")).toBe(stateBefore);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("errors with a clean message when dest was deleted before resolve", async () => {
    const { fixture, work, home } = await setupConflict();
    try {
      // User edited the markers out, then accidentally rm'd the whole dest.
      await rm(join(work, "vendor/demo"), { recursive: true, force: true });

      const res = await runCli(["resolve", "demo"], work, home);
      expect(res.code).toBe(1);
      expect(res.stderr).toMatch(/does not exist/i);
      expect(res.stderr).toMatch(/backups/i);
      expect(res.stderr).not.toMatch(/ENOENT/);
      expect(res.stderr).not.toMatch(/at .*\(.*:\d+:\d+\)/);

      // State still records the pending conflict; nothing was clobbered.
      const state = JSON.parse(await readFile(join(work, ".skync/state.json"), "utf8"));
      expect(state.skills.demo.pendingSha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses on live markers even when pendingSha was scrubbed from state", async () => {
    const { fixture, work, home } = await setupConflict();
    try {
      // Simulate a corrupted state.json: pendingSha hand-scrubbed while the
      // text markers remain in dest. Resolve must not pretend everything is fine.
      const statePath = join(work, ".skync/state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      delete state.skills.demo.pendingSha;
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

      const res = await runCli(["resolve", "demo"], work, home);
      expect(res.code).toBe(1);
      expect(res.stderr).toMatch(/still has conflict markers/i);
      expect(res.stderr).toContain("SKILL.md");
      // Must NOT print the misleading idempotent no-op message.
      expect(res.stdout).not.toMatch(/no pending conflict/i);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("errors with a clean message on an unknown skill name", async () => {
    const work = await mkdtemp(join(tmpdir(), "skync-resolve-"));
    const home = await mkdtemp(join(tmpdir(), "skync-home-"));
    try {
      const res = await runCli(["resolve", "ghost"], work, home);
      expect(res.code).toBe(1);
      expect(res.stderr).toMatch(/'ghost' is not in any manifest/i);
      expect(res.stderr).toMatch(/rollback/i);
      expect(res.stderr).not.toMatch(/at .*\(.*:\d+:\d+\)/);
    } finally {
      await rm(work, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
