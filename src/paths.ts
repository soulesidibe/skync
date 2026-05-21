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
