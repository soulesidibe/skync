#!/usr/bin/env node
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { readdir, stat, mkdtemp, rm } from "node:fs/promises";
import { Command } from "commander";
import pc from "picocolors";
import {
  loadManifestFile,
  mergeManifests,
  expandDest,
  manifestBaseDir,
  emptyManifest,
  findOrCreateRemote,
  upsertSkill,
  saveManifestFile,
  ManifestValidationError,
  type Manifest,
  type SkillEntry,
} from "./manifest.js";
import { isNotFound } from "./util.js";
import {
  projectManifestPath,
  globalManifestPath,
  projectStateDir,
  globalStateDir,
  cacheDir,
  baseSkillDir,
  backupsDir,
  backupSnapshotDir,
  statePath,
} from "./paths.js";
import { ensureRemoteClone, resolveRef, materializeSrc } from "./remote-cache.js";
import {
  discoverSkill,
  DiscoveryNoMatchError,
  DiscoveryMultipleMatchError,
} from "./discover.js";
import {
  readState,
  writeState,
  populateBase,
  takeSnapshot,
  restoreSnapshot,
  listSnapshots,
  pruneSnapshots,
  markPending,
  commitResolution,
  SNAPSHOT_TIMESTAMP_RE,
  type SkillState,
} from "./state-store.js";
import { git } from "./git.js";
import {
  swapDirAtomic,
  recoverPendingSwap,
  stagingPathFor,
  OLD_DIR_SUFFIX,
} from "./atomic.js";
import { readTree, writeTree } from "./tree-io.js";
import { mergeTrees, type Conflict, type Tree } from "./treemerge.js";
import { treeConflictMarkerPaths } from "./conflict-markers.js";
import { compareTrees, formatFileDiff, type TreeDiff } from "./diff-report.js";

/**
 * Thrown when a skill's live copy still carries unresolved conflict markers, so
 * an update would stack a merge on top of an unmerged file. The user must run
 * `skync resolve` or `skync rollback` first. Exits 1 like other operational
 * errors (distinct from the exit-2 "completed with conflicts" outcome).
 */
class UnresolvedConflictError extends Error {}

/**
 * Operational error raised inside `runCheck` (manifest invalid, fetch failed,
 * missing state entry, pending swap sidecar, etc.). A named subclass, not a
 * duck-typed `.exitCode` property, so the global handler can map it to exit 3
 * without affecting other commands that might re-throw an inner error.
 */
class CheckOperationalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckOperationalError";
  }
}

/** Outcome of updating one skill, aggregated by runUpdate for reporting. */
interface UpdateOutcome {
  name: string;
  status: "up-to-date" | "clean" | "conflict";
  conflicts: Conflict[];
}

/**
 * A skill plus the directory of the manifest that declared it, so we can
 * expand project-relative dest paths against the correct base.
 */
interface ResolvedSkill {
  skill: SkillEntry;
  baseDir: string;
}

/**
 * Resolve skills across the project and global manifests with project
 * precedence, tracking each skill's source base directory for dest expansion.
 */
function resolveSkillsWithBase(
  project: Manifest | null,
  projectBaseDir: string,
  global: Manifest | null,
  globalBaseDir: string,
): ResolvedSkill[] {
  const merged = mergeManifests(project ?? emptyManifest(), global ?? emptyManifest());

  const projectNames = new Set((project?.skills ?? []).map((s) => s.name));

  return merged.skills.map((skill) => ({
    skill,
    baseDir: projectNames.has(skill.name) ? projectBaseDir : globalBaseDir,
  }));
}

async function runList(): Promise<void> {
  const home = homedir();
  const projectPath = projectManifestPath();
  const globalPath = globalManifestPath();

  const [project, global] = await Promise.all([
    loadManifestFile(projectPath),
    loadManifestFile(globalPath),
  ]);

  const resolved = resolveSkillsWithBase(
    project,
    manifestBaseDir(projectPath),
    global,
    manifestBaseDir(globalPath),
  );

  if (resolved.length === 0) {
    process.stdout.write(
      "No tracked skills. Add one with 'skync add <name> --repo <url> --src <path> --dest <path>'.\n",
    );
    return;
  }

  for (const { skill, baseDir } of resolved) {
    const dest = expandDest(skill.dest, { home, baseDir });
    process.stdout.write(`${pc.bold(skill.name)}\n`);
    process.stdout.write(`  remote: ${skill.remote}\n`);
    process.stdout.write(`  ${skill.src} ${pc.dim("→")} ${dest}\n`);
  }
}

interface AddOptions {
  repo: string;
  src: string;
  dest: string;
  remote?: string;
  ref?: string;
  global?: boolean;
}

/**
 * Whether a path is "occupied": a non-empty directory, or any non-directory
 * file. A missing path (or empty directory) is not occupied and is safe to
 * vendor into fresh.
 */
async function destOccupied(path: string): Promise<boolean> {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    if (isNotFound(err)) {
      return false;
    }
    throw err;
  }
  if (info.isDirectory()) {
    return (await readdir(path)).length > 0;
  }
  return true;
}

/**
 * `skync add`: register a skill and initialize it. Two paths, decided by whether
 * dest already holds content:
 *   - dest absent or empty: vendor fresh. The src subtree is written into dest
 *     and mirrored into the base tree (base == local == upstream).
 *   - dest non-empty: adopt it as the local copy untouched, and seed the base
 *     tree from the current upstream so the first later update is a true
 *     three-way merge. Upstream changes that predate this add are baked into
 *     base and will not re-apply on that first update (documented limitation).
 * Both paths resolve the ref to a concrete SHA, update the manifest, and record
 * the synced SHA in state.json (written last as the commit point).
 */
