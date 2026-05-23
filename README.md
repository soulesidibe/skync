# skync

Track and sync skill folders vendored from git repos using a three-way merge.

skync is a small CLI that lets you adopt a folder from a remote repo (a "skill"), keep a local working copy, and pull upstream updates safely. Clean upstream changes apply silently; overlapping edits raise git-style conflict markers you resolve by hand. Every update takes a backup snapshot first, so any change is reversible.

## Status

Pre-release (`0.1.0`). Not yet published to npm. The `npx skync` invocation below is the target install story; for now, build from source.

## Install

From source:

```sh
git clone https://github.com/soulesidibe/skync
cd skync
npm install
npm run build
npm link        # adds the `skync` binary to your PATH
```

Or run the built CLI directly without linking:

```sh
node /path/to/skync/dist/cli.js <command> ...
```

Requires Node `>=18`. A working `git` binary on your PATH is required at runtime.

Once published, the install will be:

```sh
npx skync <command> ...
```

## Quick start

Adopt the `grill-me` skill from Matt Pocock's skills repo into a local project:

```sh
skync add grill-me \
  --repo https://github.com/mattpocock/skills \
  --src skills/productivity/grill-me \
  --dest .claude/skills/grill-me
```

That fetches the upstream tree, vendors it at `.claude/skills/grill-me`, and records the skill in `skync.yaml`. Later, pull in any upstream changes:

```sh
skync update grill-me
```

Edit files under `.claude/skills/grill-me` freely; skync only treats overlapping changes as conflicts.

## Commands

| Command | Purpose | Exit codes |
| --- | --- | --- |
| `add <name>` | Register and vendor a new skill | 0 success, 1 error |
| `list` | List tracked skills | 0 |
| `check [name]` | Dry-run merge; scheduler-friendly | 0/1/2/3 (see below) |
| `status [name]` | Local-vs-base modifications | 0 (errors via global handler) |
| `diff <name>` | Show local-vs-base and upstream-vs-base diffs | 0 success, 1 error |
| `update [name]` | Pull non-overlapping upstream changes | 0 clean, 1 error, 2 conflicts |
| `resolve <name>` | Mark a conflicted skill resolved, advance base | 0 success, 1 error |
| `rollback <name> [--to <ts>]` | List or restore backup snapshots | 0 success, 1 error |

All commands accept `--help` for full usage.

### `add <name>`

```
skync add <name> --repo <url> --src <path> --dest <path>
                 [--remote <name>] [--ref <ref>] [--global]
```

Vendor a new skill from a remote repo.

- `--repo <url>` git URL of the upstream repo (required)
- `--src <path>` path inside the repo to vendor (required)
- `--dest <path>` local destination for the vendored copy (required)
- `--remote <name>` override the auto-derived remote name in the manifest
- `--ref <ref>` branch, tag, or commit to pin (default: remote HEAD)
- `--global` write to the global manifest and state instead of the project's

If `--dest` does not exist or is empty, skync vendors fresh and seeds the base tree from upstream. If `--dest` already contains files, skync adopts them as-is and seeds base from the current upstream commit, so any difference between dest and base shows up as a local modification. Upstream changes that predate the `add` are baked into base and will not re-apply on the first `update`.

### `list`

```
skync list
```

Print every skill from the project manifest (`./skync.yaml`) and the global manifest (`~/.config/skync/manifest.yaml`), with the upstream remote and `src → dest` paths. Project entries shadow global entries with the same name.

### `check [name]`

```
skync check [name] [--global]
```

Dry-run merge per skill. Reads upstream into memory only; writes nothing.

Per-skill status is one of:

- `up-to-date` (no upstream changes)
- `clean-update` (upstream changes apply cleanly)
- `would-conflict` (upstream and local overlap)
- `pending-conflict` (conflict from a previous `update` not yet resolved)

Exit codes are designed for schedulers:

- `0` all skills up to date
- `1` at least one clean update available, no conflicts
- `2` at least one would-conflict or pending-conflict
- `3` operational error (manifest invalid, fetch failed, missing state entry, etc.)

This is the only command that uses exit code `3`; everything else uses `1` for operational errors.

### `status [name]`

```
skync status [name] [--global]
```

Read-only summary of local-vs-base modifications and pending-conflict state, per skill. Output shows added / modified / deleted counts and an indented per-file list.

`status` always exits `0` on a successful run. Genuine operational errors still surface through the global error handler with exit `1`.

### `diff <name>`

```
skync diff <name>
```

Show two unified-diff sections for one skill: local-vs-base, then upstream-vs-base. Fetches upstream into the cache; if the network or git step fails, exits `1` rather than printing a partial diff.

### `update [name]`

```
skync update [name] [--ref <ref>] [--global] [--keep <n>]
```

Three-way merge upstream changes into each tracked skill's destination.

- `[name]` optional positional; update all skills if omitted
- `--ref <ref>` update to a specific branch, tag, or commit instead of the remote's recorded ref
- `--global` only update globally tracked skills
- `--keep <n>` retain at most this many backup snapshots per skill (default `10`)

Behavior:

