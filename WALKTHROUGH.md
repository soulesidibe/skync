# Walkthrough

A hands-on tour of skync. Two parts: a happy path against a public repo, and a conflict-and-recovery flow against a local repo you set up yourself.

Prerequisites: skync installed (see [Install](README.md#install)) and a working `git` binary on your `PATH`. Familiarity with the [Concepts](README.md#concepts) section helps but is not required.

## Part A: happy path with a public repo

**Step 1. Preview what discovery would find.**

```sh
skync discover grill-me --repo https://github.com/mattpocock/skills
```

This is a read-only probe. It fetches the repo into skync's local cache, walks the tree, and prints the matching path if it finds exactly one:

```
skills/productivity/grill-me
```

Exit 0 on a single match. Exit 1 if there are zero matches or more than one (candidates listed on stderr). Nothing is written to your project. Use this before `add` when you want to confirm the path, or when a previous `add` failed because discovery found multiple matches.

**Step 2. Add the skill.**

```sh
skync add grill-me --repo https://github.com/mattpocock/skills
```

`--src` and `--dest` are both omitted on purpose. `add` runs discovery internally to resolve `--src` and defaults `--dest` to the Claude Code skill convention `.claude/skills/grill-me`. Both resolved values are recorded in the manifest exactly as if you had typed them. Output:

```
Added grill-me from skills at b8be62ffacb0
  skills/productivity/grill-me → .claude/skills/grill-me
```

After this command your project has:

```
.claude/skills/grill-me/SKILL.md   # the vendored skill files
skync.yaml                          # manifest: remote and skill entries
.skync/state.json                   # recorded SHA and sync metadata
.skync/base/grill-me/              # skync's copy of the upstream state (merge ancestor)
```

Commit `skync.yaml` alongside your project. The `.skync/` directory is local state; add it to `.gitignore` if you do not want to share it.

**Step 3. Inspect the fresh skill.**

```sh
skync list        # print all tracked skills with remote and src -> dest
skync check       # dry-run merge; reports up-to-date / clean-update / would-conflict
skync status      # local-vs-base diff; no network needed
skync diff grill-me  # unified diffs: local-vs-base and upstream-vs-base
```

On a fresh `add` against an unchanged upstream you will see:

```
# skync list
grill-me
  remote: skills
  skills/productivity/grill-me → .claude/skills/grill-me

# skync check
✓ grill-me [up-to-date] b8be62ffacb0

exit 0: 1 up-to-date

# skync status
✓ grill-me [clean]

# skync diff grill-me
grill-me
  local vs base:
    (no changes)
  upstream vs base (b8be62ffacb0):
    (no changes)
```

`check` exits 0 here (all skills up to date). `status` always exits 0 on a successful run.

**Step 4. Edit a file locally, then inspect again.**

```sh
echo "# My addition" >> .claude/skills/grill-me/SKILL.md
skync status
```

```
~ grill-me [modified] +0 ~1 -0
    ~ SKILL.md
```

`status` detects the local modification against base. Now run `check`:

```sh
skync check
```

```
✓ grill-me [up-to-date] b8be62ffacb0

exit 0: 1 up-to-date
```

Still `up-to-date`: `check` compares base against upstream, not dest. Your local edit is invisible to it until upstream also moves.

**Step 5. Update against an unchanged upstream.**

```sh
skync update grill-me
```

```
grill-me is up to date.
```

Exit 0. No snapshot is created (there is nothing to merge). Your local edit in `SKILL.md` is untouched.

---

## Part B: conflict and recovery with a local repo

This part uses a local git repo as the upstream so you control both sides.

**Step 1. Create a local upstream repo.**

Pick any path outside your project; the examples below use `~/skync-qa/upstream-repo`.

```sh
mkdir -p ~/skync-qa/upstream-repo/skills/qa-skill
```

Create `~/skync-qa/upstream-repo/skills/qa-skill/SKILL.md`:

```markdown
---
name: qa-skill
description: A skill for QA testing skync
---
# QA skill

This skill is used to test skync's three-way merge.

## Usage

Run this skill to test skync.
```

Create `~/skync-qa/upstream-repo/skills/qa-skill/notes.md`:

```markdown
# Notes

Initial notes.
```

Commit it:

```sh
cd ~/skync-qa/upstream-repo
git init
git add .
git commit -m "initial commit"
```

**Step 2. Add the skill.**

From your project directory:

```sh
skync add qa-skill --repo ~/skync-qa/upstream-repo
```

This vendors `skills/qa-skill` into `.claude/skills/qa-skill` (the default convention path) and seeds `.skync/base/qa-skill/` from the initial commit.

**Step 3. Apply a non-overlapping upstream change.**

Make a local edit first (so you can verify it survives the merge):

```sh
echo "" >> .claude/skills/qa-skill/SKILL.md
echo "## My local section" >> .claude/skills/qa-skill/SKILL.md
echo "" >> .claude/skills/qa-skill/SKILL.md
echo "I added this locally." >> .claude/skills/qa-skill/SKILL.md
```

Then commit an upstream change to `notes.md` (a different file, no overlap):

```sh
echo "" >> ~/skync-qa/upstream-repo/skills/qa-skill/notes.md
echo "## Updates" >> ~/skync-qa/upstream-repo/skills/qa-skill/notes.md
echo "" >> ~/skync-qa/upstream-repo/skills/qa-skill/notes.md
echo "Upstream appended this." >> ~/skync-qa/upstream-repo/skills/qa-skill/notes.md
cd ~/skync-qa/upstream-repo && git add . && git commit -m "upstream: update notes.md"
```

Run `check` to preview the outcome before applying:

```sh
skync check
```

```
↑ qa-skill [clean-update] 75461489817b

exit 1: 1 clean-update
```

Exit 1: a clean update is available. No conflicts. Now apply it:

```sh
skync update qa-skill
```

```
Updated qa-skill to 75461489817b
```

Exit 0. The upstream change to `notes.md` was applied. Your local edit to `SKILL.md` is still there. A snapshot was taken before the merge:

```sh
skync rollback qa-skill
```

```
Snapshots for qa-skill (newest first):
  1. 2026-05-24T19-41-03-177Z
```

The snapshot lives at `.skync/backups/qa-skill/<timestamp>/` and contains `dest/`, `base/`, and `meta.json`.

**Step 4. Restore a snapshot with rollback.**

```sh
skync rollback qa-skill --to 2026-05-24T19-41-03-177Z
```

(Use the timestamp printed by `skync rollback qa-skill` in the previous step.)

```
Restored qa-skill from 2026-05-24T19-41-03-177Z (sha efd7ccf6b285).
```

After a restore: `state.json` reverts to the snapshot's recorded SHA, dest and base are both restored, and a safety snapshot of the pre-rollback state is automatically added. Running `skync rollback qa-skill` again will show two entries: the safety snapshot and the original one.

**Step 5. Trigger a conflict.**

First, get back to the current upstream state:

```sh
skync update qa-skill
```

Now make a local edit that appends to `SKILL.md`, then commit an upstream change that also appends to `SKILL.md`:

```sh
echo "" >> .claude/skills/qa-skill/SKILL.md
echo "## My conflicting section" >> .claude/skills/qa-skill/SKILL.md
echo "" >> .claude/skills/qa-skill/SKILL.md
echo "I added this locally." >> .claude/skills/qa-skill/SKILL.md

echo "" >> ~/skync-qa/upstream-repo/skills/qa-skill/SKILL.md
echo "## Upstream conflicting section" >> ~/skync-qa/upstream-repo/skills/qa-skill/SKILL.md
echo "" >> ~/skync-qa/upstream-repo/skills/qa-skill/SKILL.md
echo "Upstream added this." >> ~/skync-qa/upstream-repo/skills/qa-skill/SKILL.md
cd ~/skync-qa/upstream-repo && git add . && git commit -m "upstream: append to SKILL.md"
```

Run `check`:

```sh
skync check
```

```
! qa-skill [would-conflict] 4948efd793dd on SKILL.md

exit 2: 1 would-conflict
```

Exit 2: a conflict would occur. Now run `update` to apply it:

```sh
skync update qa-skill
```

```
qa-skill has conflicts; markers written to dest.

Conflicts need resolving:
  qa-skill
    conflict markers in SKILL.md

Edit the markers out then run 'skync resolve <name>', or 'skync rollback <name>' to discard the update.
```

Exit 2. Open `.claude/skills/qa-skill/SKILL.md`; the conflicting section looks like:

```
<<<<<<< local
## My conflicting section

I added this locally.
=======
## Upstream conflicting section

Upstream added this.
>>>>>>> upstream
```

At this point `.skync/state.json` contains:

```json
"pendingSha": "4948efd793dd...",
"pendingSnapshotTs": "2026-05-24T19-41-39-676Z"
```

`pendingSha` records which upstream commit the markers came from. `pendingSnapshotTs` pins the pre-update snapshot so retention pruning cannot remove it until the conflict is resolved. Any non-overlapping upstream changes from the same `update` are already applied to dest, but base is left at the pre-update SHA. Everything stays pending until `resolve`.

**Step 6. Resolve the conflict.**

Edit `SKILL.md` by hand: remove the `<<<<<<<`, `=======`, and `>>>>>>>` lines and keep whichever content you want. Then:

```sh
skync resolve qa-skill
```

```
Resolved qa-skill at 4948efd793dd; base advanced.
```

`resolve` verifies no markers remain, snapshots the resolved state, re-materializes the pending upstream tree into base, advances `state.sha` to `pendingSha`, and clears `pendingSha` and `pendingSnapshotTs`. Running `resolve` again is a no-op:

```sh
skync resolve qa-skill
# qa-skill has no pending conflict; nothing to resolve.
```

If you want to discard the update entirely instead of resolving, run `skync rollback qa-skill --to <pendingSnapshotTs>` to restore the pre-update state.

### Adopting a pre-existing folder

Same conflict machinery, different trigger. If you point `skync add` at a `--dest` that already contains files, skync compares dest to upstream file-by-file (no base, since this is the first sync) and writes the result back through the same atomic swap `update` uses.

```sh
# A pre-existing folder you have been editing locally for a while.
mkdir -p vendor/grill-me
echo "my notes\n" > vendor/grill-me/SKILL.md
echo "local only\n" > vendor/grill-me/notes.md

skync add grill-me \
  --repo file:///path/to/some/skills-repo \
  --src skills/grill-me \
  --dest vendor/grill-me
```

What happens:

- Identical files are no-ops.
- Files only in dest stay (`notes.md` above).
- Files only in upstream materialize into dest.
- Text files that differ get git-style markers in place; the command exits `2`.
- Binary and type-mismatched divergences leave dest's bytes intact and surface as non-marker pending conflicts in the report; same exit `2`.

A pre-write snapshot is taken under `.skync/backups/grill-me/<ts>/` whenever the adopt mutates dest, so `skync rollback grill-me --to <ts>` reverts to the original folder. On a conflict adopt, `state.json` records `pendingSha = sha` and `pendingSnapshotTs = <ts>`; resolve the markers, then run `skync resolve grill-me` to clear the pending state (base is already at upstream HEAD, so resolve does not need to advance it).

---

See the [Commands](README.md#commands) reference for full per-command flags and the [Conflict workflow](README.md#conflict-workflow) section for the abbreviated version of part B.
