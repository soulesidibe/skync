## Parent PRD

`issues/prd-simplified-add.md`

## What to build

Make `--src` optional on `skync add`. When the user omits it, `add` calls the discovery module to resolve the source path inside the repo at the resolved SHA, then proceeds through the existing vendor/adopt flow exactly as if the user had typed the discovered path. The discovered path is frozen into `skync.yaml` and `state.json` exactly like a user-provided path, so all downstream commands (`update`, `check`, `diff`, etc.) keep operating against a recorded value with no awareness that discovery ran.

Discovery errors raised inside `add` convert to the existing validation-error type so the global exit-code handler maps them to exit 1. Error messages match the parent PRD's "Implementation decisions" section: zero-match names the repo URL and the short SHA; multiple-match lists every candidate path and tells the user to re-run with explicit `--src`.

An explicit `--src` still wins: when provided, discovery is skipped entirely.

## Acceptance criteria

- [ ] `--src` is no longer a required option on `add`
- [ ] When `--src` is omitted, `add` calls the discovery module with the resolved SHA
- [ ] The discovered path is written to `skync.yaml` and `state.json` exactly as if the user had typed it
- [ ] When `--src` is provided, discovery is not called and the explicit value is used
- [ ] Zero-match discovery error from `add` exits 1 with a message naming the repo URL and the short SHA
- [ ] Multiple-match discovery error from `add` exits 1 and lists every candidate path one per line, instructing the user to re-run with `--src`
- [ ] Existing fresh-vendor and adopt-existing-dest behaviors continue to work unchanged when discovery succeeds
- [ ] CLI tests cover: simplified `add` without `--src` vendors and freezes the discovered src; explicit `--src` skips discovery; zero match exits 1 with the documented message; multiple match exits 1 and lists candidates
- [ ] README `add` reference marks `--src` as optional and describes the discovery behavior

## Blocked by

- Blocked by `issues/011-discover-command.md`

## User stories addressed

Reference by number from the parent PRD:

- User story 2
- User story 6
- User story 8
- User story 9
- User story 10