async function runAdd(name: string, options: AddOptions): Promise<void> {
  const home = homedir();
  const isGlobal = options.global === true;
  const manifestPath = isGlobal ? globalManifestPath(home) : projectManifestPath();
  const stateDir = isGlobal ? globalStateDir(home) : projectStateDir();
  const baseDir = manifestBaseDir(manifestPath);

  // A relative dest for a global skill would resolve under the config dir,
  // which is surprising. Require an explicit home-anchored or absolute path.
  if (
    isGlobal &&
    !(options.dest === "~" || options.dest.startsWith("~/") || isAbsolute(options.dest))
  ) {
    throw new ManifestValidationError(
      `a global skill's --dest must be absolute or start with '~/' (got '${options.dest}')`,
    );
  }

  const loaded = (await loadManifestFile(manifestPath)) ?? emptyManifest();
  if (loaded.skills.some((s) => s.name === name)) {
    throw new ManifestValidationError(
      `a skill named '${name}' already exists in ${manifestPath}`,
    );
  }

  const dest = expandDest(options.dest, { home, baseDir });
  const adopt = await destOccupied(dest);

  const { remotes, name: remoteName, ref: remoteRef } = findOrCreateRemote(loaded.remotes, {
    repo: options.repo,
    remote: options.remote,
    ref: options.ref,
  });

  // Ref precedence for this skill's resolution: explicit --ref, else the
  // (possibly reused) remote's ref, else the remote's default branch.
  const ref = options.ref ?? remoteRef ?? "HEAD";

  const repoPath = await ensureRemoteClone(cacheDir(stateDir), options.repo);
  const sha = await resolveRef(repoPath, ref);
  const baseDest = baseSkillDir(stateDir, name);
  if (adopt) {
    // Leave dest untouched (it is the adopted local copy). Materialize current
    // upstream into a temp dir, then mirror it into base. The temp name is kept
    // distinct from populateBase's own ".tmp-" temp so the two never collide.
    const tmpUpstream = `${baseDest}.adopt-${process.pid}-${Date.now()}`;
    try {
      await materializeSrc(repoPath, sha, options.src, tmpUpstream);
      await populateBase(baseDest, tmpUpstream);
    } finally {
      await rm(tmpUpstream, { recursive: true, force: true });
    }
  } else {
    await materializeSrc(repoPath, sha, options.src, dest);
    await populateBase(baseDest, dest);
  }

  const updated = upsertSkill(
    { remotes, skills: loaded.skills },
    { name, remote: remoteName, src: options.src, dest: options.dest },
  );
  await saveManifestFile(manifestPath, updated);

  // state.json is the commit point: write it last.
  const state = await readState(statePath(stateDir));
  state.skills[name] = {
    remote: remoteName,
    src: options.src,
    dest: options.dest,
    sha,
    syncedAt: new Date().toISOString(),
  };
  await writeState(statePath(stateDir), state);

  if (adopt) {
    process.stdout.write(
      `Adopted ${pc.bold(name)} from ${remoteName} at ${sha.slice(0, 12)}\n`,
    );
    process.stdout.write(`  kept existing ${dest} as the local copy\n`);
    process.stdout.write(
      pc.dim(
        "  base seeded from current upstream; changes made upstream before now are baked into base\n",
      ),
    );
  } else {
    process.stdout.write(
      `Added ${pc.bold(name)} from ${remoteName} at ${sha.slice(0, 12)}\n`,
    );
    process.stdout.write(`  ${options.src} ${pc.dim("→")} ${dest}\n`);
  }
}

interface DiscoverOptions {
  repo: string;
  ref?: string;
}

/**
 * Resolve a remote ref through the cached clone. Symmetric with `runAdd`: when
 * `--ref` is given, resolve it directly; otherwise resolve the remote's
 * symbolic HEAD via `ls-remote --symref`, falling back to a plain `HEAD` rev-
 * parse for repos whose remote does not expose the symref (rare, but possible).
 */
