## Parent PRD

`issues/prd.md`

## What to build

The `skync resolve <name>` command. After the user manually edits conflict
markers out of `dest`, `resolve` verifies no markers remain, snapshots the
current local copy to `backups/`, then advances `base` to the pending upstream
SHA and updates `state.json`. This makes the "re-running update after resolution
remains correct" guarantee real. See the PRD "Implementation Decisions"
(command set).

## Acceptance criteria

- [ ] `skync resolve <name>` errors if conflict markers still remain in `dest`.
- [ ] On success it snapshots local, advances base to the pending upstream SHA, and updates `state.json`.
- [ ] After `resolve`, a subsequent `update` against unchanged upstream reports up-to-date (no re-introduced markers).

## Blocked by

- Blocked by `issues/005-update-conflict-handling.md`

## User stories addressed

- User story 14
