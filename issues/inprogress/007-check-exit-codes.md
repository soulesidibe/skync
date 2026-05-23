## Parent PRD

`issues/prd.md`

## What to build

The `skync check` command. Fetch remotes (re-resolving each `ref` to its current
SHA) and, without modifying any files, compute a dry-run three-way merge in
memory to classify each skill as up-to-date, clean-update-available, or
would-conflict. Print a per-skill summary. Return scheduler-friendly exit codes:
`0` all up to date, `1` clean updates available, `2` at least one would conflict,
and a distinct higher code for git/network/operational errors. See the PRD
"Implementation Decisions" (command set, exit codes).

## Acceptance criteria

- [ ] `skync check` modifies no files (read-only) and reports per-skill status.
- [ ] Status reflects a real in-memory dry-run merge (up-to-date / clean update / would conflict).
- [ ] Exit code is `0` up-to-date, `1` clean updates available, `2` would conflict.
- [ ] Git/network/operational failures return a distinct higher exit code, not `2`.

## Blocked by

- Blocked by `issues/004-treemerge-update-clean.md`

## User stories addressed

- User story 7
- User story 8
