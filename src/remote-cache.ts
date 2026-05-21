import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { git, GitError, GIT_NOT_FOUND_MESSAGE } from "./git.js";
import { normalizeRepoUrl } from "./manifest.js";

/**
 * Thrown when a remote cache operation fails (clone/fetch/resolve/materialize).
 * The message is intended to be shown directly to the user.
 */
export class RemoteCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteCacheError";
  }
}

export interface RemoteCacheOptions {
  /** Path or name of the git binary; injectable for tests. Defaults to "git". */
  gitPath?: string;
}

/**
 * Stable on-disk directory name for a repo's cached clone, derived from the
 * NORMALIZED repo URL so different spellings of the same repo share one cache,
 * independent of the remote's human-readable name.
 */
export function cacheKeyForRepo(repoUrl: string): string {
  const normalized = normalizeRepoUrl(repoUrl);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a cached clone exists for `repoUrl` under `cacheDir` and is up to date.
 * Clones (no checkout, blob:none filter) on first use; otherwise fetches all
 * heads and tags so later ref resolution sees upstream advances. The clone is
 * used purely as an object store; subtrees are extracted with materializeSrc.
 * Returns the absolute path to the cached clone.
 */
export async function ensureRemoteClone(
  cacheDir: string,
  repoUrl: string,
  options: RemoteCacheOptions = {},
): Promise<string> {
  await mkdir(cacheDir, { recursive: true });
  const repoPath = join(cacheDir, cacheKeyForRepo(repoUrl));
  const { gitPath } = options;

  if (await pathExists(join(repoPath, ".git"))) {
    await git(["fetch", "--prune", "--tags", "origin"], { cwd: repoPath, gitPath });
  } else {
    await git(
      ["clone", "--no-checkout", "--filter=blob:none", repoUrl, repoPath],
      { gitPath },
    );
  }
  return repoPath;
}

/**
 * Resolve a ref (branch, tag, or commit SHA) to a concrete commit SHA within a
 * cached clone. Branches are resolved through the remote-tracking ref so a prior
 * fetch's advance is reflected; tags and SHAs resolve directly.
 */
export async function resolveRef(
  repoPath: string,
  ref: string,
  options: RemoteCacheOptions = {},
): Promise<string> {
  const { gitPath } = options;
  // Try the remote-tracking branch first (always fresh after fetch), then the
  // raw ref (covers tags, full refs, and commit SHAs).
  const candidates = [`refs/remotes/origin/${ref}`, ref];
  for (const candidate of candidates) {
    try {
      const { stdout } = await git(
        ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
        { cwd: repoPath, gitPath },
      );
      const sha = stdout.trim();
      if (sha.length > 0) {
        return sha;
      }
    } catch (err) {
      // rev-parse --verify --quiet exits non-zero (-> GitError) when the
      // candidate does not resolve; try the next candidate.
      if (!(err instanceof GitError)) {
        throw err;
      }
    }
  }
  throw new RemoteCacheError(`could not resolve ref '${ref}' in the cached clone`);
}

/**
 * Normalize a src path within the repo: strip a leading `./`, strip surrounding
 * slashes. An empty result (or `.`) means the repo root.
 */
function normalizeSrcPath(src: string): string {
  let s = src.trim().replace(/^\.\//, "");
  s = s.replace(/^\/+/, "").replace(/\/+$/, "");
  if (s === "." || s === "") {
    return "";
  }
  return s;
}

/**
 * Materialize the `src` subtree at a given commit SHA into `destDir`. The dest
 * receives the contents of the subtree (not a nested folder). Uses `git archive`
 * piped through `tar`, which is stateless (no working tree), preserves mode bits
 * and symlinks, and lets one cached clone serve many src paths and SHAs.
 */
export async function materializeSrc(
  repoPath: string,
  sha: string,
  src: string,
  destDir: string,
  options: RemoteCacheOptions = {},
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const srcPath = normalizeSrcPath(src);
  const treeish = srcPath.length > 0 ? `${sha}:${srcPath}` : sha;
  const gitBin = options.gitPath ?? "git";

  await new Promise<void>((resolvePromise, reject) => {
    const gitProc = spawn(gitBin, ["-C", repoPath, "archive", "--format=tar", treeish], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tarProc = spawn("tar", ["-x", "-C", destDir], {
      stdio: ["pipe", "ignore", "pipe"],
    });

    let gitStderr = "";
    let tarStderr = "";
    let gitCode: number | null = null;
    let tarCode: number | null = null;
    let settled = false;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      reject(new RemoteCacheError(message));
    };

    const finish = () => {
      if (settled || gitCode === null || tarCode === null) return;
      if (gitCode !== 0) {
        fail(`git archive ${treeish} failed: ${gitStderr.trim()}`);
        return;
      }
      if (tarCode !== 0) {
        fail(`extracting ${src} failed: ${tarStderr.trim()}`);
        return;
      }
      settled = true;
      resolvePromise();
    };

    gitProc.on("error", (err) => {
      fail(
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? GIT_NOT_FOUND_MESSAGE
          : `git archive could not start: ${err.message}`,
      );
    });
    tarProc.on("error", (err) => {
      fail(
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? "tar not found on PATH. Install tar and try again."
          : `tar could not start: ${err.message}`,
      );
    });

    gitProc.stderr.on("data", (chunk) => {
      gitStderr += chunk.toString();
    });
    tarProc.stderr.on("data", (chunk) => {
      tarStderr += chunk.toString();
    });

    // If tar exits early its stdin closes; guard the pipe so the resulting
    // EPIPE on git's stdout rejects the promise instead of crashing the process.
    gitProc.stdout.on("error", (err) => {
      fail(`git archive output failed: ${err.message}`);
    });
    gitProc.stdout.pipe(tarProc.stdin);
    gitProc.on("close", (code) => {
      gitCode = code ?? 0;
      finish();
    });
    tarProc.on("close", (code) => {
      tarCode = code ?? 0;
      finish();
    });
  });
}
