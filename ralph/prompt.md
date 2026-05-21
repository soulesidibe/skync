# DISCOVERY RULE
Any step that reads from disk — issues, commits, repo layout, manifests, READMEs, scripts — runs in a subagent. The main thread sees summaries only, never raw file contents. Do not call Read, Glob, or Grep directly.

# ISSUES
Use a general-purpose subagent to summarize open AFK tasks and recent work. The subagent MUST enumerate in-progress issues by scanning BOTH:

- `issues/inprogress/` in the main worktree, AND
- `.claude/worktree/*/issues/inprogress/` in every active worktree.

The summary must return two distinct lists: "open" (pickable) and "in progress" (NOT pickable). Issues marked HITL are NOT pickable by the loop; treat them as out of scope and exclude them from the "open" list. If it reports "No AFK tasks remaining," output <promise>NO MORE TASKS</promise> and stop.

# TASK SELECTION
From the issue summary, pick one task from the "open" list ONLY. Hard rules:
- Never pick an issue whose file lives in any `issues/inprogress/` folder (main worktree or any `.claude/worktree/*/issues/inprogress/`). An in-progress file means another worktree (or session) already owns that work; picking it would clobber their branch.
- Never pick a HITL issue.
- Respect each issue's `## Blocked by`: do not pick an issue whose blockers are not yet in `issues/done/`.

Before committing to a selection, re-verify the chosen issue is not in any inprogress folder and its blockers are all done. If you cannot confirm, treat it as in-progress and pick a different one.

Priority order within the open list:
1. Critical bugfixes
2. Development infrastructure (tests, types, dev scripts — precursors to features)
3. Tracer bullets — a tiny end-to-end slice through every layer, then expand
4. Polish and quick wins
5. Refactors

Once selected, derive:
- `<id>` — three-digit issue number from the filename (e.g. `004`).
- `<slug>` — the rest of the filename without `.md`, kebab-case (e.g. `treemerge-update-clean`).
- `<branch>` — `issue/<id>-<slug>`.
- `<worktree>` — `.claude/worktree/skync-issue-<id>` (inside the main repo, gitignored).

# WORKTREE
From the main repo root, run:

```
git worktree add <worktree> -b <branch> main
cd <worktree>
git mv issues/<id>-<slug>.md issues/inprogress/<id>-<slug>.md
git commit -m "issue/<id>: start work"
```

The `git mv` + commit marks the issue as in-progress. Triage scans `.claude/worktree/*/issues/inprogress/` to discover active work.

All subsequent steps (exploration, TDD, feedback loops, commit, issue-file move, push, PR) run inside `<worktree>`. Do NOT remove the worktree at the end — the user reviews the PR first and cleans up afterwards.

# EXPLORATION
Use the built-in Explore subagent (or spawn parallel general-purpose subagents) to investigate the parts of the codebase relevant to the chosen task. Each must return only architectural facts and file pointers — not file contents.

# PLAN
From the exploration findings, the main thread writes a concrete implementation plan: files to touch, modules involved (Manifest, RemoteCache, TreeMerge, StateStore, CLI), the test strategy, and which acceptance criteria each step maps to.

# PLAN REVIEW
Before showing the plan to the user, have it reviewed. Spawn the `Plan` agent (and a `general-purpose` agent for a second angle when the surface is broad) in parallel, briefing each with the issue, the exploration findings, and the draft plan. Scope the review to whatever the task touches: module boundaries and deep-module testability, the three-way-merge correctness rules, atomicity/temp-swap, and the manifest/state contracts in `issues/prd.md`.

Fold the reviewers' feedback into the plan. Then show the user:
1. The final, updated plan.
2. A short changelog of what the reviewers added or changed versus the draft.

Wait for the user to explicitly approve before moving to implementation. If the user rejects or asks for changes, revise and show again. Do not start implementation without explicit approval.

# IMPLEMENTATION
This is a single-stack Node/TypeScript project; the main thread does the implementation directly, using `/tdd` to drive test-first work. There is no platform-specific delegation. Keep the deep modules (TreeMerge, RemoteCache) pure and isolated per the PRD so they stay unit-testable.

# FEEDBACK LOOPS
Discover the project's commands via a subagent inspecting `package.json` and any README/scripts. For skync the loops are:

```
npm run build      # tsc typecheck + compile
npm test           # vitest run
```

Run them in the main thread. If one fails, fix the underlying issue — never skip.

# REVIEW
Once the implementation passes the feedback loops and the user has signed off on QA, run a review before committing. Use the `code-review` skill (or spawn a `general-purpose` reviewer) briefed with the file paths and the PR diff. Focus on: merge correctness (clean / non-overlap / true conflict / delete-vs-modify), binary and CRLF/LF handling, atomic temp-swap, state and backup integrity, exit codes, and reuse of existing modules over duplication.

The reviewer returns blockers + nits + go/no-go. Address blockers (and significant nits) before committing. Bundle fixes into the same commit when possible; if review surfaces issues that warrant a separate iteration, capture them as new issues in `issues/` rather than letting them ship.

# COMMIT
One git commit. Message must include:
1. Key decisions
2. Files changed
3. Blockers / notes for next iteration

# THE ISSUE FILE
If complete → `git mv issues/inprogress/<id>-<slug>.md issues/done/<id>-<slug>.md` (still on the worktree branch; the move is part of the same commit or a follow-up commit before push).
If not (paused mid-stream) → leave the file in `issues/inprogress/` and append a note describing what was done and why it paused. The user moves it back to `issues/` when ready to drop the worktree.

"Complete" here means the implementation satisfies the acceptance criteria. The PR is the review gate; merge happens later.

# PUSH AND PR
After the commit (and any issue-file move commit), still inside `<worktree>`:

```
git push -u origin <branch>
```

Build the PR body in a temp file with these sections, then open a PR:

- **Summary** — one or two sentences on what changed and why.
- **Acceptance criteria** — copy the issue's `## Acceptance criteria` checklist verbatim, with each box checked or unchecked to reflect what this PR actually delivers.
- **Tests added** — list the new or modified test files and what they assert. If no tests were added (rare; justify), say so.
- **Issue** — relative link to the issue file at its current location (`issues/done/<filename>` if complete, otherwise `issues/inprogress/<filename>`).

Open the PR:

```
gh pr create \
  --title "issue/<id>: <one-line summary>" \
  --body-file <tmp>
```

Print the PR URL on success.

# FINAL RULES
- Work on a SINGLE task.
- Discovery in subagents. Main thread orchestrates and implements.
- Never pick HITL issues or issues whose blockers are not yet done.
- Sentence case in PR titles, bodies, and commits.
- No em dashes or en dashes in any text written.
- Do not add Claude Code co-authorship to commits.
- Do not remove the worktree.
