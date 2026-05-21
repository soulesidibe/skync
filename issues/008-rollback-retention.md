## Parent PRD

`issues/prd.md`

## What to build

The `skync rollback <name> [--to <timestamp>]` command plus backup retention.
`rollback` restores a skill's `dest` from a backup snapshot, listing available
snapshots when `--to` is omitted. Retention keeps the last N snapshots per skill
(default 10, configurable via `--keep`), auto-prunes older ones after a
successful update, and never prunes a snapshot that a pending unresolved conflict
depends on. See the PRD "Implementation Decisions" (StateStore) and
"Testing Decisions".

## Acceptance criteria

- [ ] `skync rollback <name>` without `--to` lists available snapshots.
- [ ] `skync rollback <name> --to <timestamp>` restores that snapshot into `dest`.
- [ ] Retention keeps exactly the last N (default 10, `--keep` override) and prunes older after a successful update.
- [ ] A snapshot a pending conflict relies on is never pruned.
- [ ] StateStore unit tests cover retention keeping the last N and never pruning a pending-conflict snapshot.

## Blocked by

- Blocked by `issues/004-treemerge-update-clean.md`

## User stories addressed

- User story 16
- User story 23
