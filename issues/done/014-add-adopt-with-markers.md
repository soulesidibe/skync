## Parent PRD

`issues/prd-simplified-add.md`

## What to build

Replace `skync add`'s current silent-adopt behavior (when `--dest` is non-empty) with a marker-based adoption that surfaces every divergence between dest and upstream and reuses the existing conflict/resolve flow.

Today, `add` on a non-empty dest leaves dest untouched and seeds `base` from current upstream HEAD. The user never sees what diverged and any upstream history between "when they originally vendored the folder" and "now" is silently baked into base, never to re-appear. The new behavior makes every divergence visible at adoption time so the user can accept or override it before the skill enters the synced state.

When `skync add <name>` runs against a non-empty dest, after the usual ref resolution and discovery, skync compares the resolved upstream tree against dest file by file:

- Identical: no-op.
- Both sides, text, different: write `<<<<<<< local / ... / ======= / ... / >>>>>>> upstream` conflict markers into the dest file (same marker style used by `update`).
- Both sides, binary or type mismatch: leave dest's version in place, flag as a non-marker pending-conflict (reuse the existing non-text classification from `treemerge`).
- Dest only: leave as-is, no markers (treated as a local addition).
- Upstream only: materialize into dest cleanly, no markers (treated as an upstream addition the user did not have).

Before any writes, snapshot dest under `.skync/backups/<name>/<ts>/` so the user can roll back to the pre-skync folder if they botch the resolve. Materialize base from upstream HEAD. Write `state.skills[name]` with `sha = upstream sha`, `pendingSha = upstream sha` (the signal that conflict resolution is needed), `pendingSnapshotTs = <snapshot>`.

If the comparison produces no markers and no non-text conflicts (dest already matches upstream apart from dest-only or upstream-only files), adopt cleanly with no pending state and exit 0.

If any markers or non-text conflicts were written, exit 2 with output naming the affected files. The user edits markers out (or accepts the local copy for non-text cases) and runs `skync resolve <name>`. The existing `resolve` command works unchanged: it verifies no markers remain, snapshots, and clears `pendingSha` + `pendingSnapshotTs`. The "advance base" step is a no-op since `base.sha` already equals `pendingSha`.

No new flag. This replaces today's silent-adopt path entirely. The current dim warning printed at adopt time ("changes made upstream before now are baked into base") is removed because the new behavior surfaces those changes as markers instead of baking them in.

## Acceptance criteria

- [ ] `add` on a non-empty dest no longer leaves dest untouched silently
- [ ] Identical files between dest and upstream produce no marker and no write
- [ ] Text files that differ between dest and upstream get git-style conflict markers written into the dest file, using `local` and `upstream` as the marker labels (matching `update`)
- [ ] Binary divergence and type mismatches leave dest's version in place and are flagged as non-marker pending-conflicts via the existing classification
- [ ] Files present only in dest are left as-is, no markers
- [ ] Files present only in upstream are materialized into dest cleanly, no markers
- [ ] A pre-write snapshot is taken under `.skync/backups/<name>/<ts>/` whenever any mutation will occur (markers or upstream-only materializations)
- [ ] Base is materialized to upstream HEAD on every adopt path
- [ ] On a conflict-producing adopt, `state.skills[name]` is written with `sha = pendingSha = <upstream sha>` and `pendingSnapshotTs = <snapshot ts>`
- [ ] On a no-conflict adopt, `state.skills[name]` is written with `sha = <upstream sha>` and no `pendingSha` / `pendingSnapshotTs`
- [ ] Exit code is 0 on no-conflict adopt and 2 on adopt with markers or non-text conflicts
- [ ] The output on conflict adopt names every affected file and tells the user to edit markers then run `skync resolve <name>`
- [ ] `skync resolve <name>` works against an adoption-pending skill without code change: verifies no markers, snapshots, clears pending fields (no base advance needed)
- [ ] The existing dim "baked into base" warning printed by today's adopt path is removed
- [ ] CLI tests cover: adopt with no divergence exits 0 clean; adopt with text divergence writes markers and exits 2; adopt with binary divergence flags non-marker pending-conflict and exits 2; adopt with upstream-only files materializes them; adopt with dest-only files leaves them; `resolve` clears the pending state for an adopted skill
- [ ] README's `add` reference and the Conflict workflow section are updated to describe the new adopt behavior
- [ ] WALKTHROUGH.md gains a short subsection (or extra step in Part B) showing the adopt-with-markers flow end to end

## Blocked by

None (independent of issues 013 / 012, but should land after 013 to avoid documentation churn on the `add` reference).

## User stories addressed

Reference by number from the parent PRD:

- User story 14 (refines: the adopt-vs-fresh behavior now surfaces divergences as markers instead of baking them in)
