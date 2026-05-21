import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The project manifest file name, resolved against the current working
 * directory. This is the manifest committed alongside a project.
 */
export const PROJECT_MANIFEST_FILENAME = "skync.yaml";

/**
 * Absolute path to the project manifest in the current working directory.
 */
export function projectManifestPath(cwd: string = process.cwd()): string {
  return join(cwd, PROJECT_MANIFEST_FILENAME);
}

/**
 * Absolute path to the global manifest under the user's config directory
 * (`~/.config/skync/manifest.yaml`).
 */
export function globalManifestPath(home: string = homedir()): string {
  return join(home, ".config", "skync", "manifest.yaml");
}

/**
 * State directory for project skills: `<cwd>/.skync`. Paired with the project
 * manifest (`<cwd>/skync.yaml`) and meant to be git-ignored.
 */
export function projectStateDir(cwd: string = process.cwd()): string {
  return join(cwd, ".skync");
}

/**
 * State directory for global skills: `~/.config/skync/.skync`, nested under the
 * same config dir as the global manifest.
 */
export function globalStateDir(home: string = homedir()): string {
  return join(home, ".config", "skync", ".skync");
}

/**
 * Directory holding cached git clones (one per remote repo) within a state dir.
 */
export function cacheDir(stateDir: string): string {
  return join(stateDir, "cache");
}

/**
 * Directory holding the pristine `base` tree for a skill (the last-synced
 * upstream copy) within a state dir.
 */
export function baseSkillDir(stateDir: string, skillName: string): string {
  return join(stateDir, "base", skillName);
}

/**
 * Path to the `state.json` file within a state dir.
 */
export function statePath(stateDir: string): string {
  return join(stateDir, "state.json");
}
