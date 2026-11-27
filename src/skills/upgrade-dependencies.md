---
name: upgrade-dependencies
description: Upgrade project dependencies safely - patch/minor in bulk, majors one at a time with changelog review, tests after each step.
version: 1.0.0
category: Maintenance
---
# Upgrade dependencies safely

Goal: dependencies are up to date (or as far as safely possible), the lockfile is consistent, and
the build and tests pass after every step.

## Steps

1. **Baseline.** Make sure the working tree is clean (`git status`). Run the build and tests once
   and record the result; pre-existing failures must be known before upgrading.
2. **List outdated packages** (use the project's package manager, detected from the lockfile):
   - npm: `npm outdated` / pnpm: `pnpm outdated` / yarn: `yarn outdated`
   - Python: `pip list --outdated` or `uv pip list --outdated` / `poetry show --outdated`
   - Rust: `cargo update --dry-run` (and `cargo outdated` if installed)
   - Go: `go list -u -m all`
3. **Check security advisories first:** `npm audit`, `pip-audit`, `cargo audit`,
   `govulncheck ./...`. Vulnerable packages get priority.
4. **Group the work** in `update_plan`:
   1. Patch + minor updates (semver-compatible) in one batch.
   2. Each major update as its own step, framework/core packages first (e.g. React before
      react-dom-dependent libs; TypeScript separately).
5. **Batch 1 (compatible):** `npm update` / `pnpm update` / `cargo update` / `go get -u=patch ./...`;
   then build + tests. If something breaks, bisect the batch.
6. **Each major:**
   1. Read its CHANGELOG / migration guide / release notes (look in `node_modules/<pkg>/CHANGELOG.md`
      or the repository) and list breaking changes that affect this code (`search` for the APIs).
   2. Upgrade: `npm i <pkg>@latest` (and matching `@types/<pkg>`), `cargo add <crate>@<ver>`,
      `poetry add <pkg>@latest`, `go get <mod>@latest`.
   3. Apply code migrations (codemods if the project provides them).
   4. Build, type-check, lint, test. Fix or roll back (`git checkout -- package.json <lockfile>`)
      and report if the migration is too large.
7. **Never** delete the lockfile to "fix" resolution problems, and do not use `--force` /
   `--legacy-peer-deps` without explaining why.
8. Check runtime/engine requirements (`engines` in package.json, `rust-version`, `python_requires`)
   still match CI and Docker images.

## Done when

- [ ] Baseline build/test status recorded before changes.
- [ ] Security advisories resolved or explicitly listed as blocked.
- [ ] Compatible updates applied; each major upgraded separately with its breaking changes handled.
- [ ] Lockfile updated consistently by the package manager; build, type-check and tests pass.
- [ ] Report: table of package / from / to / notes, plus anything deferred and why.
