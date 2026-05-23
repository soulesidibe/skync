import { readFile } from "node:fs/promises";
import { writeFileAtomic, copyDirAtomic } from "./atomic.js";
import { isNotFound, isPlainObject } from "./util.js";

/** Current on-disk state schema version, for forward migration. */
export const STATE_VERSION = 1;

/**
 * Per-skill sync state: which remote/src/dest the skill maps to, the concrete
 * upstream commit SHA last synced (the future merge-base pointer), and when.
 *
 * `remote`/`src`/`dest` deliberately mirror the manifest so state is
 * self-contained: a later sync can trust state.json even if the manifest entry
 * was hand-edited or removed. `sha`/`syncedAt` live only here.
 *
 * `pendingSha` is set when `update` produced a conflict: it records the
 * upstream SHA whose tree the in-place markers came from, so `resolve` can
 * advance base to exactly that SHA (not whatever the ref currently points at,
 * which may have moved). Its presence is the canonical "this skill is
 * mid-conflict" flag and outlives the markers themselves, because non-text
 * conflicts (binary, delete-modify, type-change) leave no marker in dest.
 */
export interface SkillState {
  remote: string;
  src: string;
  dest: string;
  sha: string;
  syncedAt: string;
  pendingSha?: string;
}

/** The whole state file: a version plus per-skill records keyed by skill name. */
export interface SkyncState {
  version: number;
  skills: Record<string, SkillState>;
}

/**
 * Thrown when state.json is present but structurally invalid. The message is
 * intended to be shown directly to the user.
 */
export class StateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateValidationError";
  }
}

/** A fresh, empty state at the current version. */
export function emptyState(): SkyncState {
  return { version: STATE_VERSION, skills: {} };
}

function validateState(raw: unknown): SkyncState {
  if (!isPlainObject(raw)) {
    throw new StateValidationError("state.json root must be an object");
  }
  if (typeof raw.version !== "number") {
    throw new StateValidationError("state.json is missing a numeric 'version'");
  }
  const skills: Record<string, SkillState> = {};
  const rawSkills = raw.skills;
  if (rawSkills !== undefined && rawSkills !== null) {
    if (!isPlainObject(rawSkills)) {
      throw new StateValidationError("state.json 'skills' must be an object");
    }
    for (const [name, value] of Object.entries(rawSkills)) {
      if (!isPlainObject(value)) {
        throw new StateValidationError(`state for skill '${name}' must be an object`);
      }
      const required: Array<"remote" | "src" | "dest" | "sha" | "syncedAt"> = [
        "remote",
        "src",
        "dest",
        "sha",
        "syncedAt",
      ];
      for (const field of required) {
        if (typeof value[field] !== "string" || (value[field] as string).length === 0) {
          throw new StateValidationError(
            `state for skill '${name}' is missing a '${field}' string`,
          );
        }
      }
      const record: SkillState = {
        remote: value.remote as string,
        src: value.src as string,
        dest: value.dest as string,
        sha: value.sha as string,
        syncedAt: value.syncedAt as string,
      };
      // Optional pendingSha: present only when a prior update left a conflict.
      // Enforce the 40-char hex shape so a corrupted or hand-edited state.json
      // cannot smuggle a leading-dash value (e.g. `--upload-pack=...`) into the
      // positional argv of `git cat-file` / `git archive` and have git parse it
      // as a flag. Sub-string injection via shell is already blocked by
      // execFile (no shell), but git's own argv parsing treats `-`-prefixed
      // tokens as options.
      if (value.pendingSha !== undefined) {
        if (typeof value.pendingSha !== "string" || !/^[0-9a-f]{40}$/.test(value.pendingSha)) {
          throw new StateValidationError(
            `state for skill '${name}' has an invalid 'pendingSha' (must be a 40-char hex SHA)`,
          );
        }
        record.pendingSha = value.pendingSha;
      }
      skills[name] = record;
    }
  }
  return { version: raw.version, skills };
}

/**
 * Read the state file at `path`. Returns an empty state when the file does not
 * exist; throws StateValidationError on malformed content.
 */
export async function readState(path: string): Promise<SkyncState> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) {
      return emptyState();
    }
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new StateValidationError(`could not parse state.json: ${detail}`);
  }
  return validateState(raw);
}

/**
 * Write the state file atomically. This is the commit point of an operation and
 * should be the last write.
 */
export async function writeState(path: string, state: SkyncState): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Populate a skill's `base` tree from a source directory. Copies into a temp
 * dir alongside the target (same filesystem) then renames into place, removing
 * any stale base first. Base population is not the commit point; write state
 * last so a crash never leaves state pointing at an incomplete base.
 */
export async function populateBase(baseSkillDir: string, srcDir: string): Promise<void> {
  await copyDirAtomic(baseSkillDir, srcDir);
}

/**
 * Snapshot a skill's live `dest` tree into a backup directory before a merge,
 * so any update is reversible. A filesystem copy (not a parsed tree) preserves
 * file modes and symlinks; the copy is staged in a temp sibling then renamed in.
 */
export async function snapshotLocal(snapshotDir: string, destDir: string): Promise<void> {
  await copyDirAtomic(snapshotDir, destDir);
}

/**
 * Restore a skill's `dest` tree from a previously taken snapshot, replacing the
 * current contents atomically.
 */
export async function restoreSnapshot(destDir: string, snapshotDir: string): Promise<void> {
  await copyDirAtomic(destDir, snapshotDir);
}

/**
 * Stamp a skill's record with the upstream SHA whose merge produced an
 * unresolved conflict. The skill must already be tracked: a conflict can only
 * arise where base exists, which means a prior successful sync wrote state.
 * Mutates the input state in place and returns it for chaining.
 */
export function markPending(state: SkyncState, name: string, pendingSha: string): SkyncState {
  const skill = state.skills[name];
  if (skill === undefined) {
    throw new StateValidationError(
      `cannot mark pending for unknown skill '${name}' (no prior sync recorded)`,
    );
  }
  skill.pendingSha = pendingSha;
  return state;
}

/**
 * Commit a resolution: advance the skill's base pointer to the pending upstream
 * SHA, update syncedAt, and clear `pendingSha`. The skill must already be
 * tracked. Mutates the input state in place and returns it for chaining.
 */
export function commitResolution(
  state: SkyncState,
  name: string,
  sha: string,
  syncedAt: string,
): SkyncState {
  const skill = state.skills[name];
  if (skill === undefined) {
    throw new StateValidationError(
      `cannot commit resolution for unknown skill '${name}' (no prior sync recorded)`,
    );
  }
  skill.sha = sha;
  skill.syncedAt = syncedAt;
  delete skill.pendingSha;
  return state;
}
