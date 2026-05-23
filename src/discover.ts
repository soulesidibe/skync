import { parse as parseYaml } from "yaml";
import { git } from "./git.js";

/**
 * Path segments that are skipped at any depth when walking the tree. A
 * candidate `SKILL.md` whose path contains any of these segments is treated as
 * if it were not present at all (no read, no frontmatter parse).
 */
const DENYLIST: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  ".venv",
]);

/** Base class for discovery failures. Useful for `catch (e instanceof DiscoveryError)`. */
export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryError";
  }
}

/**
 * Raised when no skill folder in the tree satisfies the intersection rule
 * (folder basename equals the requested name AND SKILL.md frontmatter `name:`
 * equals the requested name). Carries the requested name and the resolved SHA
 * so the CLI can construct a user-facing message that includes the repo URL.
 */
export class DiscoveryNoMatchError extends DiscoveryError {
  constructor(public readonly skillName: string, public readonly sha: string) {
    super(`no skill named '${skillName}' found at ${sha.slice(0, 7)}`);
    this.name = "DiscoveryNoMatchError";
  }
}

/**
 * Raised when more than one skill folder satisfies the intersection rule.
 * Carries every candidate path (POSIX, repo-relative, sorted lexicographically)
 * so the CLI can list them and prompt the user to disambiguate via `--src`.
 */
export class DiscoveryMultipleMatchError extends DiscoveryError {
  constructor(
    public readonly skillName: string,
    public readonly candidates: readonly string[],
  ) {
    super(
      `multiple skill folders match '${skillName}': ${candidates.join(", ")}`,
    );
    this.name = "DiscoveryMultipleMatchError";
  }
}

export interface DiscoverOptions {
  /** Path or name of the git binary; injectable for tests. Defaults to "git". */
  gitPath?: string;
}

/**
 * Find the single skill folder in `repoPath`'s tree at `sha` that satisfies the
 * intersection rule: folder basename equals `name` AND its `SKILL.md` carries
 * YAML frontmatter whose `name:` field is a string equal to `name`. Returns a
 * POSIX repo-relative path on success; throws DiscoveryNoMatchError on zero
 * matches and DiscoveryMultipleMatchError on more than one. Reads the tree
 * exclusively via `git ls-tree -r` and `git show <sha>:<path>` so nothing is
 * extracted to disk.
 */
export async function discoverSkill(
  repoPath: string,
  sha: string,
  name: string,
  options: DiscoverOptions = {},
): Promise<string> {
  const { gitPath } = options;

  // -z gives NUL-delimited paths so filenames with newlines or unusual bytes
  // survive intact. Filtering happens on the parsed list afterwards.
  const { stdout } = await git(
    ["ls-tree", "-r", "--name-only", "-z", sha],
    { cwd: repoPath, gitPath },
  );

  const allPaths = stdout.split("\0").filter((p) => p.length > 0);
  const folders: string[] = [];

  for (const path of allPaths) {
    // Tree paths from git use POSIX separators on every platform.
    const segments = path.split("/");
    if (segments[segments.length - 1] !== "SKILL.md") continue;

    // Denylist: any segment in the path disqualifies the candidate before any
    // further work (no read, no parse).
    if (segments.some((seg) => DENYLIST.has(seg))) continue;

    // Repo-root SKILL.md has no folder to nest in.
    if (segments.length < 2) continue;

    const folder = segments.slice(0, -1).join("/");
    const basename_ = segments[segments.length - 2];
    if (basename_ !== name) continue;

    const contents = await readFileAtSha(repoPath, sha, path, gitPath);
    if (!frontmatterNameMatches(contents, name)) continue;

    folders.push(folder);
  }

  // Dedupe defensively (ls-tree should not return duplicates, but a single
  // duplicate would otherwise turn a true single match into a multi-match
  // error).
  const unique = Array.from(new Set(folders)).sort();

  if (unique.length === 0) {
    throw new DiscoveryNoMatchError(name, sha);
  }
  if (unique.length > 1) {
    throw new DiscoveryMultipleMatchError(name, unique);
  }
  return unique[0];
}

async function readFileAtSha(
  repoPath: string,
  sha: string,
  path: string,
  gitPath: string | undefined,
): Promise<string> {
  const { stdout } = await git(["show", `${sha}:${path}`], {
    cwd: repoPath,
    gitPath,
  });
  return stdout;
}

/**
 * Returns true when `contents` opens with a `---` fence, a YAML body, a closing
 * `---` (possibly at end-of-file with no trailing newline), and the parsed body
 * is a plain object whose `name` field is a string equal to `expected`. Any
 * deviation (BOM aside) is treated as a non-match without raising.
 */
function frontmatterNameMatches(contents: string, expected: string): boolean {
  // Strip a leading BOM, which editors and Windows tooling commonly insert and
  // which would otherwise push the opening fence off byte 0.
  let text = contents.startsWith("﻿") ? contents.slice(1) : contents;

  // Normalize CRLF and lone CR to LF so a single regex handles every editor.
  text = text.replace(/\r\n?/g, "\n");

  if (!text.startsWith("---\n")) return false;

  const body = text.slice(4);
  // The closing fence is `---` either at end-of-string or followed by a newline.
  // Matching either keeps files that omit the trailing newline before EOF valid.
  const closeMatch = body.match(/(^|\n)---(\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) return false;

  const yamlBody = body.slice(0, closeMatch.index);

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBody);
  } catch {
    return false;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const nameValue = (parsed as Record<string, unknown>).name;
  return typeof nameValue === "string" && nameValue === expected;
}
