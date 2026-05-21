## Parent PRD

`issues/prd.md`

## What to build

Extend `skync update` to handle overlapping conflicts. Where upstream and local
changed the same region, write git-style conflict markers in place into the
conflicted `dest` files (clean files still apply), report per skill exactly which
files carry markers, and do NOT advance base. A file deleted on one side but
modified on the other is reported as a conflict, never a silent delete (renames
are delete+add in v1). `update` refuses to run on a skill that still has
unresolved conflict markers, directing the user to `resolve` or `rollback`. See
the PRD "Implementation Decisions" (TreeMerge conflict semantics) and
"Testing Decisions".

## Acceptance criteria

- [ ] Overlapping changes produce git-style markers in place in the affected `dest` files.
- [ ] Output names each conflicted skill and the specific files with markers.
- [ ] Base is not advanced when any conflict occurs.
- [ ] A file deleted on one side and modified on the other is a conflict, not a silent delete.
- [ ] `update` refuses to run on a skill with unresolved markers and points to `resolve`/`rollback`.
- [ ] TreeMerge unit tests cover true overlapping conflict (markers emitted) and delete-on-one-side/modify-on-other.

## Blocked by

- Blocked by `issues/004-treemerge-update-clean.md`

## User stories addressed

- User story 10
- User story 15
- User story 20
