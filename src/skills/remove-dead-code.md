---
name: remove-dead-code
description: Find and safely remove unused files, exports, functions, dependencies and feature flags, verifying with tooling, search and tests.
version: 1.0.0
category: Code quality
---
# Remove dead code

Goal: delete code and dependencies that are provably unused, without breaking dynamic usages,
public APIs or the build.

## Steps

1. **Run the right detector** (install temporarily with `npx` if absent):
   - JS/TS: `npx knip` (unused files, exports, dependencies) or `npx ts-prune`;
     `npx depcheck` for dependencies.
   - Python: `vulture . --min-confidence 80`; `ruff check --select F401,F841`.
   - Rust: `cargo build` warnings (`dead_code`), `cargo +nightly udeps` if available.
   - Go: `staticcheck ./...` (U1000), `go mod tidy`.
   - Also check compiler/linter warnings already present.
2. **Build a candidate list** in `update_plan`, grouped as: unused files, unused exports/functions,
   unused dependencies, stale feature flags, commented-out code blocks, unreachable branches.
3. **Verify each candidate before deleting** (tools give false positives):
   - `search` the whole repo for the name as a string too: dynamic imports, reflection, string-based
     registries, templates, config files, CLI command maps, route files loaded by convention
     (`pages/`, `app/`), decorators, dependency-injection tokens, serialization.
   - Is it part of a published library's public API? If yes, deprecate instead of deleting.
   - Is it used only by tests? Then remove the tests with it, or keep it if it is a test helper.
   - Is it referenced by scripts, CI, Docker or docs?
4. **Delete in small batches** (one category at a time). After each batch run type-check, lint,
   tests and build. If anything breaks, restore that item and mark it as "used dynamically".
5. **Dependencies:** remove with the package manager (`npm uninstall x`, `poetry remove x`,
   `cargo remove x`) so the lockfile stays consistent.
6. **Feature flags:** only remove flags that are fully rolled out or abandoned (ask the user); keep the
   winning branch and remove the flag checks and config.
7. Remove commented-out code (git history keeps it).

## Done when

- [ ] Each removal was confirmed unused by tool output AND a repo-wide text search.
- [ ] Public API symbols were deprecated, not deleted (unless the user agreed).
- [ ] Build, type-check, lint and tests pass after every batch.
- [ ] Report: removed files/symbols/dependencies, lines removed, and items kept with the reason.
