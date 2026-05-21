import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { writeFileAtomic } from "./atomic.js";
import { isNotFound, isPlainObject } from "./util.js";

/**
 * A named remote git repository. Skills reference a remote by its key in the
 * manifest's `remotes` map, so skills from the same repo share one cache.
 */
export interface Remote {
  repo: string;
  ref?: string;
}

/**
 * A tracked skill: a folder vendored from a remote repo's `src` path into a
 * local `dest` path.
 */
export interface SkillEntry {
  name: string;
  remote: string;
  src: string;
  dest: string;
}

/**
 * A parsed and validated manifest.
 */
export interface Manifest {
  remotes: Record<string, Remote>;
  skills: SkillEntry[];
}

/**
 * Thrown when a manifest is structurally invalid (bad YAML, wrong shape, a
 * skill referencing an unknown remote, and so on). The message is intended to
 * be shown directly to the user.
 */
export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

/** A fresh, empty manifest. */
export function emptyManifest(): Manifest {
  return { remotes: {}, skills: [] };
}

/**
 * Parse manifest YAML text, validate its shape, and return a normalized
 * Manifest. Throws ManifestValidationError with a clear message on any problem.
 *
 * An empty document or an empty mapping (`{}`) is a valid empty manifest.
 */
export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ManifestValidationError(`could not parse manifest YAML: ${detail}`);
  }

  // An empty file parses to null or undefined: treat as an empty manifest.
  if (raw === null || raw === undefined) {
    return emptyManifest();
  }

  if (!isPlainObject(raw)) {
    throw new ManifestValidationError(
      "manifest root must be a mapping with optional 'remotes' and 'skills' keys",
    );
  }

  const remotes: Record<string, Remote> = {};
  const rawRemotes = raw.remotes;
  if (rawRemotes !== undefined && rawRemotes !== null) {
    if (!isPlainObject(rawRemotes)) {
      throw new ManifestValidationError("'remotes' must be a mapping of name to remote");
    }
    for (const [name, value] of Object.entries(rawRemotes)) {
      if (!isPlainObject(value)) {
        throw new ManifestValidationError(`remote '${name}' must be a mapping`);
      }
      if (typeof value.repo !== "string" || value.repo.length === 0) {
        throw new ManifestValidationError(`remote '${name}' is missing a 'repo' string`);
      }
      const remote: Remote = { repo: value.repo };
      if (value.ref !== undefined && value.ref !== null) {
        if (typeof value.ref !== "string") {
          throw new ManifestValidationError(`remote '${name}' has a non-string 'ref'`);
        }
        remote.ref = value.ref;
      }
      remotes[name] = remote;
    }
  }

  const skills: SkillEntry[] = [];
  const rawSkills = raw.skills;
  if (rawSkills !== undefined && rawSkills !== null) {
    if (!Array.isArray(rawSkills)) {
      throw new ManifestValidationError("'skills' must be a list");
    }
    for (let i = 0; i < rawSkills.length; i++) {
      const value = rawSkills[i];
      if (!isPlainObject(value)) {
        throw new ManifestValidationError(`skill at index ${i} must be a mapping`);
      }
      const required: Array<keyof SkillEntry> = ["name", "remote", "src", "dest"];
      for (const field of required) {
        if (typeof value[field] !== "string" || (value[field] as string).length === 0) {
          throw new ManifestValidationError(
            `skill at index ${i} is missing a '${field}' string`,
          );
        }
      }
      skills.push({
        name: value.name as string,
        remote: value.remote as string,
        src: value.src as string,
        dest: value.dest as string,
      });
    }
  }

  // Referential integrity: every skill must point at a known remote.
  for (const skill of skills) {
    if (!(skill.remote in remotes)) {
      throw new ManifestValidationError(
        `skill '${skill.name}' references unknown remote '${skill.remote}'`,
      );
    }
  }

  return { remotes, skills };
}

/**
 * Merge a project manifest over a global one. Project entries win on clash:
 * skills are deduped by `name`, remotes by their map key. Non-clashing entries
 * from both sides survive. Pure: inputs are not mutated.
 */
export function mergeManifests(project: Manifest, global: Manifest): Manifest {
  const remotes: Record<string, Remote> = { ...global.remotes, ...project.remotes };

  const byName = new Map<string, SkillEntry>();
  // Global first, then project overrides on name clash.
  for (const skill of global.skills) {
    byName.set(skill.name, skill);
  }
  for (const skill of project.skills) {
    byName.set(skill.name, skill);
  }

  return { remotes, skills: [...byName.values()] };
}

/**
 * Expand a `dest` value:
 *   - bare `~` and a leading `~/` expand to the home directory.
 *   - `~user` (anything else after `~`) is left literal.
 *   - otherwise resolve relative to `baseDir` (absolute paths pass through).
 *
 * `baseDir` is the directory of the manifest file declaring the skill. Pure.
 */
export function expandDest(
  dest: string,
  options: { home: string; baseDir: string },
): string {
  const { home, baseDir } = options;

  if (dest === "~") {
    return home;
  }
  if (dest.startsWith("~/")) {
    return resolve(home, dest.slice(2));
  }
  // `~user` and `~something` are left literal (not expanded).
  if (dest.startsWith("~")) {
    return dest;
  }
  if (isAbsolute(dest)) {
    return dest;
  }
  return resolve(baseDir, dest);
}

