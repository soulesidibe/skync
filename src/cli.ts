#!/usr/bin/env node
import { homedir } from "node:os";
import { Command } from "commander";
import pc from "picocolors";
import {
  loadManifestFile,
  mergeManifests,
  expandDest,
  manifestBaseDir,
  ManifestValidationError,
  type Manifest,
  type SkillEntry,
} from "./manifest.js";
import { projectManifestPath, globalManifestPath } from "./paths.js";

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
  const merged = mergeManifests(
    project ?? { remotes: {}, skills: [] },
    global ?? { remotes: {}, skills: [] },
  );

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

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  // Exit codes: 0 success, 1 validation/operational error; richer codes
  // (e.g. for check) arrive in a later issue.
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof ManifestValidationError) {
      process.stderr.write(`${pc.red("error")}: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${pc.red("error")}: ${message}\n`);
  process.exitCode = 1;
});
