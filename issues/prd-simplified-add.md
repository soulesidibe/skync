# Simplified `skync add`

## Problem statement

Adding a skill today takes four flags:

```sh
skync add grill-me \
  --repo https://github.com/mattpocock/skills \
  --src skills/productivity/grill-me \
  --dest .claude/skills/grill-me
```

Two of those flags carry no information the tool could not derive itself. The
source path is just "the folder inside the repo whose SKILL.md declares this
skill," and the destination is always the Claude Code convention
(`.claude/skills/<name>` for a project, `~/.claude/skills/<name>` globally).
Forcing the user to spell both out makes the headline command long, harder to
remember, and harder to recommend than `npm install <name>` or similar
ecosystem tools.

## Solution

`skync add <name> --repo <url>` becomes the canonical form. skync clones the
upstream cache, resolves the ref, walks the repo for a folder whose basename
matches `<name>` AND that contains a `SKILL.md` whose YAML frontmatter `name:`
field also matches. If exactly one folder qualifies, skync vendors it into the
Claude Code convention path. Both `--src` and `--dest` stay as optional
overrides so the verbose form still works.

A new `skync discover <name> --repo <url>` exposes the same walk as a read-only
debug command, so a user hit by a multi-match error can see all candidates
before re-running `add` with an explicit `--src`.

## User stories

1. As a Claude Code user, I want to install a skill with `skync add <name> --repo <url>`, so that the command is as short as I would type for any other package tool.
2. As a user, I want skync to figure out where inside the repo the skill lives, so that I do not have to read the repo's directory structure to install one.
3. As a user, I want skync to put the vendored skill at `.claude/skills/<name>` automatically, so that it loads in Claude Code without my needing to know the convention.
4. As a user installing globally with `--global`, I want skync to put the skill at `~/.claude/skills/<name>` automatically, so that the same simplified form works for personal-wide installs.
5. As a user, I want skync to identify skills by the intersection of folder name and `SKILL.md` frontmatter `name:`, so that random folders that happen to share a name are not mistaken for skills.
6. As a user installing from a repo with a non-standard layout, I want `--src` to remain accepted as an override, so that I can install skills the discovery rule cannot find.
7. As a user who wants to vendor into a non-standard destination, I want `--dest` to remain accepted as an override, so that I am not locked into the convention path.
8. As a user installing from a repo where no folder matches my skill name, I want a clear error naming the repo and the resolved commit, so that I know to check my spelling or repo URL rather than chase a tool bug.
9. As a user installing from a repo where multiple folders match, I want skync to refuse and list every candidate path, so that I can re-run with an explicit `--src` rather than have skync silently pick the wrong one.
10. As a user, I want the resolved source path to be written into `skync.yaml` at add time, so that subsequent `update`, `check`, `diff`, `resolve`, and `rollback` runs are deterministic and do not re-walk the upstream tree.
11. As a user debugging a multi-match error, I want a `skync discover <name> --repo <url>` command that runs only the discovery step and prints the candidates, so that I can verify what skync sees without writing anything to disk.
12. As a scripting user, I want `discover` to exit 0 on a single match and 1 on zero-or-multiple, so that my shell script can branch on whether `add` would succeed.
13. As a user, I want `discover` to accept `--ref` like `add` does, so that I can preview what a future pinned-ref `add` would resolve to.
14. As a user installing into an existing `.claude/skills/<name>` that already contains files, I want the existing adopt-vs-fresh behavior to keep working, so that simplified `add` never destroys edits I made before tracking the skill.
15. As a user re-reading the README, I want the simplified form to be the headline example with the verbose form retained as an "Overrides" subsection, so that I am pointed at the easy path first.
16. As a user whose repo's SKILL.md has no frontmatter or no `name:` field, I want skync to refuse to match it, so that the discovery rule remains predictable.
17. As a user with skill folders nested inside `node_modules/`, `dist/`, `build/`, `target/`, or `.venv/` in a repo, I want skync to skip those directories during discovery, so that build artifacts are never mistaken for skills.
18. As a user pinning to a specific ref via `--ref`, I want discovery to run against that ref's tree (not HEAD), so that the source I get matches the source the rest of the pipeline operates on.

## Implementation decisions

