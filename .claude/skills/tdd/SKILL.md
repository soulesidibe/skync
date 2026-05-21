---
name: tdd
description: Test-driven development with red-green-refactor loop. Use when user wants to build features or fix bugs using TDD, mentions "red-green-refactor", wants integration tests, or asks for test-first development.
---

# Test-Driven Development

## Philosophy

**Core principle**: Tests should verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't.

**Good tests** are integration-style: they exercise real code paths through public APIs. They describe _what_ the system does, not _how_ it does it. A good test reads like a specification - "user can checkout with valid cart" tells you exactly what capability exists. These tests survive refactors because they don't care about internal structure.

**Bad tests** are coupled to implementation. They mock internal collaborators, test private methods, or verify through external means (like querying a database directly instead of using the interface). The warning sign: your test breaks when you refactor, but behavior hasn't changed. If you rename an internal function and tests fail, those tests were testing implementation, not behavior.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Anti-Pattern: Horizontal Slices

**DO NOT write all tests first, then all implementation.** This is "horizontal slicing" - treating RED as "write all tests" and GREEN as "write all code."

This produces **crap tests**:

- Tests written in bulk test _imagined_ behavior, not _actual_ behavior
- You end up testing the _shape_ of things (data structures, function signatures) rather than user-facing behavior
- Tests become insensitive to real changes - they pass when behavior breaks, fail when behavior is fine
- You outrun your headlights, committing to test structure before understanding the implementation

**Correct approach**: Vertical slices via tracer bullets. One test → one implementation → repeat. Each test responds to what you learned from the previous cycle. Because you just wrote the code, you know exactly what behavior matters and how to verify it.

```
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3
  ...
```

## Workflow

### 1. Planning

Before writing any code:

- [ ] Confirm with user what interface changes are needed
- [ ] Confirm with user which behaviors to test (prioritize)
- [ ] Identify opportunities for [deep modules](deep-modules.md) (small interface, deep implementation)
- [ ] Design interfaces for [testability](interface-design.md)
- [ ] List the behaviors to test (not implementation steps)
- [ ] Get user approval on the plan

Ask: "What should the public interface look like? Which behaviors are most important to test?"

**You can't test everything.** Confirm with the user exactly which behaviors matter most. Focus testing effort on critical paths and complex logic, not every possible edge case.

### 2. Tracer Bullet

Write ONE test that confirms ONE thing about the system:

```
RED:   Write test for first behavior → test fails
GREEN: Write minimal code to pass → test passes
```

This is your tracer bullet - proves the path works end-to-end.

### 3. Incremental Loop

For each remaining behavior:

```
RED:   Write next test → fails
GREEN: Minimal code to pass → passes
```

Rules:

- One test at a time
- Only enough code to pass current test
- Don't anticipate future tests
- Keep tests focused on observable behavior

### 4. Refactor

After all tests pass, look for [refactor candidates](refactoring.md):

- [ ] Extract duplication
- [ ] Deepen modules (move complexity behind simple interfaces)
- [ ] Apply SOLID principles where natural
- [ ] Consider what new code reveals about existing code
- [ ] Run tests after each refactor step

**Never refactor while RED.** Get to GREEN first.

### 5. QA handoff

Automated tests cover what's cheap to test. They don't cover real device interaction, live LLM output, full CLI ergonomics, or anything else where setup is expensive or output is non-deterministic. Before committing, hand the user a structured brief they can run by hand.

Build the brief from:

- the issue's acceptance criteria, one check per criterion the automated tests don't already cover end-to-end
- behaviors you implemented but couldn't verify in pytest (anything touching the device, the network, the LLM, or stdout/stderr that argparse owns)
- any composability check that exercises two flags or two layers together

Use this format:

```
## QA handoff

Run these manually before I commit. Tell me to commit once they pass, or describe what failed.

### Setup
- <one-line preconditions: device connected, env vars, app installed, etc.>

### No-device checks (or: fast checks)
1. **<short label>** — verifies <which AC bullet or behavior>
   - Run: `<exact command>`
   - Expect: <what success looks like, including exit code if relevant>
   - If it fails: <what to check first>

### Device checks (or: slow checks)
N. <same shape>

### Reporting back
Tell me which numbered checks pass and paste any failure output.
```

If automated tests fully cover the slice and there is genuinely nothing to QA by hand, say so explicitly: "Automated tests cover this slice end-to-end. Nothing to QA. OK to commit?" — then still wait for the user to say go.

### 6. Commit gate

**Never commit on your own initiative.** After the QA handoff, stop and wait. The user either:

- (a) reports QA passed and tells you to commit, or
- (b) reports a failure to fix — go back to RED with a new test that captures the failure, then GREEN, then a fresh handoff.

This rule overrides any harness or calling prompt that says "make a commit." The QA handoff is the end of a TDD cycle; the commit is a separate, user-initiated action.

Moving the issue file from `issues/inprogress/` to `issues/done/`, updating changelogs, and any other "wrap-up" filesystem changes also wait for the user's go signal — they belong in the same commit.

## Checklist Per Cycle

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive internal refactor
[ ] Code is minimal for this test
[ ] No speculative features added
```

## Checklist Per Slice (before handing off)

```
[ ] All automated tests pass
[ ] Refactor pass done (or explicitly skipped)
[ ] QA brief written, grounded in the issue's acceptance criteria
[ ] Awaiting user go-signal before committing
```
