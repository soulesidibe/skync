## Parent PRD

`issues/prd.md`

## What to build

Extend `skync add` to handle the core problem-statement case: a `dest` that
already contains a locally-modified skill. Instead of overwriting, adopt the
existing `dest` as the local copy and populate `base/<skill>/` from current
upstream, so the first later `update` is a true three-way merge. Surface the
documented limitation that upstream changes predating `add` are baked into base.
See the PRD "Solution" and "Implementation Decisions" sections.

## Acceptance criteria

- [ ] `skync add` with an existing non-empty `dest` leaves `dest` untouched and adopts it as local.
- [ ] `base/<skill>/` is populated from the current upstream SHA; `state.json` records that SHA.
- [ ] `skync add` with an absent `dest` still vendors fresh (behavior from issue 002 unchanged).
- [ ] Output communicates the adopt path and the predating-changes limitation.

## Blocked by

- Blocked by `issues/002-add-fresh-vendor.md`

## User stories addressed

- User story 1
- User story 2