- A new self-contained discovery module encapsulates the entire "find a skill folder by name in a git tree at a SHA" capability. Its public surface is a single async function that takes a repo path, a SHA, and a skill name and returns a single resolved path, or throws a typed error distinguishing zero matches from multiple matches and carrying the candidate list in the multiple case.
- Discovery does not extract the upstream tree to disk. It walks the tree via `git ls-tree -r --name-only <sha>` to enumerate `SKILL.md` paths and reads candidate files via `git show <sha>:<path>`. This avoids materializing files for folders that turn out not to be skills.
- Frontmatter parsing is local to the discovery module. It accepts a SKILL.md whose body opens with a `---\n...\n---` fence and whose YAML parses to an object containing a `name` string equal to the requested name. Everything else (no fence, no closing fence, non-object body, missing or non-matching `name`) is treated as a non-match without raising.
- The directory denylist (`.git`, `node_modules`, `dist`, `build`, `target`, `.venv`) is applied to any segment of the candidate path, not just the first, so a `skills/foo/node_modules/...` SKILL.md is skipped too.
- The discovery rule is strict intersection: a folder matches only when its basename equals the skill name AND its SKILL.md frontmatter `name:` equals the skill name. There is no fuzzy match, no fallback, no case-folding.
- The `add` command's `--src` and `--dest` become optional. When either is omitted, the corresponding value is inferred: src by calling the discovery module, dest by the Claude Code convention (`.claude/skills/<name>` for project, `~/.claude/skills/<name>` for global). When either is provided, the explicit value wins and that inference is skipped.
- The resolved src and dest are written into the manifest exactly as if the user had typed them. Manifest schema is unchanged. State, base tree, atomic swap, and all merge logic continue to operate on the recorded src/dest without any awareness that discovery ran.
- Discovery errors raised inside `add` are converted to the existing validation-error type so the global exit-code handler maps them to exit 1, consistent with other add-time failures.
- The error message for zero matches names the repo URL and the short SHA so the user can quickly verify they are pointing at the right place. The multiple-match error lists every candidate path one per line and instructs the user to re-run with `--src`.
- A new `skync discover <name> --repo <url> [--ref <ref>]` command is added. It clones via the same remote cache as `add`, resolves the ref the same way, and calls the discovery module. On a single match it prints the path and exits 0. On zero or multiple matches it prints the candidate list (or a no-matches line) and exits 1. It writes nothing to the manifest or state.
- No other commands (`update`, `check`, `diff`, `status`, `resolve`, `rollback`, `list`) change. They read the frozen src and dest from the manifest exactly as today.
- The README headline example becomes the simplified form. The verbose form is retained under an "Overrides" subsection of the `add` reference, alongside a short paragraph explaining the discovery rule and the default destination convention.

## Testing decisions

- Good tests for this feature exercise external behavior only: given a real git repo with a known tree, the discovery module returns the right path, or the right typed error, end of test. Tests should never reach into the parsing internals, the ls-tree wrapper, or the show wrapper directly. The discovery module is a deep module: a small surface (one function, one error type) hiding tree walking, frontmatter parsing, and denylist filtering, so it earns its own focused test file.
- The discovery module gets its own unit tests covering: exact intersection match, folder-name match with frontmatter mismatch, frontmatter match with folder-name mismatch, SKILL.md missing frontmatter, two matching folders at different depths, denylisted directories ignored at any depth, SKILL.md at the repo root ignored.
- The CLI tests cover the user-visible behavior of `add` and `discover`: simplified `add` vendors to the convention path and freezes the discovered src; `add --global` vendors to the home-level convention path; `add --src` with an explicit value skips discovery; `add` with zero or multiple matches exits 1 with the documented messages; `discover` mirrors those exit codes and prints the candidates.
- Prior art: the existing `cli.test.ts` already drives the CLI end to end, builds throwaway repos in mkdtemp dirs with shell git, and asserts on stdout, stderr, exit codes, and resulting manifest and state files. The new tests follow that pattern. The fixture-repo helpers used by the existing add/update tests are reused for the new cases.
- No mocking of git, the filesystem, or the network. Tests build real git repos in temp dirs and run the real CLI against them, the same way the rest of the suite does.

## Out of scope

- Re-discovery on `update` (or any other command). Once the manifest records a src, that path is authoritative until the user changes it.
- A fallback discovery rule when intersection fails (e.g. folder-name-only or frontmatter-only matching).
- A repo-side index file (`skills.json` or similar) that would map names to paths.
- A skill registry that would let `skync add <name>` infer `--repo` itself.
- Case-insensitive or fuzzy name matching.
- Migration of existing manifest entries: nothing in the manifest schema changes, so no migration is needed.
- Changes to `update`, `check`, `diff`, `status`, `resolve`, `rollback`, or `list`.

## Further notes

- The Claude Code skill convention (`.claude/skills/<name>` and `~/.claude/skills/<name>`) is the only convention skync hard-codes. A future change could make this configurable per project via `skync.yaml`, but that adds config surface for a convention that rarely varies and is explicitly out of scope here.
- Discovery walks the tree at the resolved SHA, not the working tree of the cached clone. Bare or non-bare clones both work via `git ls-tree -r <sha>` and `git show <sha>:<path>`.
- The cache directory used by `discover` is the project state dir (`./.skync/cache`), the same as `add`. Running `discover` outside a project still works because cache creation is lazy and the directory is created on demand.
