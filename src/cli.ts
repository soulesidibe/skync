#!/usr/bin/env node
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
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
  backupSnapshotDir,
  statePath,
} from "./paths.js";
import { ensureRemoteClone, resolveRef, materializeSrc } from "./remote-cache.js";
import { readState, writeState, populateBase, snapshotLocal } from "./state-store.js";
import {
  swapDirAtomic,
  recoverPendingSwap,
  stagingPathFor,
} from "./atomic.js";
import { readTree, writeTree } from "./tree-io.js";
import { mergeTrees, type Conflict } from "./treemerge.js";
import { treeConflictMarkerPaths } from "./conflict-markers.js";

/**
 * Thrown when a skill's live copy still carries unresolved conflict markers, so
 * an update would stack a merge on top of an unmerged file. The user must run
 * `skync resolve` or `skync rollback` first. Exits 1 like other operational
 * errors (distinct from the exit-2 "completed with conflicts" outcome).
 */
class UnresolvedConflictError extends Error {}

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

interface UpdateOptions {
  ref?: string;
  global?: boolean;
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

  // Refuse before any fetch if the live copy still has unresolved markers:
  // updating would stack a merge on an unmerged file.
  const live = await readTree(dest);
  const marked = treeConflictMarkerPaths(live);
  if (marked.length > 0) {
    throw new UnresolvedConflictError(
      `skill '${skill.name}' has unresolved conflict markers in: ${marked.join(", ")}. ` +
        `Run 'skync resolve ${skill.name}' once you have edited the markers out, ` +
        `or 'skync rollback ${skill.name}' to discard them.`,
    );
  }

  const repoPath = await ensureRemoteClone(cacheDir(stateDir), remote.repo);
  const ref = refOverride ?? remote.ref ?? "HEAD";
  const sha = await resolveRef(repoPath, ref);

  const state = await readState(statePath(stateDir));
  const prev = state.skills[skill.name];
  if (prev !== undefined && prev.sha === sha) {
    process.stdout.write(`${pc.bold(skill.name)} is up to date.\n`);
    return { name: skill.name, status: "up-to-date", conflicts: [] };
  }

  // Materialize upstream into a scratch dir we only read from.
  const upstreamDir = await mkdtemp(join(tmpdir(), "skync-upstream-"));
  try {
    await materializeSrc(repoPath, sha, skill.src, upstreamDir);

    const [base, upstream] = await Promise.all([
      readTree(baseSkillDir(stateDir, skill.name)),
      readTree(upstreamDir),
    ]);

    const result = mergeTrees(base, upstream, live);

    // Snapshot the live copy before mutating dest, so the update is reversible
    // even when it lands conflict markers.
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    await snapshotLocal(backupSnapshotDir(stateDir, skill.name, timestamp), dest);

    // Stage the merged tree in dest's parent, then swap it into place atomically.
    const staging = stagingPathFor(dest);
    await rm(staging, { recursive: true, force: true });
    await writeTree(staging, result.merged);
    await swapDirAtomic(dest, staging);

    if (!result.clean) {
      // Conflicts are now in dest. Leave base and state.json untouched so the
      // merge base does not advance until the conflict is resolved.
      process.stdout.write(`${pc.bold(skill.name)} has conflicts; markers written to dest.\n`);
      return { name: skill.name, status: "conflict", conflicts: result.conflicts };
    }

    // Base advances to the upstream tree (the new merge base) on a clean merge.
    await populateBase(baseSkillDir(stateDir, skill.name), upstreamDir);

    // state.json is the commit point: write it last.
    state.skills[skill.name] = {
      remote: skill.remote,
      src: skill.src,
      dest: skill.dest,
      sha,
      syncedAt: new Date().toISOString(),
    };
    await writeState(statePath(stateDir), state);

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
    outcomes.push(await updateSkill(target, remotes, home, options.ref));
  }

  reportConflicts(outcomes);

  // Completed, but conflicts await resolution: signal with exit 2, distinct
  // from operational errors (exit 1, set by the top-level catch).
  if (outcomes.some((o) => o.status === "conflict")) {
    process.exitCode = 2;
  }
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
    .command("update [name]")
    .description("Pull non-overlapping upstream changes for one or all tracked skills.")
    .option("--ref <ref>", "branch, tag, or commit to update to (default: the remote's ref)")
    .option("--global", "update only globally tracked skills")
    .action(async (name: string | undefined, options: UpdateOptions) => {
      await runUpdate(name, options);
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

// Exit codes: 0 success, 2 completed-with-conflicts (set in runUpdate), 1
// validation/operational error; richer codes (e.g. for check) arrive in a later
// issue. Every error class (ManifestValidationError, RemoteCacheError,
// StateValidationError, GitError, UnresolvedConflictError) is a plain Error, so
// a single handler prints its message (never a stack trace) and sets exit 1. A
// thrown error takes precedence over an exit-2 conflict in the same run.
main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${pc.red("error")}: ${message}\n`);
  process.exitCode = 1;
});
