## Parent PRD

`issues/prd.md`

## What to build

`skync add <name> --repo <url> --src <path> --dest <path>` for a skill whose
`dest` does not yet exist. Cuts end-to-end through the CLI, the **Manifest**
auto-remote management (reuse-or-create a named remote from the repo slug,
with optional `--remote`/`--ref` overrides), the **RemoteCache** module
(cached bare clone per remote, `blob:none` partial clone + sparse-checkout of
`src`, resolve `ref` to a concrete commit SHA, materialize the `src` subtree),
and the **StateStore** (populate `base/<skill>/` and the live `dest`, write
`state.json` with the synced SHA via temp+rename). State directory is paired
with the owning manifest (`./.skync/` for project, `~/.config/skync/.skync/`
for global). See the PRD "Implementation Decisions" for module details.

## Acceptance criteria

- [ ] `skync add` for a new skill fetches upstream and writes the `src` tree into `dest`.
- [ ] A matching remote URL is reused; otherwise a remote is auto-created and named from the repo slug (deduped). `--remote`/`--ref` override.
- [ ] `ref` (branch, tag, or SHA) is resolved to a concrete commit; `state.json` records that SHA.
- [ ] Skills sharing a repo share one cached clone under the state directory.
- [ ] State lands under `./.skync/` for a project skill and `~/.config/skync/.skync/` for a global skill.
- [ ] A missing system `git` binary produces a clear, actionable error.
- [ ] RemoteCache unit tests against a local fixture repo cover ref→SHA resolution, sparse materialization of `src`, and re-fetch after the fixture advances.

## Blocked by

- Blocked by `issues/001-scaffold-cli-manifest.md`

## User stories addressed

- User story 3
- User story 4
- User story 5
- User story 6
- User story 27
