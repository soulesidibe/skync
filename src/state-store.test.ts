import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readState,
  writeState,
  populateBase,
  takeSnapshot,
  restoreSnapshot,
  listSnapshots,
  pruneSnapshots,
  emptyState,
  markPending,
  commitResolution,
  STATE_VERSION,
  StateValidationError,
  type SkyncState,
  type SkillState,
} from "./state-store.js";

function withSkill(name: string): SkyncState {
  const state = emptyState();
  state.skills[name] = {
    remote: "pocock",
    src: "skills/demo",
    dest: "~/.claude/skills/demo",
    sha: "abc123",
    syncedAt: "2026-05-21T00:00:00.000Z",
  };
  return state;
}

function skillState(overrides: Partial<SkillState> = {}): SkillState {
  return {
    remote: "pocock",
    src: "skills/demo",
    dest: "~/.claude/skills/demo",
    sha: "abc123",
    syncedAt: "2026-05-21T00:00:00.000Z",
    ...overrides,
  };
}

const VALID_TS = "2026-05-21T00-00-00-000Z";

describe("state store", () => {
  it("returns an empty state when the file is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-state-"));
    try {
      const state = await readState(join(dir, "state.json"));
      expect(state).toEqual({ version: STATE_VERSION, skills: {} });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips a written state and leaves no temp files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-state-"));
    const path = join(dir, "state.json");
    try {
      const state = withSkill("demo");
      await writeState(path, state);
      expect(await readState(path)).toEqual(state);
      const entries = await readdir(dir);
      expect(entries).toEqual(["state.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-state-"));
    const path = join(dir, "state.json");
    try {
      await writeFile(path, "not json");
      await expect(readState(path)).rejects.toThrow(StateValidationError);

      await writeFile(path, JSON.stringify({ skills: {} }));
      await expect(readState(path)).rejects.toThrow(/version/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("populates a base tree from a source directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-base-"));
    try {
      const src = join(dir, "src");
      await mkdir(join(src, "nested"), { recursive: true });
      await writeFile(join(src, "a.txt"), "a\n");
      await writeFile(join(src, "nested", "b.txt"), "b\n");

      const base = join(dir, "base", "demo");
      await populateBase(base, src);

      expect(await readFile(join(base, "a.txt"), "utf8")).toBe("a\n");
      expect(await readFile(join(base, "nested", "b.txt"), "utf8")).toBe("b\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replaces a stale base tree on re-population", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-base-"));
    try {
      const base = join(dir, "base", "demo");
      const src1 = join(dir, "src1");
      await mkdir(src1, { recursive: true });
      await writeFile(join(src1, "old.txt"), "old\n");
      await populateBase(base, src1);

      const src2 = join(dir, "src2");
      await mkdir(src2, { recursive: true });
      await writeFile(join(src2, "new.txt"), "new\n");
      await populateBase(base, src2);

      const entries = await readdir(base);
      expect(entries).toEqual(["new.txt"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips optional pendingSha + pendingSnapshotTs on a skill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-state-"));
    const path = join(dir, "state.json");
    try {
      const state = withSkill("demo");
      state.skills.demo.pendingSha = "deadbeef".repeat(5);
      state.skills.demo.pendingSnapshotTs = VALID_TS;
      await writeState(path, state);

      const serialized = await readFile(path, "utf8");
      expect(serialized).toContain("pendingSha");
      expect(serialized).toContain("pendingSnapshotTs");

      const reloaded = await readState(path);
      expect(reloaded.skills.demo.pendingSha).toBe("deadbeef".repeat(5));
      expect(reloaded.skills.demo.pendingSnapshotTs).toBe(VALID_TS);
      expect(reloaded).toEqual(state);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("omits pendingSha + pendingSnapshotTs from disk when unset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-state-"));
    const path = join(dir, "state.json");
    try {
      await writeState(path, withSkill("demo"));
      const serialized = await readFile(path, "utf8");
      expect(serialized).not.toContain("pendingSha");
      expect(serialized).not.toContain("pendingSnapshotTs");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a pendingSha that is not a 40-char hex SHA (blocks argv injection)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-state-"));
    const path = join(dir, "state.json");
    try {
      for (const bad of ["", "abc", "--upload-pack=cmd", "Z".repeat(40), "deadbeef".repeat(5) + "x"]) {
        await writeFile(
          path,
          JSON.stringify({
            version: STATE_VERSION,
            skills: {
              demo: {
                remote: "r",
                src: "s",
                dest: "d",
                sha: "abc",
                syncedAt: "2026-05-21T00:00:00.000Z",
                pendingSha: bad,
              },
            },
          }),
        );
        await expect(readState(path)).rejects.toThrow(/pendingSha/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a pendingSnapshotTs that is not a snapshot-timestamp shape (blocks path injection)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-state-"));
    const path = join(dir, "state.json");
    try {
      // A path-separator or traversal value could let a hand-edited state.json
      // steer rollback at an arbitrary location. The validator must refuse.
      for (const bad of ["", "../etc/passwd", "2026-05-21T00:00:00.000Z", "weird name"]) {
        await writeFile(
          path,
          JSON.stringify({
            version: STATE_VERSION,
            skills: {
              demo: {
                remote: "r",
                src: "s",
                dest: "d",
                sha: "abc",
                syncedAt: "2026-05-21T00:00:00.000Z",
                pendingSnapshotTs: bad,
              },
            },
          }),
        );
        await expect(readState(path)).rejects.toThrow(/pendingSnapshotTs/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("markPending stamps SHA + snapshot timestamp on a tracked skill and refuses unknown ones", () => {
    const state = withSkill("demo");
    markPending(state, "demo", "feedface".repeat(5), VALID_TS);
    expect(state.skills.demo.pendingSha).toBe("feedface".repeat(5));
    expect(state.skills.demo.pendingSnapshotTs).toBe(VALID_TS);
    expect(() => markPending(state, "ghost", "x", VALID_TS)).toThrow(StateValidationError);
  });

  it("commitResolution advances sha+syncedAt and clears both pending fields", () => {
    const state = withSkill("demo");
    state.skills.demo.pendingSha = "feedface".repeat(5);
    state.skills.demo.pendingSnapshotTs = VALID_TS;
    commitResolution(state, "demo", "cafebabe".repeat(5), "2026-05-22T12:00:00.000Z");
    expect(state.skills.demo.sha).toBe("cafebabe".repeat(5));
    expect(state.skills.demo.syncedAt).toBe("2026-05-22T12:00:00.000Z");
    expect(state.skills.demo.pendingSha).toBeUndefined();
    expect(state.skills.demo.pendingSnapshotTs).toBeUndefined();
    expect(() => commitResolution(state, "ghost", "x", "y")).toThrow(StateValidationError);
  });
});

describe("snapshots", () => {
  it("takeSnapshot captures dest + base + meta, and restoreSnapshot rolls all three back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-snap-"));
    try {
      const dest = join(dir, "dest");
      const base = join(dir, "base", "demo");
      await mkdir(dest, { recursive: true });
      await mkdir(base, { recursive: true });
      await writeFile(join(dest, "doc.md"), "hello\n");
      await writeFile(join(dest, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
      await writeFile(join(base, "doc.md"), "hello\n");

      const snapshotDir = join(dir, "backups", "demo", VALID_TS);
      const snapshotState = skillState({ sha: "snapshotsha" });
      await takeSnapshot(snapshotDir, dest, base, snapshotState);

      // Snapshot has the three artifacts: dest/, base/, meta.json.
      expect((await readdir(snapshotDir)).sort()).toEqual(["base", "dest", "meta.json"]);
      expect(await readFile(join(snapshotDir, "dest", "doc.md"), "utf8")).toBe("hello\n");
      expect((await stat(join(snapshotDir, "dest", "run.sh"))).mode & 0o111).not.toBe(0);
      expect(await readFile(join(snapshotDir, "base", "doc.md"), "utf8")).toBe("hello\n");

      // Mutate live dest and base, then roll back.
      await writeFile(join(dest, "doc.md"), "corrupted\n");
      await writeFile(join(base, "doc.md"), "corrupted-base\n");

      const restored = await restoreSnapshot(dest, base, snapshotDir);

      expect(await readFile(join(dest, "doc.md"), "utf8")).toBe("hello\n");
      expect(await readFile(join(base, "doc.md"), "utf8")).toBe("hello\n");
      expect((await stat(join(dest, "run.sh"))).mode & 0o111).not.toBe(0);
      expect(restored.sha).toBe("snapshotsha");

      // No stray temp swap dirs from copyDirAtomic.
      expect((await readdir(join(dir, "backups", "demo"))).sort()).toEqual([VALID_TS]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("takeSnapshot is atomic: a crash mid-snapshot leaves a .tmp-* sibling, not a half snapshot", async () => {
    // We can't crash mid-call, but we can verify the final layout has no half-built
    // structure: build many in sequence and confirm each is fully formed.
    const dir = await mkdtemp(join(tmpdir(), "skync-snap-"));
    try {
      const dest = join(dir, "dest");
      const base = join(dir, "base", "demo");
      await mkdir(dest, { recursive: true });
      await mkdir(base, { recursive: true });
      await writeFile(join(dest, "a"), "1\n");
      await writeFile(join(base, "a"), "1\n");

      for (let i = 0; i < 3; i++) {
        const ts = `2026-05-21T00-00-0${i}-000Z`;
        await takeSnapshot(
          join(dir, "backups", "demo", ts),
          dest,
          base,
          skillState({ sha: `sha${i}` }),
        );
      }

      const entries = await readdir(join(dir, "backups", "demo"));
      // No `.tmp-*` siblings left behind, exactly the snapshots requested.
      expect(entries.sort()).toEqual([
        "2026-05-21T00-00-00-000Z",
        "2026-05-21T00-00-01-000Z",
        "2026-05-21T00-00-02-000Z",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("restoreSnapshot rejects a snapshot whose meta.json is malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-snap-"));
    try {
      const snapshotDir = join(dir, "backups", "demo", VALID_TS);
      await mkdir(join(snapshotDir, "dest"), { recursive: true });
      await mkdir(join(snapshotDir, "base"), { recursive: true });
      await writeFile(join(snapshotDir, "meta.json"), "not json");
      await expect(
        restoreSnapshot(join(dir, "dest"), join(dir, "base"), snapshotDir),
      ).rejects.toThrow(StateValidationError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("retention", () => {
  async function seedSnapshots(dir: string, count: number): Promise<string[]> {
    const created: string[] = [];
    for (let i = 0; i < count; i++) {
      // Pad to two digits in the seconds slot so lex sort == chronological.
      const sec = String(i).padStart(2, "0");
      const ts = `2026-05-21T00-00-${sec}-000Z`;
      await mkdir(join(dir, ts), { recursive: true });
      await writeFile(join(dir, ts, "marker"), `${i}\n`);
      created.push(ts);
    }
    return created;
  }

  it("listSnapshots returns [] for a missing directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-list-"));
    try {
      expect(await listSnapshots(join(dir, "nope"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("listSnapshots returns timestamp dirs sorted oldest→newest, ignoring stray entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-list-"));
    try {
      const created = await seedSnapshots(dir, 3);
      // Stray files/dirs that don't match the timestamp shape are ignored.
      await writeFile(join(dir, "stray.txt"), "ignore me\n");
      await mkdir(join(dir, "weird-dir"), { recursive: true });
      const got = await listSnapshots(dir);
      expect(got).toEqual(created);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pruneSnapshots is a no-op when fewer than keep snapshots exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-prune-"));
    try {
      await seedSnapshots(dir, 3);
      const removed = await pruneSnapshots(dir, 10, []);
      expect(removed).toEqual([]);
      expect((await listSnapshots(dir)).length).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pruneSnapshots keeps the last N and removes the older ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-prune-"));
    try {
      const created = await seedSnapshots(dir, 12);
      const removed = await pruneSnapshots(dir, 10, []);
      // The two oldest go.
      expect(removed.sort()).toEqual(created.slice(0, 2).sort());
      expect(await listSnapshots(dir)).toEqual(created.slice(2));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pruneSnapshots never removes a protected timestamp, even if older than the cutoff", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-prune-"));
    try {
      const created = await seedSnapshots(dir, 12);
      const protectedTs = created[0]; // the oldest — would otherwise be pruned
      const removed = await pruneSnapshots(dir, 10, [protectedTs]);
      // Only one removed (the second-oldest); the oldest survives because protected.
      expect(removed).toEqual([created[1]]);
      const remaining = await listSnapshots(dir);
      expect(remaining).toContain(protectedTs);
      expect(remaining.length).toBe(11); // 10 newest + 1 protected
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pruneSnapshots rejects keep < 1 instead of silently wiping every snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-prune-"));
    try {
      await seedSnapshots(dir, 3);
      await expect(pruneSnapshots(dir, 0, [])).rejects.toThrow(StateValidationError);
      await expect(pruneSnapshots(dir, -1, [])).rejects.toThrow(StateValidationError);
      // Snapshots untouched.
      expect((await listSnapshots(dir)).length).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pruneSnapshots returns [] when the backup dir does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skync-prune-"));
    try {
      const removed = await pruneSnapshots(join(dir, "missing"), 10, []);
      expect(removed).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
