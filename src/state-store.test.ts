import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readState,
  writeState,
  populateBase,
  emptyState,
  STATE_VERSION,
  StateValidationError,
  type SkyncState,
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
});
