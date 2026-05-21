import { execFile } from "node:child_process";

/**
 * Thrown when a git invocation fails: either the git binary is missing, or git
 * ran and exited non-zero. The message is intended to be shown to the user.
 */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/** Shared message for a missing git binary, used by every git invocation path. */
export const GIT_NOT_FOUND_MESSAGE = "git not found on PATH. Install git and try again.";

export interface GitOptions {
  /** Working directory for the git process. */
  cwd?: string;
  /** Path or name of the git binary. Defaults to "git"; injectable for tests. */
  gitPath?: string;
  /** Max bytes captured from stdout/stderr. */
  maxBuffer?: number;
}

/**
 * Run a git command and capture its text output. Rejects with a GitError on a
 * missing binary (clear, actionable message) or a non-zero exit (surfacing
 * git's own stderr). Use this for text commands; stream binary output (e.g.
 * `git archive`) separately.
 */
export function git(
  args: string[],
  options: GitOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const gitPath = options.gitPath ?? "git";
  return new Promise((resolvePromise, reject) => {
    execFile(
      gitPath,
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new GitError(GIT_NOT_FOUND_MESSAGE));
            return;
          }
          const detail = stderr.trim() || err.message;
          reject(new GitError(`git ${args.join(" ")} failed: ${detail}`));
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}
