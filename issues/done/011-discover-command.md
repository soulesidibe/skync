## Parent PRD

`issues/prd-simplified-add.md`

## What to build

A new `skync discover <name> --repo <url> [--ref <ref>]` command and the underlying discovery module that powers it. The command clones the upstream into the existing remote cache, resolves the ref, walks the tree at that SHA, and reports the folder that matches the skill name by the intersection rule (folder basename equals `<name>` AND `SKILL.md` frontmatter `name:` equals `<name>`). It writes nothing to manifests or state.

The discovery module is a deep, standalone unit: one async entry point that takes a repo path, a SHA, and a skill name and returns a single resolved path or throws a typed error distinguishing zero matches from multiple matches (carrying the candidate list in the multiple case). Internally it walks the tree via `git ls-tree -r --name-only <sha>`, reads candidate `SKILL.md` files via `git show <sha>:<path>`, parses YAML frontmatter, and applies the directory denylist (`.git`, `node_modules`, `dist`, `build`, `target`, `.venv`) to any segment of the path.

See the parent PRD's "Implementation decisions" section for the exact discovery rule, denylist handling, and error message shape.

## Acceptance criteria

- [ ] Discovery module exists with a single async entry point and a typed error class distinguishing zero-match from multiple-match outcomes
- [ ] Module walks the tree at a SHA via `git ls-tree` and reads candidate files via `git show`; no on-disk extraction
- [ ] Module applies the directory denylist to any segment of a candidate path
- [ ] Module rejects SKILL.md files with missing frontmatter, no closing fence, non-object frontmatter, or missing/non-matching `name:` field
- [ ] `skync discover <name> --repo <url>` is wired into the CLI
- [ ] `discover` accepts `--ref <ref>` and defaults to remote HEAD
- [ ] `discover` exits 0 on a single match and prints the resolved path
- [ ] `discover` exits 1 on zero matches with a message naming the repo URL and the short SHA
- [ ] `discover` exits 1 on multiple matches and prints each candidate path one per line
- [ ] `discover` writes nothing to any manifest or state file
- [ ] Unit tests cover: exact intersection match, folder-name match with frontmatter mismatch, frontmatter match with folder-name mismatch, missing frontmatter, two matches at different depths, denylisted directories ignored at any depth, repo-root SKILL.md ignored
- [ ] CLI tests cover: single-match exit 0, zero-match exit 1, multiple-match exit 1, `--ref` honored
- [ ] README gains a short `discover` section describing the intersection rule and exit codes

## Blocked by

None - can start immediately.

## User stories addressed

Reference by number from the parent PRD:

- User story 5
- User story 11
- User story 12
- User story 13
- User story 16
- User story 17
- User story 18