/**
 * Normalize a git repo URL to a canonical form for dedup comparison:
 * strips a trailing `.git`, strips a trailing slash, and rewrites SSH
 * `git@host:user/repo` into a comparable `host/user/repo` form.
 */
export function normalizeRepoUrl(url: string): string {
  let s = url.trim();

  // SSH shorthand: git@github.com:user/repo(.git) -> host/user/repo.
  const sshMatch = /^[^@/]+@([^:]+):(.+)$/.exec(s);
  if (sshMatch) {
    s = `${sshMatch[1]}/${sshMatch[2]}`;
  } else {
    // Strip a scheme like https:// or ssh:// for comparison, then drop a
    // leading user@ left over from scheme-style SSH (ssh://git@host/path).
    s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
    s = s.replace(/^[^@/]+@/, "");
  }

  s = s.replace(/\/+$/, "");
  s = s.replace(/\.git$/, "");
  return s.toLowerCase();
}

/**
 * Derive a slug (default remote name) from a repo URL: normalize, then take the
 * last path segment.
 */
export function slugFromRepo(url: string): string {
  const normalized = normalizeRepoUrl(url);
  const segments = normalized.split("/").filter((seg) => seg.length > 0);
  const last = segments[segments.length - 1];
  // Defensive: a degenerate or host-only URL yields no usable segment.
  return last && last.length > 0 ? last : "remote";
}

/**
 * Find an existing remote matching the given repo URL (by normalized URL), or
 * create a new one. Pure: returns a NEW remotes map and the resolved name.
 *
 *   - dedup is by normalized repo URL: a matching repo reuses the existing name.
 *   - `remote` overrides the chosen name when creating.
 *   - a slug collision (different repo, same desired name) gets a numeric suffix.
 *   - `ref` is recorded on a newly created remote.
 *
 * Returns the new remotes map, the resolved name, and the chosen remote's `ref`
 * (so callers need not index back into the map).
 */
export function findOrCreateRemote(
  remotes: Record<string, Remote>,
  options: { repo: string; remote?: string; ref?: string },
): { remotes: Record<string, Remote>; name: string; ref?: string } {
  const { repo, remote, ref } = options;
  const targetNormalized = normalizeRepoUrl(repo);

  // Reuse an existing remote with a matching normalized repo URL.
  for (const [name, value] of Object.entries(remotes)) {
    if (normalizeRepoUrl(value.repo) === targetNormalized) {
      return { remotes: { ...remotes }, name, ref: value.ref };
    }
  }

  // Determine the desired name, then resolve collisions with a suffix.
  const desired = remote && remote.length > 0 ? remote : slugFromRepo(repo);
  let name = desired;
  let suffix = 2;
  while (name in remotes) {
    name = `${desired}-${suffix}`;
    suffix += 1;
  }

  const created: Remote = { repo };
  if (ref !== undefined && ref.length > 0) {
    created.ref = ref;
  }

  return { remotes: { ...remotes, [name]: created }, name, ref: created.ref };
}

/**
 * Load a manifest file from disk. Returns null when the file does not exist.
 * An empty or `{}` file yields an empty manifest, not an error.
 * Throws ManifestValidationError on invalid content.
 */
export async function loadManifestFile(path: string): Promise<Manifest | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
  return parseManifest(text);
}

/**
 * Resolve the effective manifest by loading the project and global manifests
 * and merging them with project precedence. A missing file contributes an
 * empty manifest.
 */
export async function resolveManifests(options: {
  projectManifestPath: string;
  globalManifestPath: string;
}): Promise<Manifest> {
  const [project, global] = await Promise.all([
    loadManifestFile(options.projectManifestPath),
    loadManifestFile(options.globalManifestPath),
  ]);
  return mergeManifests(project ?? emptyManifest(), global ?? emptyManifest());
}

/**
 * The directory of a manifest file, used as the base for resolving
 * project-relative `dest` values.
 */
export function manifestBaseDir(manifestPath: string): string {
  return dirname(manifestPath);
}

/**
 * Add or replace a skill in a manifest, matching by `name`. Pure: returns a new
 * Manifest; the input is not mutated. Replaced skills keep their position.
 */
export function upsertSkill(manifest: Manifest, skill: SkillEntry): Manifest {
  const idx = manifest.skills.findIndex((s) => s.name === skill.name);
  const skills =
    idx === -1
      ? [...manifest.skills, skill]
      : manifest.skills.map((s, i) => (i === idx ? skill : s));
  return { remotes: { ...manifest.remotes }, skills };
}

/**
 * Serialize a manifest to YAML deterministically: remotes keyed in sorted order
 * with `repo` before `ref`, skills in their list order with a fixed field order.
 * Note: this normalizes formatting and drops any comments a user may have added
 * to a hand-edited manifest.
 */
export function serializeManifest(manifest: Manifest): string {
  const remotes: Record<string, Remote> = {};
  for (const name of Object.keys(manifest.remotes).sort()) {
    const r = manifest.remotes[name];
    remotes[name] = r.ref !== undefined ? { repo: r.repo, ref: r.ref } : { repo: r.repo };
  }
  const doc = {
    remotes,
    skills: manifest.skills.map((s) => ({
      name: s.name,
      remote: s.remote,
      src: s.src,
      dest: s.dest,
    })),
  };
  return stringifyYaml(doc);
}

/**
 * Write a manifest to `path` atomically, creating the parent directory if
 * needed.
 */
export async function saveManifestFile(path: string, manifest: Manifest): Promise<void> {
  await writeFileAtomic(path, serializeManifest(manifest));
}
