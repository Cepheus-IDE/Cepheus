---
name: scaffold-cli-tool
description: Scaffold a well-structured command-line tool with argument parsing, help, exit codes, config, tests and packaging.
version: 1.0.0
category: Scaffolding
---
# CLI tool scaffolding

Goal: a working CLI skeleton with subcommands, `--help`/`--version`, proper exit codes and stderr
usage, tests, and an installable entry point.

## Steps

1. **Clarify** (ask if not given): language, tool name, subcommands and their options, whether it
   reads stdin / writes files, config file needs, distribution (npm, PyPI, cargo, binary).
2. **Pick idiomatic libraries** (reuse what the repo already uses):
   - Node/TS: `commander` (or `yargs`); colors via `picocolors`; `bin` field in `package.json`.
   - Python: `typer` or `argparse`/`click`; `[project.scripts]` in `pyproject.toml`.
   - Rust: `clap` with derive; `anyhow` for errors. Go: `cobra` or the standard `flag` package.
3. **Layout:**
   - entry (`src/cli.ts` with `#!/usr/bin/env node`, `src/<pkg>/__main__.py`, `src/main.rs`,
     `cmd/<name>/main.go`);
   - one module per subcommand; core logic in plain functions that do not touch `process`/`sys`
     (easy to test);
   - README usage section.
4. **Behaviour rules:**
   - `--help` on every command with examples; `--version` from the manifest.
   - Output data to stdout, diagnostics/errors to stderr; `--json` flag for machine-readable output
     when the tool reports data.
   - Exit codes: 0 success, 1 runtime failure, 2 usage error. Never print a stack trace for expected
     errors; `--verbose`/`DEBUG` for details.
   - Respect `NO_COLOR` and non-TTY output (no colors/spinners when piped).
   - Read config with precedence: flags > env vars (`TOOLNAME_*`) > config file > defaults.
   - Handle Ctrl+C gracefully; confirm before destructive actions unless `--yes`.
   - Cross-platform paths (`path.join`, `pathlib`, `PathBuf`).
5. **Tests:** unit tests for core functions; integration tests that run the CLI as a process
   (`execa`/`child_process`, Typer `CliRunner`, `assert_cmd`, `exec.Command`) checking stdout, stderr
   and exit codes for success, bad arguments and `--help`.
6. **Wire scripts:** build (`tsc`/`tsup`), test, and a local install check
   (`npm link` / `pip install -e .` / `cargo install --path .` / `go install ./cmd/<name>`), then run
   `<name> --help`.

## Done when

- [ ] `<name> --help` and `<name> --version` work after a local install.
- [ ] Subcommands are separate modules; core logic is testable without spawning a process.
- [ ] Correct stdout/stderr split and exit codes (0/1/2).
- [ ] Integration tests for success, usage error and help pass.
- [ ] README documents installation and every command with an example.