1. Snapshot the live copy under `<state-dir>/backups/<skill>/<ts>/` before changing anything.
2. Three-way merge `base` → `upstream` into `dest`. Non-overlapping upstream changes apply silently.
3. On clean merge, advance `base` to the upstream tree and update `state.json`.
4. On overlap, write git-style conflict markers into the affected files, set `pendingSha` on the skill, and leave `base` untouched. The snapshot taken in step 1 is preserved across retention pruning so you can always roll back the failed update.

If the live copy still contains unresolved conflict markers from an earlier run, `update` refuses to start.

Exit codes: `0` clean, `1` operational error, `2` completed with at least one conflict awaiting resolution.

### `resolve <name>`

```
skync resolve <name> [--keep <n>]
```

Mark a conflicted skill resolved. Verifies no `<<<<<<<` / `=======` / `>>>>>>>` markers remain in the destination, snapshots the resolved copy, re-materializes the pending upstream into `base`, advances `state.sha`, and clears `pendingSha`. Idempotent: running `resolve` on a skill with no pending conflict exits `0` with a no-op message.

Non-text conflicts (binary changes, delete-vs-modify, type changes) leave no markers in the destination. `resolve` accepts the current dest as the chosen side for these cases.

### `rollback <name> [--to <ts>]`

```
skync rollback <name>
skync rollback <name> --to <timestamp>
```

Without `--to`, lists available snapshots newest-first. With `--to`, validates the timestamp, takes a safety snapshot of the current state, then atomically restores `dest`, `base`, and the state entry from the snapshot.

Timestamps look like `2026-05-23T14-07-42-318Z` (the on-disk subdirectory name under `<state-dir>/backups/<skill>/`).

## Manifest

skync reads two manifests:

- Project: `./skync.yaml` (commit this alongside the project)
- Global: `~/.config/skync/manifest.yaml`

Commands that accept `--global` (`add`, `update`, `check`, `status`) operate on the global manifest and global state when the flag is passed. Commands without `--global` (`resolve`, `diff`, `rollback`, `list`) work across both scopes or take their scope from the skill's recorded location.

Manifest shape (YAML):

```yaml
remotes:
  mattpocock:
    repo: https://github.com/mattpocock/skills
    ref: main           # optional; default branch if omitted

skills:
  - name: grill-me
    remote: mattpocock
    src: skills/productivity/grill-me
    dest: .claude/skills/grill-me
```

`skync add` writes the right entries for you; you can also edit the file by hand.

## Conflict workflow

When `update` finds overlap between upstream and your local edits:

1. The affected files get git-style conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`). `update` exits `2`.
2. Open each marked file, choose the right content, and remove the markers.
3. Run `skync resolve <name>`. It verifies no markers remain, snapshots the resolved copy, advances `base` to the pending upstream commit, and clears the pending flag.

For non-text conflicts (binary changes, delete-vs-modify, type changes), no markers are written. The local copy is left as-is and `resolve` records that as the chosen side.

If something went wrong, `skync rollback <name>` lists snapshots and `skync rollback <name> --to <ts>` restores one.

## Backups and retention

Every `update`, `resolve`, and `rollback` snapshots the destination before mutating it. Snapshots live under:

```
<state-dir>/backups/<skill-name>/<timestamp>/
```

Where `<state-dir>` is `./.skync/` for project skills and `~/.config/skync/.skync/` for global skills.

`--keep <n>` on `update` and `resolve` controls retention; the default is `10`. The snapshot taken right before a failed update is pinned (`pendingSnapshotTs` in state), so it survives retention pruning until the conflict is resolved.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Operational error (validation, manifest, IO, git) |
| `2` | `update`: completed with conflicts. `check`: would-conflict or pending-conflict found |
| `3` | `check`: operational error (so a scheduler can distinguish it from the conflict signal) |

`status` always exits `0` on a successful run; operational errors still go through the global handler at `1`.

## Troubleshooting

- **`pending-conflict` reported by `check` or `update`**. A previous `update` left conflict markers. Edit them out and run `skync resolve <name>`.
- **`interrupted-swap` artifact**. A previous mutation crashed partway through the atomic temp-swap. Inspect the leftover `*.skync-tmp-*` entries under `dest` / `base`, then re-run the failing command (skync detects the artifact and refuses to write over it).
- **`dest-missing`**. `status` or `check` found a tracked skill whose destination no longer exists. Either restore from a snapshot (`skync rollback`) or re-`add` to vendor fresh.
- **`git` not found**. Install git and make sure it's on your `PATH`; skync shells out for every fetch.

## How it works

skync is built from four small modules:

- **Manifest**: reads and writes `skync.yaml`.
- **StateStore**: owns `state.json`, snapshots, and atomic temp-swap commits.
- **RemoteCache**: wraps `git` to fetch sparse subpaths into a per-remote cache.
- **TreeMerge**: pure three-way merge over file trees, with text conflict markers and explicit non-text classification.

See [`issues/prd.md`](issues/prd.md) for the full design and v1 scope.

## Project status

v1, single-developer project. Out of scope for v1: rename detection, scheduling, a GUI, and any non-Node runtime. See the PRD for the full out-of-scope list.
