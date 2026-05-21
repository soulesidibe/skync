## Parent PRD

`issues/prd.md`

## What to build

Phase 5: write the README and run skync end-to-end against the real Matt Pocock
repo and the Gridmy skill. This is the HITL slice: it requires resolving the open
empirical items (the exact repo URL and the path to the Gridmy skill inside it)
and human judgment on whether the dogfood result is acceptable. Exercise the full
lifecycle: `add` (adopt an existing modified copy), `check`, `update` (clean and
conflicting), `resolve`, `rollback`, `status`, `diff`, `list`. See the PRD
"Further Notes" (build phases, open items).

## Acceptance criteria

- [ ] README documents installation (`npx skync`), the manifest format, every command, and the conflict/resolve/rollback workflow.
- [ ] The real Matt Pocock repo URL and Gridmy skill path are confirmed and recorded.
- [ ] End-to-end run against the real repo: add → modify locally → check → update (clean) → update (forced conflict) → resolve → rollback succeeds.
- [ ] A human reviews and signs off on the dogfood outcome.

## Blocked by

- Blocked by `issues/003-add-adopt-existing-dest.md`
- Blocked by `issues/005-update-conflict-handling.md`
- Blocked by `issues/006-resolve-command.md`
- Blocked by `issues/007-check-exit-codes.md`
- Blocked by `issues/008-rollback-retention.md`
- Blocked by `issues/009-status-diff.md`

## User stories addressed

- Open items (Matt Pocock repo URL and Gridmy skill path) from the parent PRD "Further Notes"
