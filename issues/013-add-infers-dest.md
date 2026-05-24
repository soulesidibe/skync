## Parent PRD

`issues/prd-simplified-add.md`

## What to build

Make `--dest` optional on `skync add`. When the user omits it, `add` derives the destination from the Claude Code skill convention: `.claude/skills/<name>` for a project add, `~/.claude/skills/<name>` when `--global` is set. The derived value is written into `skync.yaml` and `state.json` exactly as if the user had typed it, so the existing global-dest validation (which requires `~/`-anchored or absolute paths) is satisfied and all downstream commands continue to operate against a recorded value.

An explicit `--dest` still wins: when provided, derivation is skipped and the existing adopt-vs-fresh logic runs against the user-supplied path. The existing adopt-existing-dest behavior continues to apply when the derived destination already contains files (so simplified `add` never destroys edits the user made before tracking the skill).

With both `--src` and `--dest` now optional, the headline form `skync add <name> --repo <url>` works end-to-end. The README quick-start is updated to that headline form and the verbose form moves to an "Overrides" subsection under the `add` reference.

## Acceptance criteria

- [ ] `--dest` is no longer a required option on `add`
- [ ] When `--dest` is omitted on a project add, the derived value is `.claude/skills/<name>` relative to the manifest base dir
- [ ] When `--dest` is omitted with `--global`, the derived value is `~/.claude/skills/<name>`
- [ ] The derived value is written to `skync.yaml` and `state.json` exactly as if the user had typed it
- [ ] When `--dest` is provided, derivation is not called and the explicit value is used
- [ ] The headline form `skync add <name> --repo <url>` (no `--src`, no `--dest`) succeeds end-to-end against a real repo and produces the vendored skill at the convention path
- [ ] Adopt-existing-dest behavior still applies when the derived destination already contains files
- [ ] CLI tests cover: simplified `add` vendors to `.claude/skills/<name>`; `add --global` vendors to `~/.claude/skills/<name>` with a test-overridden HOME; explicit `--dest` skips derivation; adopt-existing-dest still works on the derived path
- [ ] README quick-start example is replaced with the simplified one-line form
- [ ] README `add` reference marks `--dest` as optional and documents the convention paths
- [ ] Verbose `--repo`/`--src`/`--dest` example is retained under an "Overrides" subsection of the `add` reference

## Blocked by

- Blocked by `issues/012-add-infers-src.md`

## User stories addressed

Reference by number from the parent PRD:

- User story 1
- User story 3
- User story 4
- User story 7
- User story 14
- User story 15
