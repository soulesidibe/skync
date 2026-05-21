## Parent PRD

`issues/prd.md`

## What to build

The foundational tracer bullet: a buildable TypeScript CLI that resolves
manifests end-to-end. `skync list` runs via the `commander` entry point, loads
and merges the project manifest (`./skync.yaml`) and global manifest
(`~/.config/skync/manifest.yaml`) with project precedence on name clashes,
expands `~` and project-relative `dest` paths, validates the YAML shape, and
prints the tracked skills (empty list when none). This establishes the
**Manifest** module and the **CLI** glue layer described in the PRD
"Implementation Decisions" section.

## Acceptance criteria

- [ ] `npm run build` compiles cleanly and `skync` runs via the `bin` entry.
- [ ] `skync list` loads project + global manifests and prints tracked skills (or an empty-state message).
- [ ] Project manifest entries override global entries on name clash.
- [ ] `dest` values support `~` expansion and project-relative paths.
- [ ] Malformed manifest YAML produces a clear validation error, not a stack trace.
- [ ] Manifest module unit tests cover precedence, auto-remote dedup helpers, `~` expansion, and validation errors.

## Blocked by

None - can start immediately.

## User stories addressed

- User story 19
- User story 24
- User story 26
