---
name: fix-failing-tests
description: Run the test suite, diagnose each failure from its output and fix the root cause without weakening tests.
version: 1.0.0
category: Testing
---
# Fix failing tests

Goal: a green test suite where every fix addresses the real cause of a failure.

## Steps

1. **Find the test command** the project really uses: `package.json` scripts, `Makefile`,
   `pyproject.toml`, `Cargo.toml`, `.github/workflows/*.yml`. Prefer the exact CI command.
2. **Run the full suite once** in non-watch mode and capture the failures:
   - `npx vitest run` / `npx jest --ci` / `npm test`
   - `pytest -q --tb=short`
   - `cargo test` / `go test ./...` / `dotnet test` / `mvn -q test`
3. **List the failures** with `update_plan`, one item per failing test or per shared root cause
   (ten tests failing on the same import error are one item).
4. **For each failure:**
   1. Read the assertion message and stack trace; open the test and the code under test at the
      reported lines.
   2. Classify it:
      - (a) bug in production code;
      - (b) test outdated after an intended behaviour change;
      - (c) environment issue: missing env var, timezone, locale, path separators, network;
      - (d) flaky: timing, ordering, shared state between tests.
   3. Reproduce it alone: `npx vitest run -t "name"`, `pytest path::test_name`,
      `cargo test name`, `go test -run Name ./pkg`.
   4. Fix the root cause:
      - (a) minimal fix in the code;
      - (b) update the expectation only when `git log -p` or the user confirms the change was intended;
      - (c) make the test hermetic (fixed TZ, temp dirs, `path.join`, mocks);
      - (d) remove shared state, await properly, use fake timers. Never add arbitrary sleeps.
   5. Re-run that test, then mark the plan item done.
5. **Never** skip, delete or loosen a test (`.skip`, `xfail`, replacing exact values with
   `toBeTruthy`) just to get green. If a test is obsolete, ask the user first.
6. Run the **full suite** again plus the type-checker/linter if the project has one
   (`npx tsc --noEmit`, `ruff check .`, `cargo clippy`).

## Done when

- [ ] The full suite passes with the command CI uses.
- [ ] No test was skipped, deleted or weakened without the user's agreement.
- [ ] Each fix is explained in one line: cause, then change.
- [ ] Type-check and lint still pass.
