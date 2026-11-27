---
name: write-unit-tests
description: Write focused, deterministic unit tests for one source file using the project's existing test framework.
version: 1.0.0
category: Testing
---
# Write unit tests for a file

Goal: a test file that covers the public behaviour of ONE source file, passes, and follows the
conventions already used in the repository.

## Steps

1. **Identify the target.** If the user did not name a file, use the active editor file. Read it fully
   with `read_file`. List its exported functions/classes/components and what each one promises.
2. **Detect the test stack** (never introduce a second framework):
   - JS/TS: `package.json` (`vitest`, `jest`, `mocha`, `node:test`, `@testing-library/*`) and config
     files (`vitest.config.*`, `jest.config.*`).
   - Python: `pytest` (`pyproject.toml`, `pytest.ini`, `conftest.py`) or `unittest`.
   - Rust: inline `#[cfg(test)] mod tests` or `tests/`. Go: `_test.go` next to the file.
   - Anything else: check the CI workflow and README for the test command.
3. **Copy conventions.** `find_files` for existing tests (`*.test.*`, `*.spec.*`, `test_*.py`,
   `*_test.go`). Read one or two to match naming, folder layout, imports, fixtures and mocking style.
4. **Plan cases** with `update_plan`. For each exported unit cover:
   - the happy path with typical input;
   - edge cases: empty, zero, negative, very large, unicode, `null` / `undefined` / `None`;
   - error paths: invalid input throws or returns the documented error;
   - every branch that changes the output.
5. **Write the tests.**
   - One behaviour per test, descriptive names ("returns an empty list when input is empty").
   - Arrange / Act / Assert; prefer table-driven tests for many similar inputs.
   - Deterministic: fake timers, seeded randomness, no real network, temp dirs for files.
   - Mock only true boundaries (network, filesystem, time, process), never the unit under test.
6. **Run the new tests first, then the whole suite:**
   - `npx vitest run path/to/file.test.ts` or `npx jest path/to/file.test.ts`
   - `pytest path/to/test_file.py -q`
   - `cargo test module_name` / `go test ./pkg/... -run TestName`
7. **When a test fails**, decide whether the test or the code is wrong. Do not change production code
   to make a test pass unless it is clearly a bug, and then tell the user about it.
8. Optional: run coverage for the file (`npx vitest run --coverage`, `pytest --cov=module`) and add
   tests for uncovered branches that matter.

## Done when

- [ ] The test file lives where the project expects it and follows existing naming.
- [ ] Every exported function/component has at least one happy-path and one edge/error test.
- [ ] The new tests pass and the full suite still passes.
- [ ] No sleeps, real network calls or order-dependent tests.
- [ ] Summary for the user: file created, number of tests, any bugs found.
