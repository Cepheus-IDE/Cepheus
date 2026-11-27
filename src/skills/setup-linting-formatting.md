---
name: setup-linting-formatting
description: Set up linting and formatting (ESLint + Prettier, Ruff, rustfmt + clippy, gofmt) with scripts, editor config and CI checks.
version: 1.0.0
category: Maintenance
---
# Set up linting and formatting

Goal: one formatter and one linter per language, configured consistently, runnable with a single
command locally and in CI, with the codebase passing.

## Steps

1. **Inventory** existing config: `.eslintrc*`, `eslint.config.*`, `.prettierrc*`, `biome.json`,
   `pyproject.toml` (`[tool.ruff]`, black, isort, flake8), `rustfmt.toml`, `clippy.toml`,
   `.golangci.yml`, `.editorconfig`. Extend what exists; do not add a competing tool (e.g. do not add
   Prettier next to Biome).
2. **Install and configure per language:**
   - **JS/TS:** `npm i -D eslint @eslint/js typescript-eslint prettier eslint-config-prettier`
     (+ `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y` for React). Create a flat
     `eslint.config.js` (ESLint 9) with recommended + typescript-eslint recommended, ignores for build
     output, and `eslint-config-prettier` last. `.prettierrc` with the style the code already mostly
     uses (check quotes, semicolons, width) plus `.prettierignore`.
   - **Python:** Ruff for both lint and format in `pyproject.toml`:
     `[tool.ruff] line-length = 100`, `[tool.ruff.lint] select = ["E","F","I","B","UP"]`.
   - **Rust:** `rustfmt.toml` only if non-default settings are wanted; clippy via
     `cargo clippy --all-targets -- -D warnings`.
   - **Go:** `gofmt`/`goimports`; optional `golangci-lint` with a small `.golangci.yml`.
3. **Add `.editorconfig`** (charset, end_of_line lf, indent style/size, final newline).
4. **Scripts:** `"lint": "eslint ."`, `"format": "prettier --write ."`,
   `"format:check": "prettier --check ."` (or `ruff check .` / `ruff format .`, `cargo fmt --check`).
5. **Apply once:** run the formatter over the repo in a separate step so the formatting change is
   isolated (tell the user to commit it separately). Then run the linter with `--fix`, and fix the
   remaining errors by hand or relax rules that do not fit the project (justify each).
6. **CI:** add `format:check` and `lint` steps to the existing workflow (or tell the user to use the
   github-actions-ci skill).
7. **Optional pre-commit:** `lint-staged` + `simple-git-hooks`/`husky`, or the `pre-commit` framework
   for Python; ask first.
8. Recommend the editor setting "format on save" with the chosen formatter.

## Done when

- [ ] Exactly one formatter and one linter per language, with configs committed to the repo.
- [ ] `lint` and `format:check` (or equivalents) pass on the whole codebase.
- [ ] Formatting-only changes are isolated from logic changes.
- [ ] CI runs the checks; `.editorconfig` present.
- [ ] Any disabled rules are listed with reasons.
