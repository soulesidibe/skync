## Parent PRD

`issues/prd.md`

## What to build

The **TreeMerge** core exercised end-to-end via `skync update [name]` for the
clean-merge path. TreeMerge is a pure function taking base, upstream, and local
file trees and returning a merged tree plus a conflict report: path-set
reconciliation, non-conflicting structural changes applied directly, `node-diff3`
on files modified on both sides, NUL-byte text/binary classification (binary uses
byte equality), and in-memory CRLF→LF normalization for diffing while preserving
the local newline style on write. `update` snapshots local to
`backups/<skill>/<timestamp>/` first, computes the full merged tree into a temp
staging dir, then atomically swaps it into `dest`. Base advances on a clean merge.
This slice covers only non-overlapping/auto-merge outcomes; overlapping conflicts
are issue 005. See the PRD "Implementation Decisions" and "Testing Decisions".

## Acceptance criteria

- [ ] `skync update` applies non-overlapping upstream changes with no prompts.
- [ ] Local copy is snapshotted to `backups/` before any merge.
- [ ] The merge is staged in a temp dir and swapped into `dest` atomically (crash leaves `dest` fully old or fully new).
- [ ] Base advances to the upstream SHA only on a clean merge.
- [ ] Binary files use byte equality and are never line-merged or corrupted.
- [ ] CRLF-vs-LF differences do not cause spurious conflicts; local newline style is preserved on write; no on-disk reformatting.
- [ ] TreeMerge unit tests cover clean merge, non-overlapping changes, binary-changed-both-sides, and CRLF/LF inputs.
- [ ] StateStore unit tests cover snapshot/restore round-trip and temp-then-rename leaving no partial state.

## Blocked by

- Blocked by `issues/002-add-fresh-vendor.md`

## User stories addressed

- User story 9
- User story 11
- User story 12
- User story 13
- User story 21
- User story 22
