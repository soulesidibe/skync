#!/usr/bin/env node
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { readdir, stat } from "node:fs/promises";
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
  statePath,
} from "./paths.js";
import { ensureRemoteClone, resolveRef, materializeSrc } from "./remote-cache.js";
import { readState, writeState, populateBase } from "./state-store.js";

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
 * `skync add`: vendor a brand-new skill whose dest does not yet exist. Fetches
 * the remote, resolves the ref to a concrete SHA, writes the src subtree into
 * dest, mirrors it into the base tree, updates the manifest, and records the
 * synced SHA in state.json (written last as the commit point).
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
  if (await destOccupied(dest)) {
    throw new ManifestValidationError(
      `dest '${dest}' already exists and is not empty. ` +
        "Adopting an existing folder is not yet supported.",
    );
  }

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
  await materializeSrc(repoPath, sha, options.src, dest);
  await populateBase(baseSkillDir(stateDir, name), dest);

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

  process.stdout.write(
    `Added ${pc.bold(name)} from ${remoteName} at ${sha.slice(0, 12)}\n`,
  );
  process.stdout.write(`  ${options.src} ${pc.dim("→")} ${dest}\n`);
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
    .description("Vendor a new skill from a remote repo into a fresh dest.")
    .requiredOption("--repo <url>", "git repo URL to vendor from")
    .requiredOption("--src <path>", "source path within the repo")
    .requiredOption("--dest <path>", "destination path for the vendored skill")
    .option("--remote <name>", "override the auto-derived remote name")
    .option("--ref <ref>", "branch, tag, or commit to vendor (default: remote HEAD)")
    .option("--global", "use the global manifest and state instead of the project's")
    .action(async (name: string, options: AddOptions) => {
      await runAdd(name, options);
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

// Exit codes: 0 success, 1 validation/operational error; richer codes (e.g. for
// check) arrive in a later issue. Every error class (ManifestValidationError,
// RemoteCacheError, StateValidationError, GitError) is a plain Error, so a
// single handler prints its message (never a stack trace) and sets exit 1.
main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${pc.red("error")}: ${message}\n`);
  process.exitCode = 1;
});
