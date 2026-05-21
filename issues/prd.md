# skync PRD

## Problem Statement

I copy skill folders (for example the Gridmy skill from Matt Pocock's repo) from
remote git repos into my local skills directories, either global
(`~/.claude/skills/`) or per-project (`<project>/.claude/skills/`). Once copied,
I make local modifications. When the upstream author later updates the skill,
there is no clean way to pull those updates into my locally modified copy.
Manually diffing and merging is tedious and error prone, and a mistake can
silently destroy my local changes. I also have no way to safely roll back a
skill to a previous working version after a bad merge.

## Solution

skync is a Node/TypeScript CLI (run via `npx skync ...`) that tracks which local
skill folders came from which remote repos and paths, and keeps them updated
over time using a three-way merge.

For each tracked skill it maintains three versions:

- **base**: upstream as it was at the last successful sync (the merge base).
- **upstream**: upstream as it is now (freshly fetched).
- **local**: my working copy in the live skills directory, including my edits.

A three-way merge applies upstream changes that do not touch my edits, and flags
a conflict only where upstream and local changed the same region. Clean merges
apply silently; conflicts are written in place with git-style markers and
reported clearly per skill and per file. Every update snapshots my local copy
first, so I can always roll back to a previous working version.

## User Stories

1. As a Claude Code user, I want to register a skill folder I already copied and modified, so that skync can track it without overwriting my existing edits.
2. As a user, I want `add` to adopt my existing local skill as the local copy and fetch current upstream as the base, so that the very first command never destroys my work.
3. As a user adding a brand-new skill that I have not copied yet, I want `add` to vendor it fresh so that base and local both start from upstream.
4. As a user, I want to point `add` at a repo URL with `--repo` and have skync auto-create or reuse a named remote, so that I do not have to hand-edit the manifest first.
5. As a user, I want skills from the same repo to share one cached clone, so that fetches stay fast and disk use stays low.
6. As a user, I want to pin a skill to a branch, tag, or specific commit via a ref, so that I control which upstream line I track.
7. As a user, I want `check` to fetch remotes and tell me per skill whether it is up to date, has a clean update available, or would conflict, without modifying any files, so that I can decide what to do.
8. As a user running `check` from a scheduler, I want distinct exit codes for up-to-date, clean-updates-available, would-conflict, and operational error, so that automation can auto-update clean changes, notify on conflicts, and alert on failures.
9. As a user, I want `update` to apply non-overlapping upstream changes automatically with no prompts, so that routine updates are effortless.
10. As a user, I want `update` to write git-style conflict markers in place only where upstream and my edits overlap, and tell me exactly which skills and files are affected, so that I know precisely what to resolve.
11. As a user, I want the merge base to advance only on a clean merge, so that an unresolved conflict does not corrupt future merges.
12. As a user, I want `update` to snapshot my local copy before merging, so that any update is reversible.
13. As a user, I want `update` to stage the full merged tree and swap it in atomically, so that a crash mid-update never leaves a half-merged live skill.
14. As a user who has manually edited out conflict markers, I want a `resolve` command that verifies no markers remain, snapshots, and advances the base to the pending upstream commit, so that future updates stay correct.
15. As a user, I want `update` to refuse to run on a skill that still has unresolved conflict markers, so that I do not stack a new merge on top of an unresolved one.
16. As a user, I want `rollback <name>` to restore a skill from a backup snapshot, listing available snapshots when I omit `--to`, so that I can recover any previous working version.
17. As a user, I want `status` to show my local modifications versus base and any pending conflicts, so that I understand the current state before acting.
18. As a user, I want `diff <name>` to show local-vs-base and upstream-vs-base diffs, so that I can see what changed on each side.
19. As a user, I want `list` to show all tracked skills and their state, so that I have an overview.
20. As a user, I want a skill deleted upstream but modified locally to be reported as a conflict rather than silently deleted, so that an upstream rename or removal never destroys my edits.
21. As a user, I want binary files (such as images in a skill) handled by byte comparison rather than line merge, so that they are never corrupted.
22. As a user editing on a different OS, I want line-ending differences (CRLF vs LF) ignored during merge and my local newline style preserved on write, so that I do not get whole-file spurious conflicts.
23. As a user, I want skync to keep only the last N backup snapshots per skill (configurable) and auto-prune older ones, so that disk use stays bounded while recent recovery points remain.
24. As a user with both a project manifest and a global manifest, I want project entries to take precedence on name clashes, so that project-specific skills win.
25. As a user, I want project skill state under `./.skync/` (git-ignored) and global skill state under `~/.config/skync/.skync/`, so that a project's vendoring state is self-contained and committable while global state never leaks into repos.
26. As a user, I want `dest` to support `~` expansion and project-relative paths, so that both global and per-project skill placements work.
27. As a user without a system git binary, I want a clear error rather than a confusing failure, so that I know what to install.

## Implementation Decisions

**Modules to build**

- **TreeMerge** (deep, pure, no I/O): given base, upstream, and local file trees, returns a merged tree plus a conflict report. Internally performs path-set reconciliation (union of paths across the three sides, classify each path's change per side), applies non-conflicting structural changes directly, and runs `node-diff3` only on files modified on both sides. Classifies text vs binary via a NUL-byte heuristic on the first ~8KB; binary files use byte equality and are never line-merged. Normalizes CRLF to LF in memory for diffing only and preserves the local file's newline style on output (no on-disk reformatting). No rename detection in v1: renames are treated as delete+add, and a file deleted on one side but modified on the other is reported as a conflict, never a silent delete.
- **RemoteCache** (deep): maintains a cached bare clone per remote under the state directory, using `blob:none` partial clone plus sparse-checkout of the skill's `src` path; refreshes via `git fetch`. Resolves a manifest `ref` (branch, tag, or SHA) to a concrete commit at fetch time, and materializes the `src` subtree at a given SHA. Requires a system `git` binary and errors clearly if absent.
- **Manifest**: loads and merges the project manifest (`./skync.yaml`) and global manifest (`~/.config/skync/manifest.yaml`), with project precedence on name clashes. Auto-manages named remotes: `add --repo <url>` reuses a matching remote or creates one named from the repo slug (deduped); optional `--remote` and `--ref` flags override. Named remotes remain the single source of truth so skills sharing a repo share a cache. Supports `~` expansion and project-relative `dest`.
- **StateStore**: manages `state.json` (per skill: last-synced upstream SHA = merge-base pointer, timestamps), the `base/<skill>/` trees, and `backups/<skill>/<timestamp>/` snapshots. All writes go through write-temp-then-rename. Implements count-based retention (default keep last 10, configurable via `--keep`), auto-pruning after a successful update, and never prunes a snapshot a pending conflict depends on. State directory is paired with the manifest that declares the skill: project skills under `./.skync/`, global skills under `~/.config/skync/.skync/`.
- **CLI** (shallow glue): commander wiring, orchestration across the modules, output formatting (picocolors), and exit codes.

**Command set**

- `add <name> --repo <url> --src <path> --dest <path> [--remote <name>] [--ref <ref>]`: add to manifest and initialize. If `dest` already exists, adopt it as local and populate base from current upstream (documented limitation: upstream changes predating `add` are baked into base). If `dest` is absent, vendor fresh (base and local both equal upstream).
- `check`: fetch remotes, report per skill (up to date / clean update available / would conflict) by computing a dry-run merge in memory; read-only. Exit codes: `0` up to date, `1` clean updates available, `2` at least one would conflict, and a distinct higher code for git/network/operational errors.
- `update [name]`: for each skill, snapshot local to backups, compute the full three-way merge into a temp staging tree, then atomically swap it into `dest`. Clean merges apply silently; conflicts are written in place with git-style markers and the skill is reported as conflicted. Base advances only on a clean merge. Refuses to run on a skill that still has unresolved conflict markers.
- `resolve <name>`: verify no conflict markers remain in `dest`, snapshot, then advance base to the pending upstream SHA and update `state.json`.
- `rollback <name> [--to <timestamp>]`: restore a skill from a backup snapshot; list snapshots when `--to` is omitted.
- `status`: show local modifications vs base and any pending conflicts.
- `diff <name>`: show local-vs-base and upstream-vs-base diffs.
- `list`: list tracked skills and their state.

**Manifest and state shapes**

- Manifest (YAML): `remotes` keyed by name (`repo`, `ref`), and `skills` list (`name`, `remote`, `src`, `dest`).
- `state.json`: per skill, the last-synced upstream commit SHA and timestamps.

**Distribution**

- Runs via `npx skync ...`. TypeScript compiled to JS. Libraries: `commander`, `simple-git`, `node-diff3`, `yaml`, `picocolors`.

## Testing Decisions

A good test exercises a module's external behavior through its public interface, not its internals: feed inputs, assert outputs and observable side effects. The two deep modules carry the most risk and the most value.

Modules to be tested (all four requested):

- **TreeMerge**: synthetic three-tree cases covering clean merge, non-overlapping changes (auto-merge), true overlapping conflict (markers emitted), delete-on-one-side-modify-on-the-other (conflict, no silent delete), binary file changed on both sides (byte conflict, no corruption), and CRLF-vs-LF inputs (no spurious conflict, local newline style preserved). Pure-function tests with no I/O.
- **RemoteCache**: against a local fixture git repo, assert ref-to-SHA resolution (branch, tag, SHA), sparse materialization of just the `src` subtree at a SHA, and correct re-fetch after the fixture advances.
- **StateStore**: snapshot/restore round-trip fidelity, retention keeps exactly the last N and prunes older, temp-then-rename leaves no partial state, and a pending-conflict snapshot is never pruned.
- **Manifest**: project-over-global precedence on name clashes, auto-remote creation/dedup from `--repo`, `~` expansion and project-relative `dest`, and validation errors on malformed manifests.

Prior art: tests run under vitest (`vitest run`), already configured in `package.json`.

## Out of Scope

- No Go implementation. Node/TypeScript only. Final.
- No GUI. CLI only.
- v1 does not run itself on a schedule. `check` is designed to be scheduler-friendly (distinct exit codes), but wiring cron/loop is out of scope.
- Not a general-purpose package manager. Scope is skill folders vendored from git repos.
- No content-similarity rename detection in v1 (renames handled as delete+add; deferred).
- No backup deduplication/hardlinking in v1 (count-based retention only).

## Further Notes

- Open empirical items, resolved during phase-5 dogfooding: the exact Matt Pocock repo URL and the path to the Gridmy skill inside it.
- Build phases (each validated before the next): (1) scaffold TS project, CLI skeleton, config load/validate, manifest resolution; (2) vendor and state: `add`, RemoteCache fetch, base/local population, `state.json`, `.skync/` cache; (3) TreeMerge core, `update`, backups, atomic swap, unit tests on synthetic cases; (4) `resolve`, `rollback`, `status`, `check`, `diff`, `list`, exit codes; (5) README, then end-to-end dogfood against the real Matt Pocock repo and the Gridmy skill.
- These decisions were resolved through a grill-me interview over the original `docs/PRD.md`; the eight-command set here intentionally adds `resolve` beyond that document's seven.
