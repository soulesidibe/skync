import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
 *
 * `pendingSnapshotTs` is the timestamp of the snapshot taken just before the
 * conflicting merge wrote markers into dest. Persisting it alongside
 * pendingSha (rather than guessing "most recent snapshot at prune time") lets
 * retention pruning protect the exact snapshot the user would need to roll
 * back to discard the pending conflict, even if later operations add or
 * remove other snapshots.
 */
export interface SkillState {
  remote: string;
  src: string;
  dest: string;
  sha: string;
  syncedAt: string;
  pendingSha?: string;
  pendingSnapshotTs?: string;
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

/**
 * Filesystem-safe timestamp shape produced by takeSnapshot (ISO with `:`/`.`
 * rewritten). Exported so callers can validate user-supplied input (e.g.
 * `rollback --to <ts>`) before joining it into a backup path.
 */
export const SNAPSHOT_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

function validateSkillState(raw: unknown, label: string): SkillState {
  if (!isPlainObject(raw)) {
    throw new StateValidationError(`${label} must be an object`);
  }
  const required: Array<"remote" | "src" | "dest" | "sha" | "syncedAt"> = [
    "remote",
    "src",
    "dest",
    "sha",
    "syncedAt",
  ];
  for (const field of required) {
    if (typeof raw[field] !== "string" || (raw[field] as string).length === 0) {
      throw new StateValidationError(`${label} is missing a '${field}' string`);
    }
  }
  const record: SkillState = {
    remote: raw.remote as string,
    src: raw.src as string,
    dest: raw.dest as string,
    sha: raw.sha as string,
    syncedAt: raw.syncedAt as string,
  };
  // Optional pendingSha: present only when a prior update left a conflict.
  // Enforce the 40-char hex shape so a corrupted or hand-edited state.json
  // cannot smuggle a leading-dash value (e.g. `--upload-pack=...`) into the
  // positional argv of `git cat-file` / `git archive` and have git parse it
  // as a flag. Sub-string injection via shell is already blocked by
  // execFile (no shell), but git's own argv parsing treats `-`-prefixed
  // tokens as options.
  if (raw.pendingSha !== undefined) {
    if (typeof raw.pendingSha !== "string" || !/^[0-9a-f]{40}$/.test(raw.pendingSha)) {
      throw new StateValidationError(
        `${label} has an invalid 'pendingSha' (must be a 40-char hex SHA)`,
      );
    }
    record.pendingSha = raw.pendingSha;
  }
  if (raw.pendingSnapshotTs !== undefined) {
    // The timestamp must look like a snapshot dir name so a hand-edited state
    // cannot point at an arbitrary path (no path separators, no traversal).
    if (
      typeof raw.pendingSnapshotTs !== "string" ||
      !SNAPSHOT_TIMESTAMP_RE.test(raw.pendingSnapshotTs)
    ) {
      throw new StateValidationError(
        `${label} has an invalid 'pendingSnapshotTs' (must be an ISO-style snapshot timestamp)`,
      );
    }
    record.pendingSnapshotTs = raw.pendingSnapshotTs;
  }
  return record;
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
      skills[name] = validateSkillState(value, `state for skill '${name}'`);
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
 * On-disk layout of one backup snapshot. dest/ and base/ are full tree copies
 * (preserve modes and symlinks) so rollback restores both halves of the
 * three-way merge basis: the live copy at snapshot time AND the merge base it
 * was three-way-merged against. meta.json records the skill's state entry
 * frozen at snapshot time, so rollback can also restore state.sha/pendingSha
 * to that point and keep subsequent updates merging against the right base.
 *
 * Captured as one atomic unit: built in a temp sibling, then renamed in.
 */
interface SnapshotMeta {
  skill: SkillState;
}

/**
 * Capture a complete snapshot of a skill's local state for later rollback:
 * dest tree, base tree, and the SkillState record (frozen at this moment).
 * Built in a temp sibling and renamed into place so a crash mid-snapshot
 * leaves a `.tmp-*` sibling, not a half-populated snapshot dir.
 */
export async function takeSnapshot(
  snapshotDir: string,
  destDir: string,
  baseSkillDir: string,
  skill: SkillState,
): Promise<void> {
  await mkdir(dirname(snapshotDir), { recursive: true });
  const tmp = `${snapshotDir}.tmp-${process.pid}-${Date.now()}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  await cp(destDir, join(tmp, "dest"), { recursive: true, preserveTimestamps: true });
  await cp(baseSkillDir, join(tmp, "base"), { recursive: true, preserveTimestamps: true });
  const meta: SnapshotMeta = { skill };
  await writeFile(join(tmp, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  await rm(snapshotDir, { recursive: true, force: true });
  await rename(tmp, snapshotDir);
}

/**
 * Restore a snapshot: replace `destDir` and `baseSkillDir` atomically (or as
 * close to atomically as the filesystem allows) from the snapshot's `dest/`
 * and `base/` copies, and return the SkillState recorded at snapshot time.
 * The caller threads that state back into state.json so the skill's recorded
 * `sha` matches what dest and base now reflect (otherwise subsequent
 * three-way merges would use a stale base pointer).
 *
 * Atomicity strategy: stage both restored trees as temp siblings (the slow
 * step, full directory copies), then swap them into place with two close-
 * spaced renames. The window between the two renames is microseconds rather
 * than seconds, which is the best we can do without filesystem transactions.
 * A crash inside that window leaves either dest or base mismatched against
 * the other; the caller's `state.json` is still pre-rollback (commit-point-
 * last), so the user can simply re-run rollback to converge.
 */
export async function restoreSnapshot(
  destDir: string,
  baseSkillDir: string,
  snapshotDir: string,
): Promise<SkillState> {
  const metaText = await readFile(join(snapshotDir, "meta.json"), "utf8");
  let metaRaw: unknown;
  try {
    metaRaw = JSON.parse(metaText);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new StateValidationError(
      `snapshot meta.json at ${snapshotDir} is not valid JSON: ${detail}`,
    );
  }
  if (!isPlainObject(metaRaw)) {
    throw new StateValidationError(`snapshot meta.json at ${snapshotDir} must be an object`);
  }
  const skill = validateSkillState(metaRaw.skill, `snapshot meta.json at ${snapshotDir}`);

  // Stage both trees first (the slow part), so when we start swapping the
  // window where dest and base disagree is just two renames.
  await mkdir(dirname(destDir), { recursive: true });
  await mkdir(dirname(baseSkillDir), { recursive: true });
  const destTmp = `${destDir}.skync-restore-${process.pid}-${Date.now()}`;
  const baseTmp = `${baseSkillDir}.skync-restore-${process.pid}-${Date.now()}`;
  await rm(destTmp, { recursive: true, force: true });
  await rm(baseTmp, { recursive: true, force: true });
  try {
    await cp(join(snapshotDir, "dest"), destTmp, { recursive: true, preserveTimestamps: true });
    await cp(join(snapshotDir, "base"), baseTmp, { recursive: true, preserveTimestamps: true });
    // Swap base first (the invisible artifact), then dest (user-visible).
    // A crash between the two swaps leaves dest still post-update — matching
    // the still-post-update state.json the caller has not yet rewritten —
    // i.e. the user-visible state remains coherent.
    await rm(baseSkillDir, { recursive: true, force: true });
    await rename(baseTmp, baseSkillDir);
    await rm(destDir, { recursive: true, force: true });
    await rename(destTmp, destDir);
  } finally {
    await rm(destTmp, { recursive: true, force: true });
    await rm(baseTmp, { recursive: true, force: true });
  }
  return skill;
}

/**
 * List snapshot timestamps for a skill, oldest→newest. Returns [] when the
 * backup dir does not exist. Filters out anything that does not match the
 * snapshot timestamp shape, so stray files (e.g. `.tmp-*` from an interrupted
 * snapshot) or hand-created dirs are ignored.
 */
export async function listSnapshots(skillBackupDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(skillBackupDir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  // Timestamps are fixed-width zero-padded, so lexicographic sort == chronological.
  return entries.filter((e) => SNAPSHOT_TIMESTAMP_RE.test(e)).sort();
}

/**
 * Keep the `keep` most recent snapshots and remove the rest, except for any
 * timestamps listed in `protectedTimestamps` (always preserved regardless of
 * age). Returns the timestamps that were actually removed. No-op when fewer
 * than `keep + 1` snapshots exist after filtering, or when the dir is missing.
 *
 * `protectedTimestamps` exists so the CLI can preserve the exact snapshot a
 * pending conflict depends on (via `SkillState.pendingSnapshotTs`); the
 * StateStore module does not look at state itself, keeping the contract small.
 */
export async function pruneSnapshots(
  skillBackupDir: string,
  keep: number,
  protectedTimestamps: ReadonlyArray<string>,
): Promise<string[]> {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new StateValidationError(`pruneSnapshots requires keep >= 1 (got ${keep})`);
  }
  const timestamps = await listSnapshots(skillBackupDir);
  if (timestamps.length <= keep) return [];
  const protectedSet = new Set(protectedTimestamps);
  // Candidates for removal: everything except the last `keep`. Then drop the
  // protected ones, so the kept set is `last N ∪ protected` (which may be
  // larger than N if the protected entry is older than the cutoff).
  const cutoff = timestamps.length - keep;
  const toRemove = timestamps.slice(0, cutoff).filter((ts) => !protectedSet.has(ts));
  for (const ts of toRemove) {
    await rm(join(skillBackupDir, ts), { recursive: true, force: true });
  }
  return toRemove;
}

/**
 * Stamp a skill's record with the upstream SHA whose merge produced an
 * unresolved conflict, plus the snapshot timestamp the user would roll back to
 * to discard it. Set both atomically so retention can rely on
 * `pendingSnapshotTs` being present whenever `pendingSha` is. The skill must
 * already be tracked (a conflict can only arise where base exists).
 * Mutates the input state in place and returns it for chaining.
 */
export function markPending(
  state: SkyncState,
  name: string,
  pendingSha: string,
  pendingSnapshotTs: string,
): SkyncState {
  const skill = state.skills[name];
  if (skill === undefined) {
    throw new StateValidationError(
      `cannot mark pending for unknown skill '${name}' (no prior sync recorded)`,
    );
  }
  skill.pendingSha = pendingSha;
  skill.pendingSnapshotTs = pendingSnapshotTs;
  return state;
}

/**
 * Commit a resolution: advance the skill's base pointer to the pending upstream
 * SHA, update syncedAt, and clear `pendingSha` plus `pendingSnapshotTs`. The
 * skill must already be tracked. Mutates the input state in place and returns
 * it for chaining.
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
  delete skill.pendingSnapshotTs;
  return state;
}