async function resolveDiscoverSha(
  repoPath: string,
  repoUrl: string,
  ref: string | undefined,
): Promise<string> {
  if (ref !== undefined) {
    return resolveRef(repoPath, ref);
  }
  try {
    const { stdout } = await git(["ls-remote", "--symref", repoUrl, "HEAD"]);
    const match = stdout.match(/^ref:\s+(\S+)\s+HEAD/m);
    if (match) {
      const headRef = match[1].replace(/^refs\/heads\//, "");
      return resolveRef(repoPath, headRef);
    }
  } catch {
    // Fall through to the plain HEAD attempt below.
  }
  return resolveRef(repoPath, "HEAD");
}

/**
 * Read-only debug command: clone (or refresh) the upstream into the shared
 * cache, resolve the ref, and report the single skill folder whose basename
 * and SKILL.md frontmatter both equal `name`. Writes nothing to manifest or
 * state. Exits 0 on a single match (path on stdout, nothing else); exits 1 on
 * zero matches or multiple matches (candidate list on stderr, exit handled by
 * the global catch which sets process.exitCode based on the thrown error).
 */
async function runDiscover(name: string, options: DiscoverOptions): Promise<void> {
  const stateDir = projectStateDir();
  const repoPath = await ensureRemoteClone(cacheDir(stateDir), options.repo);
  const sha = await resolveDiscoverSha(repoPath, options.repo, options.ref);

  try {
    const path = await discoverSkill(repoPath, sha, name);
    process.stdout.write(`${path}\n`);
  } catch (err) {
    if (err instanceof DiscoveryNoMatchError) {
      process.stderr.write(
        `${pc.red("error")}: no skill named '${name}' found in ${options.repo} at ${sha.slice(0, 7)}\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (err instanceof DiscoveryMultipleMatchError) {
      process.stderr.write(
        `${pc.red("error")}: multiple skill folders match '${name}' in ${options.repo} at ${sha.slice(0, 7)}:\n`,
      );
      for (const candidate of err.candidates) {
        process.stderr.write(`  ${candidate}\n`);
      }
      process.stderr.write(
        `re-run with skync add --src <path> to pick one\n`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

interface UpdateOptions {
  ref?: string;
  global?: boolean;
  keep: number;
}

/** Default number of backup snapshots retained per skill. */
export const DEFAULT_KEEP = 10;

/**
 * Parse a `--keep <n>` argument. Must be a positive integer; anything else is
 * a user error caught up front rather than producing an opaque later failure
 * (pruneSnapshots itself also refuses, but a Commander-time error is friendlier).
 */
function parseKeep(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || String(n) !== raw.trim()) {
    throw new ManifestValidationError(`--keep must be a positive integer (got '${raw}')`);
  }
  return n;
}

/** Filesystem-safe timestamp matching the SNAPSHOT_TIMESTAMP_RE in state-store. */
function nowSnapshotTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Prune older snapshots for one skill after a successful state mutation,
 * preserving the snapshot a pending conflict depends on (if any). Best-effort:
 * a prune failure must not turn a successful update or resolve into an error,
 * so a warning is printed and the exit code stays at the operation's outcome.
 */
async function pruneAfterMutation(
  stateDir: string,
  skillName: string,
  current: SkillState | undefined,
  keep: number,
): Promise<void> {
  const dir = backupsDir(stateDir, skillName);
  const protectedTimestamps = current?.pendingSnapshotTs !== undefined ? [current.pendingSnapshotTs] : [];
  try {
    await pruneSnapshots(dir, keep, protectedTimestamps);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `${pc.yellow("warning")}: could not prune backups for ${skillName}: ${detail}\n`,
    );
  }
}

interface UpdateTarget {
  skill: SkillEntry;
  baseDir: string;
  stateDir: string;
}

/**
 * Resolve which skills `update` operates on and the remote table to look repos
 * up in. Each target carries the state dir of the manifest that declared it, so
 * project and global skills read and write their own base trees and state.
 */
function resolveUpdateTargets(
  project: Manifest | null,
  projectBaseDir: string,
  projStateDir: string,
  global: Manifest | null,
  globalBaseDir: string,
  globStateDir: string,
  onlyGlobal: boolean,
): { targets: UpdateTarget[]; remotes: Manifest["remotes"] } {
  if (onlyGlobal) {
    const g = global ?? emptyManifest();
    return {
      remotes: g.remotes,
      targets: g.skills.map((skill) => ({ skill, baseDir: globalBaseDir, stateDir: globStateDir })),
    };
  }

  const merged = mergeManifests(project ?? emptyManifest(), global ?? emptyManifest());
  const projectNames = new Set((project?.skills ?? []).map((s) => s.name));
  return {
    remotes: merged.remotes,
    targets: merged.skills.map((skill) => ({
      skill,
      baseDir: projectNames.has(skill.name) ? projectBaseDir : globalBaseDir,
      stateDir: projectNames.has(skill.name) ? projStateDir : globStateDir,
    })),
  };
}

/**
 * Three-way merge a single skill's upstream changes into its live dest. Always
 * snapshots the live copy first, stages the merged tree, and swaps it into place
 * atomically. On a clean merge, base advances to upstream and state.json records
 * the new SHA. On a conflicting merge, the dest receives in-place conflict
 * markers (and kept-local binary/delete sides) but base and state are left
 * untouched, so the next clean `resolve` advances them. Refuses up front if the
 * live copy still carries unresolved markers from a prior conflict.
 */
async function updateSkill(
  target: UpdateTarget,
  remotes: Manifest["remotes"],
  home: string,
  refOverride: string | undefined,
  keep: number,
): Promise<UpdateOutcome> {
  const { skill, baseDir, stateDir } = target;
  const remote = remotes[skill.remote];
  if (remote === undefined) {
    throw new ManifestValidationError(
      `skill '${skill.name}' references unknown remote '${skill.remote}'`,
    );
  }

  const dest = expandDest(skill.dest, { home, baseDir });
  // Finish any swap interrupted by an earlier crash before reading dest.
  await recoverPendingSwap(dest);

  // Refuse before any fetch if a prior update left an unresolved conflict.
  // Two signals: pendingSha in state.json is the canonical flag (it outlives
  // text markers and covers binary/delete-modify/type-change conflicts that
  // leave nothing detectable in dest), and any actual marker triples in dest.
  // Either is grounds to refuse; updating would stack a merge on an unmerged
  // skill and silently lose the pending upstream SHA.
  const state = await readState(statePath(stateDir));
  const prev = state.skills[skill.name];

  const live = await readTree(dest);
  const marked = treeConflictMarkerPaths(live);
  if (prev?.pendingSha !== undefined || marked.length > 0) {
    const detail =
      marked.length > 0
        ? `markers in: ${marked.join(", ")}`
        : `pending upstream ${prev?.pendingSha?.slice(0, 12) ?? ""}`;
    throw new UnresolvedConflictError(
      `skill '${skill.name}' has an unresolved conflict (${detail}). ` +
        `Run 'skync resolve ${skill.name}' once you have edited any markers out, ` +
        `or 'skync rollback ${skill.name}' to discard it.`,
    );
  }

  const repoPath = await ensureRemoteClone(cacheDir(stateDir), remote.repo);
  const ref = refOverride ?? remote.ref ?? "HEAD";
  const sha = await resolveRef(repoPath, ref);

  if (prev !== undefined && prev.sha === sha) {
    process.stdout.write(`${pc.bold(skill.name)} is up to date.\n`);
    // No snapshot or state change to prune around, but a prior update may have
    // left older snapshots. Still apply retention so a long-running deployment
    // does not accumulate unbounded backups.
    await pruneAfterMutation(stateDir, skill.name, prev, keep);
    return { name: skill.name, status: "up-to-date", conflicts: [] };
  }

  // Materialize upstream into a scratch dir we only read from.
  const upstreamDir = await mkdtemp(join(tmpdir(), "skync-upstream-"));
  try {
    await materializeSrc(repoPath, sha, skill.src, upstreamDir);

    const baseDir = baseSkillDir(stateDir, skill.name);
    const [base, upstream] = await Promise.all([readTree(baseDir), readTree(upstreamDir)]);

    const result = mergeTrees(base, upstream, live);

    // Snapshot the live copy + base + the SkillState as it stands now, before
    // mutating anything. The snapshot is the rollback target for this update,
    // whether the merge ends clean or in conflict. If `prev` is undefined (no
    // state entry yet), there is nothing meaningful to snapshot; this is the
    // very first sync for a manifest-but-no-state skill and a later `add`
    // would re-initialize anyway.
    let timestamp: string | undefined;
    if (prev !== undefined) {
      timestamp = nowSnapshotTimestamp();
      await takeSnapshot(backupSnapshotDir(stateDir, skill.name, timestamp), dest, baseDir, prev);
    }

    // Stage the merged tree in dest's parent, then swap it into place atomically.
    const staging = stagingPathFor(dest);
    await rm(staging, { recursive: true, force: true });
    await writeTree(staging, result.merged);
    await swapDirAtomic(dest, staging);

    if (!result.clean) {
      // Conflicts are now in dest. Leave base untouched so the merge base does
      // not advance, but stamp pendingSha+pendingSnapshotTs in state so
      // `resolve` knows which upstream commit the markers came from (the ref
      // may move before then) and retention can preserve the snapshot the
      // pending conflict depends on. state.json is the commit point: write last.
      // A conflict implies `prev` existed (snapshot was taken), so the
      // timestamp is defined.
      if (timestamp === undefined) {
        throw new Error(
          `internal error: conflict outcome for '${skill.name}' without a snapshot timestamp`,
        );
      }
      markPending(state, skill.name, sha, timestamp);
      await writeState(statePath(stateDir), state);
      // Do NOT prune on the conflict path: the just-taken snapshot is the
      // user's recovery point, and `pendingSnapshotTs` protects it but there
      // is no reason to risk pruning other backups during a failed merge.
      process.stdout.write(`${pc.bold(skill.name)} has conflicts; markers written to dest.\n`);
      return { name: skill.name, status: "conflict", conflicts: result.conflicts };
    }

    // Base advances to the upstream tree (the new merge base) on a clean merge.
    await populateBase(baseDir, upstreamDir);

    // state.json is the commit point: write it last.
    state.skills[skill.name] = {
      remote: skill.remote,
      src: skill.src,
      dest: skill.dest,
      sha,
      syncedAt: new Date().toISOString(),
    };
    await writeState(statePath(stateDir), state);

    // Retention: after a successful clean merge, prune older snapshots. The
    // freshly-written state has no pendingSnapshotTs (we just resolved or
    // never had a conflict), so the protected set is empty.
    await pruneAfterMutation(stateDir, skill.name, state.skills[skill.name], keep);

    process.stdout.write(`Updated ${pc.bold(skill.name)} to ${sha.slice(0, 12)}\n`);
    return { name: skill.name, status: "clean", conflicts: [] };
  } finally {
    await rm(upstreamDir, { recursive: true, force: true });
  }
}

/**
 * Report each conflicted skill: its name, the files carrying in-place markers
 * (text overlaps and add-add), and any conflicts that cannot carry markers
 * (binary byte conflicts, delete-vs-modify, file/dir collisions) where the local
 * side was kept. Closes with the resolve/rollback next steps.
 */
function reportConflicts(outcomes: UpdateOutcome[]): void {
  const conflicted = outcomes.filter((o) => o.status === "conflict");
  if (conflicted.length === 0) {
    return;
  }

  process.stdout.write(`\n${pc.bold("Conflicts need resolving:")}\n`);
  for (const outcome of conflicted) {
    process.stdout.write(`  ${pc.bold(outcome.name)}\n`);
    for (const c of outcome.conflicts) {
      switch (c.kind) {
        case "content":
        case "add-add":
          process.stdout.write(`    conflict markers in ${c.path}\n`);
          break;
        case "binary":
          process.stdout.write(`    binary conflict in ${c.path} (kept your local copy)\n`);
          break;
        case "delete-modify":
          process.stdout.write(`    delete/modify conflict in ${c.path} (kept the modified version)\n`);
          break;
        case "type-change":
          process.stdout.write(`    path collision in ${c.path} (left unmerged)\n`);
          break;
      }
    }
  }
  process.stdout.write(
    pc.dim(
      "\nEdit the markers out then run 'skync resolve <name>', " +
        "or 'skync rollback <name>' to discard the update.\n",
    ),
  );
}

/**
 * `skync update [name]`: pull upstream changes for one skill (or all tracked
 * skills) via a three-way merge. Non-overlapping changes apply silently; an
 * overlap writes git-style markers in place and the skill is reported as
 * conflicted (exit 2) without advancing its base. A skill that still carries
 * unresolved markers is refused (exit 1, via the thrown error).
 */
async function runUpdate(name: string | undefined, options: UpdateOptions): Promise<void> {
  const home = homedir();
  const projectPath = projectManifestPath();
  const globalPath = globalManifestPath(home);

  const [project, global] = await Promise.all([
    loadManifestFile(projectPath),
    loadManifestFile(globalPath),
  ]);

  const { targets, remotes } = resolveUpdateTargets(
    project,
    manifestBaseDir(projectPath),
    projectStateDir(),
    global,
    manifestBaseDir(globalPath),
    globalStateDir(home),
    options.global === true,
  );

  let selected = targets;
  if (name !== undefined) {
    selected = targets.filter((t) => t.skill.name === name);
    if (selected.length === 0) {
      throw new ManifestValidationError(`no tracked skill named '${name}'`);
    }
  }

  if (selected.length === 0) {
    process.stdout.write("No tracked skills to update.\n");
    return;
  }

  const outcomes: UpdateOutcome[] = [];
  for (const target of selected) {
    outcomes.push(await updateSkill(target, remotes, home, options.ref, options.keep));
  }

  reportConflicts(outcomes);

  // Completed, but conflicts await resolution: signal with exit 2, distinct
  // from operational errors (exit 1, set by the top-level catch).
  if (outcomes.some((o) => o.status === "conflict")) {
    process.exitCode = 2;
  }
}

/**
 * `skync resolve <name>`: mark a conflicted skill as resolved. Verifies dest no
 * longer carries conflict markers, snapshots the resolved local copy, then
 * re-materializes the pending upstream tree into base and advances state's
 * `sha` to the pending upstream SHA. Idempotent: a skill with no pending
 * conflict exits 0 with a no-op message. Note: non-text conflict kinds
 * (binary, delete-modify, type-change) leave no marker in dest by design, so
 * the marker check passes for them and resolving accepts whatever currently
 * lives in dest (the "kept local" side) as the user's chosen resolution.
 */
interface ResolveOptions {
  keep: number;
}

async function runResolve(name: string, options: ResolveOptions): Promise<void> {
  const home = homedir();
  const projectPath = projectManifestPath();
  const globalPath = globalManifestPath(home);

  const [project, global] = await Promise.all([
    loadManifestFile(projectPath),
    loadManifestFile(globalPath),
  ]);

  const { targets, remotes } = resolveUpdateTargets(
    project,
    manifestBaseDir(projectPath),
    projectStateDir(),
    global,
    manifestBaseDir(globalPath),
    globalStateDir(home),
    false,
  );

  const target = targets.find((t) => t.skill.name === name);
  if (target === undefined) {
    throw new ManifestValidationError(
      `skill '${name}' is not in any manifest. ` +
        `Restore the manifest entry, or run 'skync rollback ${name}' to discard a pending conflict.`,
    );
  }
  const { skill, baseDir, stateDir } = target;

  const state = await readState(statePath(stateDir));
  const prev = state.skills[skill.name];
  if (prev === undefined) {
    throw new ManifestValidationError(
      `skill '${skill.name}' has no recorded state; nothing to resolve.`,
    );
  }
  const dest = expandDest(skill.dest, { home, baseDir });
  // Finish any swap interrupted by an earlier crash before reading dest.
  await recoverPendingSwap(dest);

  // Refuse on stray markers BEFORE the pendingSha no-op branch: a corrupted
  // state (pendingSha scrubbed by hand while markers remain in dest) must not
  // get a reassuring 'nothing to resolve' message that masks live conflicts.
  const live = await readTree(dest);
  const marked = treeConflictMarkerPaths(live);
  if (marked.length > 0) {
    throw new UnresolvedConflictError(
      `skill '${skill.name}' still has conflict markers in: ${marked.join(", ")}. ` +
        `Edit them out and re-run 'skync resolve ${skill.name}'.`,
    );
  }

  if (prev.pendingSha === undefined) {
    process.stdout.write(
      `${pc.bold(skill.name)} has no pending conflict; nothing to resolve.\n`,
    );
    return;
  }
  const pendingSha = prev.pendingSha;

  // dest must exist: snapshotLocal copies from it, and a missing dest would
  // bubble up an opaque ENOENT from copyDirAtomic. (readTree on a missing
  // directory returns an empty Map, so we cannot rely on the marker scan to
  // catch this. Check explicitly.)
  try {
    await stat(dest);
  } catch (err) {
    if (isNotFound(err)) {
      throw new UnresolvedConflictError(
        `dest '${dest}' for skill '${skill.name}' does not exist; ` +
          `restore it (e.g. from a backup under .skync/backups/${skill.name}/) ` +
          `before re-running 'skync resolve ${skill.name}'.`,
      );
    }
    throw err;
  }

  const remote = remotes[skill.remote];
  if (remote === undefined) {
    throw new ManifestValidationError(
      `skill '${skill.name}' references unknown remote '${skill.remote}'`,
    );
  }

  const repoPath = await ensureRemoteClone(cacheDir(stateDir), remote.repo);

  // Pre-flight: confirm the pending commit still exists in the local cache.
  // If it was force-pushed away and garbage-collected upstream, materializeSrc
  // would fail mid-flight with an opaque git error; surface a clean one.
  try {
    await git(["cat-file", "-e", `${pendingSha}^{commit}`], { cwd: repoPath });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new UnresolvedConflictError(
      `the upstream commit recorded as pending (${pendingSha.slice(0, 12)}) ` +
        `is no longer present in ${remote.repo} (possibly force-pushed). ` +
        `Run 'skync rollback ${skill.name}' to discard the pending conflict, ` +
        `then 'skync update ${skill.name}' against current upstream. ` +
        `Underlying: ${detail}`,
    );
  }

  // Materialize the pending upstream tree into a scratch dir for populateBase.
  const upstreamDir = await mkdtemp(join(tmpdir(), "skync-upstream-"));
  try {
    await materializeSrc(repoPath, pendingSha, skill.src, upstreamDir);

    // Snapshot the resolved local copy + current base + the pre-resolve
    // SkillState (with pendingSha still set), so a later rollback to this
    // snapshot can restore the user back into the resolved-but-not-yet-
    // committed state and try again.
    const baseDir = baseSkillDir(stateDir, skill.name);
    const timestamp = nowSnapshotTimestamp();
    await takeSnapshot(backupSnapshotDir(stateDir, skill.name, timestamp), dest, baseDir, prev);

    // Advance base to the pending upstream tree (atomic via copyDirAtomic).
    await populateBase(baseDir, upstreamDir);

    // state.json is the commit point: write last, clearing pendingSha. The
    // operation is idempotent on crash recovery because pendingSha stays set
    // until this write commits.
    commitResolution(state, skill.name, pendingSha, new Date().toISOString());
    await writeState(statePath(stateDir), state);

    // Retention: prune the resolved skill's older snapshots. pendingSha and
    // pendingSnapshotTs were just cleared, so nothing is protected; the
    // newest (just-taken) snapshot is always within the kept window.
    await pruneAfterMutation(stateDir, skill.name, state.skills[skill.name], options.keep);

    process.stdout.write(
      `Resolved ${pc.bold(skill.name)} at ${pendingSha.slice(0, 12)}; base advanced.\n`,
    );
  } finally {
    await rm(upstreamDir, { recursive: true, force: true });
  }
}

interface CheckOptions {
  global?: boolean;
}

/** Per-skill classification produced by the dry-run check. */
type CheckStatus =
  | "up-to-date"
  | "clean-update"
  | "would-conflict"
  | "pending-conflict";

interface CheckOutcome {
  name: string;
  status: CheckStatus;
  sha?: string;
  conflictPaths?: string[];
}

/**
 * Detect leftover artifacts from an interrupted atomic swap next to `dest`.
 * `<dest>.skync-old` is the deterministic sidecar `swapDirAtomic` writes; any
 * `${basename}.skync-staging-*` sibling is a stale staging tree from a process
 * that exited before it could swap. Either signals that an `update` must run
 * first to recover; `check` refuses to read in that state.
 */
async function pendingSwapArtifact(dest: string): Promise<string | null> {
  const parent = dirname(dest);
  const name = basename(dest);
  const old = join(parent, `${name}${OLD_DIR_SUFFIX}`);
  try {
    await stat(old);
    return old;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  let entries;
  try {
    entries = await readdir(parent);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const stagingPrefix = `${name}.skync-staging-`;
  const stale = entries.find((entry) => entry.startsWith(stagingPrefix));
  return stale === undefined ? null : join(parent, stale);
}

/**
 * Classify one skill via an in-memory dry-run merge, without writing anything
 * to user-visible state. Order is deliberate: marker check before fetch, so a
 * pending-conflict skill short-circuits before touching the network or disk.
 */
async function checkSkill(
  target: UpdateTarget,
  remotes: Manifest["remotes"],
  home: string,
): Promise<CheckOutcome> {
  const { skill, baseDir, stateDir } = target;
  const remote = remotes[skill.remote];
  if (remote === undefined) {
    throw new CheckOperationalError(
      `skill '${skill.name}' references unknown remote '${skill.remote}'`,
    );
  }

  const dest = expandDest(skill.dest, { home, baseDir });

  // Pending atomic-swap sidecar or staging dir means the last update did not
  // complete. `check` must not call recoverPendingSwap (that writes); refuse
  // with an operational error so the operator runs `skync update` to recover.
  const stale = await pendingSwapArtifact(dest);
  if (stale !== null) {
    throw new CheckOperationalError(
      `skill '${skill.name}' has a pending atomic-swap artifact at ${stale}. ` +
        `Run 'skync update' to recover, or remove it manually if you know it is safe.`,
    );
  }

  // Live tree first so pre-existing conflict markers short-circuit before any
  // network work. Pending-conflict and would-conflict share exit 2 but are
  // distinct lines in the per-skill report.
  const live = await readTree(dest);
  const marked = treeConflictMarkerPaths(live);
  if (marked.length > 0) {
    return {
      name: skill.name,
      status: "pending-conflict",
      conflictPaths: marked,
    };
  }

  const state = await readState(statePath(stateDir));
  const prev = state.skills[skill.name];
  if (prev === undefined) {
    throw new CheckOperationalError(
      `skill '${skill.name}' is in the manifest but has no state entry. Run 'skync add' to initialize it.`,
    );
  }

  const repoPath = await ensureRemoteClone(cacheDir(stateDir), remote.repo);
  const ref = remote.ref ?? "HEAD";
  const sha = await resolveRef(repoPath, ref);

  if (sha === prev.sha) {
    return { name: skill.name, status: "up-to-date", sha };
  }

  const upstreamDir = await mkdtemp(join(tmpdir(), "skync-check-"));
  try {
    await materializeSrc(repoPath, sha, skill.src, upstreamDir);
    const [base, upstream] = await Promise.all([
      readTree(baseSkillDir(stateDir, skill.name)),
      readTree(upstreamDir),
    ]);
    const result = mergeTrees(base, upstream, live);
    if (result.clean) {
      return { name: skill.name, status: "clean-update", sha };
    }
    return {
      name: skill.name,
      status: "would-conflict",
      sha,
      conflictPaths: result.conflicts.map((c) => c.path).sort(),
    };
  } finally {
    await rm(upstreamDir, { recursive: true, force: true });
  }
}

/**
 * Format one outcome as a stable, greppable line. Glyphs and colors are
 * decoration; the `[status]` token is the contract a scheduler script reads.
 */
function formatCheckLine(o: CheckOutcome): string {
  const shortSha = o.sha === undefined ? "" : ` ${o.sha.slice(0, 12)}`;
  switch (o.status) {
    case "up-to-date":
      return `${pc.green("✓")} ${pc.bold(o.name)} [up-to-date]${shortSha}`;
    case "clean-update":
      return `${pc.cyan("↑")} ${pc.bold(o.name)} [clean-update]${shortSha}`;
    case "would-conflict": {
      const paths = (o.conflictPaths ?? []).join(", ");
      return `${pc.yellow("!")} ${pc.bold(o.name)} [would-conflict]${shortSha} on ${paths}`;
    }
    case "pending-conflict": {
      const paths = (o.conflictPaths ?? []).join(", ");
      return `${pc.red("!!")} ${pc.bold(o.name)} [pending-conflict] on ${paths} (run 'skync resolve' or 'skync rollback' first)`;
    }
  }
}

/**
 * `skync check [name]`: read-only dry-run merge per skill, with distinct
 * exit codes so a scheduler can branch on the outcome. Writes nothing to
 * dest, base, state, or manifests; only `git fetch` into the remote cache and
 * a mkdtemp scratch dir for upstream materialization (cleaned in finally).
 *
 * Exit codes:
 *   0 all skills up to date
 *   1 at least one clean update available, no conflicts anywhere
 *   2 at least one would-conflict or pending-conflict
 *   3 operational error (manifest invalid, fetch failed, missing state entry,
 *     pending swap sidecar, unknown name filter, or any unanticipated throw)
 *
 * All throws inside the body are wrapped in CheckOperationalError so the global
 * catch maps them to exit 3, never exit 1 or exit 2.
 */
async function runCheck(name: string | undefined, options: CheckOptions): Promise<void> {
  try {
    const home = homedir();
    const projectPath = projectManifestPath();
    const globalPath = globalManifestPath(home);

    const [project, global] = await Promise.all([
      loadManifestFile(projectPath),
      loadManifestFile(globalPath),
    ]);

    const { targets, remotes } = resolveUpdateTargets(
      project,
      manifestBaseDir(projectPath),
      projectStateDir(),
      global,
      manifestBaseDir(globalPath),
      globalStateDir(home),
      options.global === true,
    );

    let selected = targets;
    if (name !== undefined) {
      selected = targets.filter((t) => t.skill.name === name);
      if (selected.length === 0) {
        throw new CheckOperationalError(`no tracked skill named '${name}'`);
      }
    }

    if (selected.length === 0) {
      process.stdout.write("No tracked skills to check.\n");
      return;
    }

    const outcomes: CheckOutcome[] = [];
    for (const target of selected) {
      outcomes.push(await checkSkill(target, remotes, home));
    }

    for (const outcome of outcomes) {
      process.stdout.write(`${formatCheckLine(outcome)}\n`);
    }

    const counts = {
      upToDate: outcomes.filter((o) => o.status === "up-to-date").length,
      cleanUpdate: outcomes.filter((o) => o.status === "clean-update").length,
      wouldConflict: outcomes.filter((o) => o.status === "would-conflict").length,
      pending: outcomes.filter((o) => o.status === "pending-conflict").length,
    };
    const conflictGroup = counts.wouldConflict + counts.pending;
    const exitCode = conflictGroup > 0 ? 2 : counts.cleanUpdate > 0 ? 1 : 0;

    // Worst-first summary so a human reading cron mail sees the failure mode
    // before the green skills.
    const parts: string[] = [];
    if (counts.wouldConflict > 0) parts.push(`${counts.wouldConflict} would-conflict`);
    if (counts.pending > 0) parts.push(`${counts.pending} pending-conflict`);
    if (counts.cleanUpdate > 0) parts.push(`${counts.cleanUpdate} clean-update`);
    if (counts.upToDate > 0) parts.push(`${counts.upToDate} up-to-date`);
    process.stdout.write(`\nexit ${exitCode}: ${parts.join(", ")}\n`);

    process.exitCode = exitCode;
  } catch (err) {
    if (err instanceof CheckOperationalError) throw err;
    // Wrap any other throw (ManifestValidationError, RemoteCacheError,
    // GitError, fs errors, programming errors) so the global handler still
    // returns exit 3 for `check`, never exit 1 or exit 2.
    const message = err instanceof Error ? err.message : String(err);
    throw new CheckOperationalError(message);
  }
}


interface RollbackOptions {
  to?: string;
}

/** Resolve the manifest + state dir holding the named skill, or throw if unknown. */
async function findSkillTarget(name: string): Promise<UpdateTarget> {
  const home = homedir();
  const projectPath = projectManifestPath();
  const globalPath = globalManifestPath(home);
  const [project, global] = await Promise.all([
    loadManifestFile(projectPath),
    loadManifestFile(globalPath),
  ]);
  const { targets } = resolveUpdateTargets(
    project,
    manifestBaseDir(projectPath),
    projectStateDir(),
    global,
    manifestBaseDir(globalPath),
    globalStateDir(home),
    false,
  );
  const target = targets.find((t) => t.skill.name === name);
  if (target === undefined) {
    throw new ManifestValidationError(`no tracked skill named '${name}'`);
  }
  return target;
}

/** Per-skill classification produced by the read-only status sweep. */
type StatusStatus =
  | "clean"
  | "modified"
  | "pending-conflict"
  | "dest-missing"
  | "interrupted-swap"
  | "no-state";

interface StatusOutcome {
  name: string;
  status: StatusStatus;
  diff?: TreeDiff;
  markerPaths?: string[];
  pendingSha?: string;
  artifact?: string;
}

/**
 * Classify one skill against its base for the read-only status sweep. Order
 * matches `check` for consistency: pending-swap artifact (stop early), then
 * dest-missing, then no-state, then read trees and diff. Pending-conflict is
 * the union of `state.pendingSha` set and any in-place conflict markers.
 */
async function statusSkill(target: UpdateTarget, home: string): Promise<StatusOutcome> {
  const { skill, baseDir, stateDir } = target;
  const dest = expandDest(skill.dest, { home, baseDir });

  const stale = await pendingSwapArtifact(dest);
  if (stale !== null) {
    return { name: skill.name, status: "interrupted-swap", artifact: stale };
  }

  // dest existence: a missing dest can't be diffed against base meaningfully.
  let destMissing = false;
  try {
    await stat(dest);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    destMissing = true;
  }
  if (destMissing) {
    return { name: skill.name, status: "dest-missing" };
  }

  const state = await readState(statePath(stateDir));
  const prev = state.skills[skill.name];
  if (prev === undefined) {
    return { name: skill.name, status: "no-state" };
  }

  const [base, local] = await Promise.all([
    readTree(baseSkillDir(stateDir, skill.name)),
    readTree(dest),
  ]);
  const diff = compareTrees(base, local);
  const markerPaths = treeConflictMarkerPaths(local);
  if (prev.pendingSha !== undefined || markerPaths.length > 0) {
    return {
      name: skill.name,
      status: "pending-conflict",
      diff,
      markerPaths,
      pendingSha: prev.pendingSha,
    };
  }

  const dirty =
    diff.added.length + diff.modified.length + diff.deleted.length + diff.typeChanged.length;
  if (dirty === 0) {
    return { name: skill.name, status: "clean", diff };
  }
  return { name: skill.name, status: "modified", diff };
}

/**
 * Format one status outcome as a stable, greppable line. Glyph + bold name +
 * `[status]` token + counts, matching the `formatCheckLine` voice. Counts
 * appear as `+added ~modified -deleted` (typeChanged folded into modified for
 * the headline; the per-file list below names every changed path).
 */
function formatStatusLine(o: StatusOutcome): string {
  const name = pc.bold(o.name);
  switch (o.status) {
    case "clean":
      return `${pc.green("✓")} ${name} [clean]`;
    case "modified": {
      const d = o.diff as TreeDiff;
      const m = d.modified.length + d.typeChanged.length;
      return `${pc.yellow("~")} ${name} [modified] +${d.added.length} ~${m} -${d.deleted.length}`;
    }
    case "pending-conflict": {
      const d = o.diff as TreeDiff;
      const m = d.modified.length + d.typeChanged.length;
      const detail =
        (o.markerPaths ?? []).length > 0
          ? ` markers in: ${(o.markerPaths ?? []).join(", ")}`
          : o.pendingSha !== undefined
            ? ` pending upstream ${o.pendingSha.slice(0, 12)}`
            : "";
      return `${pc.red("!")} ${name} [pending-conflict] +${d.added.length} ~${m} -${d.deleted.length}${detail}`;
    }
    case "dest-missing":
      return `${pc.red("!")} ${name} [dest-missing]`;
    case "interrupted-swap":
      return `${pc.red("!")} ${name} [interrupted-swap] at ${o.artifact} (run 'skync update' to recover)`;
    case "no-state":
      return `${pc.dim("∅")} ${pc.bold(o.name)} [no-state]`;
  }
}

/**
 * Emit indented per-file change lines below the headline, so the human reader
 * sees both the at-a-glance counts and the specific paths touched. Sorted by
 * compareTrees already.
 */
function formatStatusDetail(d: TreeDiff): string {
  const out: string[] = [];
  for (const p of d.added) out.push(`    ${pc.green("+")} ${p}`);
  for (const p of d.modified) out.push(`    ${pc.yellow("~")} ${p}`);
  for (const p of d.typeChanged) out.push(`    ${pc.yellow("T")} ${p}`);
  for (const p of d.deleted) out.push(`    ${pc.red("-")} ${p}`);
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

interface StatusOptions {
  global?: boolean;
}

/**
 * `skync status [name]`: per-skill report of local-vs-base modifications plus
 * pending-conflict flagging. Read-only: no fetch, no writes to dest, base,
 * state, or manifests. Always exits 0; operational errors (unknown name,
 * malformed manifest) exit 1 via the global handler.
 */
async function runStatus(name: string | undefined, options: StatusOptions): Promise<void> {
  const home = homedir();
  const projectPath = projectManifestPath();
  const globalPath = globalManifestPath(home);

  const [project, global] = await Promise.all([
    loadManifestFile(projectPath),
    loadManifestFile(globalPath),
  ]);

  const { targets } = resolveUpdateTargets(
    project,
    manifestBaseDir(projectPath),
    projectStateDir(),
    global,
    manifestBaseDir(globalPath),
    globalStateDir(home),
    options.global === true,
  );

  let selected = targets;
  if (name !== undefined) {
    selected = targets.filter((t) => t.skill.name === name);
    if (selected.length === 0) {
      throw new ManifestValidationError(`no tracked skill named '${name}'`);
    }
  }

  if (selected.length === 0) {
    process.stdout.write("No tracked skills.\n");
    return;
  }

  for (const target of selected) {
    const outcome = await statusSkill(target, home);
    process.stdout.write(`${formatStatusLine(outcome)}\n`);
    if (outcome.diff !== undefined) {
      process.stdout.write(formatStatusDetail(outcome.diff));
    }
  }
}

/**
 * `skync diff <name>`: show local-vs-base and upstream-vs-base diffs for one
 * skill. Read-only with respect to dest, base, state, and manifests (the
 * remote cache may be fetched into, identical to `check`/`update` behavior).
 * Network or git failures exit 1 rather than silently omitting the upstream
 * side, because a partial diff would mislead the user into thinking upstream
 * had not moved.
 */
async function runDiff(name: string): Promise<void> {
  const home = homedir();
  const projectPath = projectManifestPath();
  const globalPath = globalManifestPath(home);

  const [project, global] = await Promise.all([
    loadManifestFile(projectPath),
    loadManifestFile(globalPath),
  ]);

  const { targets, remotes } = resolveUpdateTargets(
    project,
    manifestBaseDir(projectPath),
    projectStateDir(),
    global,
    manifestBaseDir(globalPath),
    globalStateDir(home),
    false,
  );

  const target = targets.find((t) => t.skill.name === name);
  if (target === undefined) {
    throw new ManifestValidationError(`no tracked skill named '${name}'`);
  }
  const { skill, baseDir, stateDir } = target;
  const dest = expandDest(skill.dest, { home, baseDir });

  const stale = await pendingSwapArtifact(dest);
  if (stale !== null) {
    throw new ManifestValidationError(
      `skill '${skill.name}' has a pending atomic-swap artifact at ${stale}. ` +
        `Run 'skync update' to recover before running diff.`,
    );
  }

  const remote = remotes[skill.remote];
  if (remote === undefined) {
    throw new ManifestValidationError(
      `skill '${skill.name}' references unknown remote '${skill.remote}'`,
    );
  }

  const [base, local] = await Promise.all([
    readTree(baseSkillDir(stateDir, skill.name)),
    readTree(dest),
  ]);

  // Materialize upstream into a scratch dir we only read from. mkdtemp + rm in
  // finally mirrors check/update.
  const upstreamDir = await mkdtemp(join(tmpdir(), "skync-diff-"));
  try {
    const repoPath = await ensureRemoteClone(cacheDir(stateDir), remote.repo);
    const ref = remote.ref ?? "HEAD";
    const sha = await resolveRef(repoPath, ref);
    await materializeSrc(repoPath, sha, skill.src, upstreamDir);
    const upstream = await readTree(upstreamDir);

    process.stdout.write(`${pc.bold(skill.name)}\n`);
    writeDiffSection("local vs base", base, local);
    writeDiffSection(`upstream vs base (${sha.slice(0, 12)})`, base, upstream);
  } finally {
    await rm(upstreamDir, { recursive: true, force: true });
  }
}

/**
 * Emit one labelled diff section: header plus per-file blocks for every changed
 * path. Empty section prints a single "no changes" line so the user sees both
 * sides were considered.
 */
function writeDiffSection(label: string, base: Tree, other: Tree): void {
  const d = compareTrees(base, other);
  process.stdout.write(`  ${pc.bold(label)}:\n`);
  const paths = [...d.added, ...d.modified, ...d.deleted, ...d.typeChanged].sort();
  if (paths.length === 0) {
    process.stdout.write(`    ${pc.dim("(no changes)")}\n`);
    return;
  }
  for (const path of paths) {
    const block = formatFileDiff({ path, base: base.get(path), other: other.get(path) });
    // Indent each line of the block under the section header for readability.
    const indented = block
      .split("\n")
      .map((l, i, arr) => (i === arr.length - 1 && l === "" ? l : `    ${l}`))
      .join("\n");
    process.stdout.write(indented);
  }
}

/**
 * `skync rollback <name> [--to <timestamp>]`: discard local changes back to a
 * prior snapshot.
 *
 * Without `--to`: list available snapshots newest-first. Exits 0; an empty
 * list is reported but is not an error.
 *
 * With `--to`: validates the timestamp exists in `backups/<name>/`, takes a
 * safety snapshot of the current dest+base+state first (so the rollback is
 * itself reversible by another rollback), then restores dest, base, and the
 * skill's state entry from the snapshot. The restored state is written back
 * into state.json as the commit point so subsequent three-way merges align
 * with the rolled-back base, not the post-update one.
 */
async function runRollback(name: string, options: RollbackOptions): Promise<void> {
  const target = await findSkillTarget(name);
  const { skill, baseDir: manifestBase, stateDir } = target;
  const home = homedir();
  const dest = expandDest(skill.dest, { home, baseDir: manifestBase });
  const skillBackups = backupsDir(stateDir, skill.name);
  const snapshots = await listSnapshots(skillBackups);

  if (options.to === undefined) {
    if (snapshots.length === 0) {
      process.stdout.write(`No snapshots for ${pc.bold(name)}.\n`);
      return;
    }
    process.stdout.write(`Snapshots for ${pc.bold(name)} (newest first):\n`);
    // Number from 1 so the listing matches human counting; do NOT accept the
    // index as `--to` since indices drift as snapshots prune.
    const newestFirst = [...snapshots].reverse();
    for (let i = 0; i < newestFirst.length; i++) {
      process.stdout.write(`  ${i + 1}. ${newestFirst[i]}\n`);
    }
    return;
  }

  // Validate the shape of --to before joining it into a backup path. The
  // existing includes() check below would also reject anything not on disk,
  // but checking the shape first gives a clearer error and forecloses any
  // possibility of a path-separator or traversal value slipping in through a
  // future refactor.
  if (!SNAPSHOT_TIMESTAMP_RE.test(options.to)) {
    throw new ManifestValidationError(
      `--to '${options.to}' is not a valid snapshot timestamp ` +
        `(expected an ISO-style ${new Date(0).toISOString().replace(/[:.]/g, "-")} form). ` +
        `Run 'skync rollback ${name}' without --to to list available snapshots.`,
    );
  }
  if (!snapshots.includes(options.to)) {
    const list = snapshots.length === 0 ? "<none>" : snapshots.slice().reverse().join(", ");
    throw new ManifestValidationError(
      `no snapshot '${options.to}' for skill '${name}'. Available: ${list}.`,
    );
  }

  // Read state for this skill so we can take a safety snapshot of the current
  // state before overwriting dest and base. If state has no entry, fabricate
  // one from the manifest for the safety snapshot's meta (rollback still
  // restores into a real on-disk state.json afterward).
  const state = await readState(statePath(stateDir));
  const current = state.skills[skill.name];

  // Pre-rollback snapshot: cheap insurance against a fat-fingered --to. If
  // current state is missing we skip the safety snapshot rather than block
  // the rollback; takeSnapshot needs a meta entry and there is nothing
  // meaningful to record.
  if (current !== undefined) {
    try {
      const safetyTs = nowSnapshotTimestamp();
      await takeSnapshot(
        backupSnapshotDir(stateDir, skill.name, safetyTs),
        dest,
        baseSkillDir(stateDir, skill.name),
        current,
      );
    } catch (err) {
      // Best-effort; do not abort rollback because the safety snapshot failed.
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `${pc.yellow("warning")}: could not take pre-rollback safety snapshot: ${detail}\n`,
      );
    }
  }

  const snapshotDir = backupSnapshotDir(stateDir, skill.name, options.to);
  const restored = await restoreSnapshot(dest, baseSkillDir(stateDir, skill.name), snapshotDir);

  // Commit the restored SkillState as the new authoritative state. Write last
  // so a crash mid-rollback leaves dest+base updated but state stale; the
  // worst-case outcome is the user re-runs rollback rather than silent merge
  // misbehavior.
  state.skills[skill.name] = restored;
  await writeState(statePath(stateDir), state);

  process.stdout.write(
    `Restored ${pc.bold(name)} from ${options.to} (sha ${restored.sha.slice(0, 12)}).\n`,
  );
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("skync")
    .description("Track and sync skill folders vendored from git repos.")
    .showHelpAfterError();

  program
    .command("list")
    .description("List tracked skills from the project and global manifests.")
    .action(async () => {
      await runList();
    });

  program
    .command("add <name>")
    .description(
      "Vendor a new skill from a remote repo, adopting an existing dest if one is present.",
    )
    .requiredOption("--repo <url>", "git repo URL to vendor from")
    .requiredOption("--src <path>", "source path within the repo")
    .requiredOption("--dest <path>", "destination path for the vendored skill")
    .option("--remote <name>", "override the auto-derived remote name")
    .option("--ref <ref>", "branch, tag, or commit to vendor (default: remote HEAD)")
    .option("--global", "use the global manifest and state instead of the project's")
    .action(async (name: string, options: AddOptions) => {
      await runAdd(name, options);
    });

  program
    .command("discover <name>")
    .description(
      "Find the skill folder in a remote repo whose name matches both the folder basename and the SKILL.md frontmatter `name:` (read-only).",
    )
    .requiredOption("--repo <url>", "git repo URL to search")
    .option("--ref <ref>", "branch, tag, or commit to search (default: remote HEAD)")
    .action(async (name: string, options: DiscoverOptions) => {
      await runDiscover(name, options);
    });

  program
    .command("update [name]")
    .description("Pull non-overlapping upstream changes for one or all tracked skills.")
    .option("--ref <ref>", "branch, tag, or commit to update to (default: the remote's ref)")
    .option("--global", "update only globally tracked skills")
    .option(
      "--keep <n>",
      `number of backup snapshots to retain per skill (default: ${DEFAULT_KEEP})`,
      parseKeep,
      DEFAULT_KEEP,
    )
    .action(async (name: string | undefined, options: UpdateOptions) => {
      await runUpdate(name, options);
    });

  program
    .command("resolve <name>")
    .description(
      "Mark a conflicted skill as resolved: verify no markers remain, snapshot, and advance base to the pending upstream commit.",
    )
    .option(
      "--keep <n>",
      `number of backup snapshots to retain per skill (default: ${DEFAULT_KEEP})`,
      parseKeep,
      DEFAULT_KEEP,
    )
    .action(async (name: string, options: ResolveOptions) => {
      await runResolve(name, options);
    });

  program
    .command("rollback <name>")
    .description(
      "Restore a skill from a backup snapshot. Without --to, lists available snapshots.",
    )
    .option(
      "--to <timestamp>",
      "snapshot timestamp to restore (omit to list available snapshots)",
    )
    .action(async (name: string, options: RollbackOptions) => {
      await runRollback(name, options);
    });

  program
    .command("check [name]")
    .description(
      "Dry-run merge per skill; reports up-to-date / clean-update / would-conflict and exits with a distinct code for each.",
    )
    .option("--global", "check only globally tracked skills")
    .action(async (name: string | undefined, options: CheckOptions) => {
      await runCheck(name, options);
    });

  program
    .command("status [name]")
    .description("Per-skill local-vs-base modifications plus pending-conflict flagging (read-only).")
    .option("--global", "report only globally tracked skills")
    .action(async (name: string | undefined, options: StatusOptions) => {
      await runStatus(name, options);
    });

  program
    .command("diff <name>")
    .description("Show local-vs-base and upstream-vs-base diffs for one skill (read-only).")
    .action(async (name: string) => {
      await runDiff(name);
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

// Exit codes: 0 success; 2 completed-with-conflicts (set in runUpdate, or
// `would-conflict`/`pending-conflict` in runCheck); 1 validation/operational
// error for most commands; 3 operational error from `check` so a scheduler can
// distinguish it from the would-conflict signal it acts on. Errors carry a
// human-readable message only (never a stack trace). CheckOperationalError is
// the only error class routed to exit 3; everything else stays at exit 1.
main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${pc.red("error")}: ${message}\n`);
  process.exitCode = err instanceof CheckOperationalError ? 3 : 1;
});
