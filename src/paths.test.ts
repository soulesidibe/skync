import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  projectStateDir,
  globalStateDir,
  cacheDir,
  baseSkillDir,
  statePath,
} from "./paths.js";

describe("state path helpers", () => {
  it("derives the project state dir from cwd", () => {
    expect(projectStateDir("/work")).toBe(join("/work", ".skync"));
  });

  it("nests the global state dir under the config dir", () => {
    expect(globalStateDir("/home/u")).toBe(
      join("/home/u", ".config", "skync", ".skync"),
    );
  });

  it("derives cache, base, and state paths from a state dir", () => {
    const stateDir = "/work/.skync";
    expect(cacheDir(stateDir)).toBe(join(stateDir, "cache"));
    expect(baseSkillDir(stateDir, "demo")).toBe(join(stateDir, "base", "demo"));
    expect(statePath(stateDir)).toBe(join(stateDir, "state.json"));
  });
});
