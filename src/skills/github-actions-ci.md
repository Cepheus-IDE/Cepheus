---
name: github-actions-ci
description: Set up a fast, secure GitHub Actions CI workflow that installs, lints, type-checks, tests and builds the project on every push and PR.
version: 1.0.0
category: DevOps
---
# GitHub Actions CI setup

Goal: `.github/workflows/ci.yml` that runs the project's real checks on pushes and pull requests,
caches dependencies, and follows security best practices.

## Steps

1. **Discover the real commands** from `package.json` scripts, `Makefile`, `pyproject.toml`,
   `Cargo.toml`, `go.mod`, existing workflows, README. Run them locally first (install, lint,
   type-check, test, build) so CI starts green.
2. **Detect versions:** `.nvmrc`/`engines`, `.python-version`/`requires-python`, `rust-toolchain`,
   `go.mod` go directive. Decide the OS matrix (Ubuntu only, or add Windows/macOS for desktop/CLI
   tools) and version matrix (supported LTS versions).
3. **Write the workflow:**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run lint --if-present
      - run: npx tsc --noEmit
      - run: npm test -- --run
      - run: npm run build --if-present
```

   Adapt per ecosystem: `actions/setup-python@v5` with `cache: pip` (or `astral-sh/setup-uv`),
   `dtolnay/rust-toolchain@stable` + `Swatinem/rust-cache@v2`, `actions/setup-go@v5` (built-in cache),
   `actions/setup-java@v4` with `cache: maven|gradle`.
4. **Security and hygiene:**
   - Minimal `permissions` at the top (add write scopes only to jobs that need them).
   - Use official actions; for third-party actions pin to a full commit SHA.
   - Never echo secrets; use `secrets.*` only in trusted events (`pull_request` from forks gets no
     secrets; avoid `pull_request_target` with checkout of PR code).
   - `timeout-minutes` on jobs; `concurrency` to cancel superseded runs.
5. **Optional extras** (ask): matrix across OS/versions, coverage upload, dependency review
   (`actions/dependency-review-action`), Dependabot config (`.github/dependabot.yml`) for the
   ecosystem and `github-actions`.
6. **Validate:** YAML syntax (`npx yaml-lint` or `actionlint` if available); if `gh` is installed and
   the user agrees, push a branch and watch with `gh run watch`.
7. Add a CI badge to the README.

## Done when

- [ ] Workflow triggers on push to the default branch and on pull requests.
- [ ] It runs install, lint, type-check, tests and build using the same commands as local dev.
- [ ] Dependencies are cached; superseded runs are cancelled; jobs have timeouts.
- [ ] Least-privilege `permissions`; third-party actions pinned.
- [ ] The commands pass locally; YAML validated.
