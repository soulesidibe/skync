## Parent PRD

`issues/prd.md`

## What to build

The `skync status` and `skync diff <name>` commands. `status` shows each tracked
skill's local modifications versus base and any pending conflicts (files still
carrying markers). `diff <name>` shows the local-vs-base and upstream-vs-base
diffs. Both are read-only reporting commands over the existing base/local/state.
See the PRD "Implementation Decisions" (command set).

## Acceptance criteria

- [ ] `skync status` lists local-vs-base modifications per skill and flags skills with pending conflicts.
- [ ] `skync diff <name>` shows local-vs-base and upstream-vs-base diffs.
- [ ] Both commands are read-only and modify no files.

## Blocked by

- Blocked by `issues/004-treemerge-update-clean.md`

## User stories addressed

- User story 17
- User story 18
