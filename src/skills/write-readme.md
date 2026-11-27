---
name: write-readme
description: Write or rewrite a project README from the actual code - what it is, install, usage, configuration, development and license.
version: 1.0.0
category: Documentation
---
# Write a README

Goal: a README that lets a newcomer understand, install, run and contribute to the project in
minutes. Every command in it must be real and verified.

## Steps

1. **Gather facts, do not invent them.**
   - Manifest files: `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`
     (name, description, scripts, binaries, engines/versions, license).
   - Entry points (`main`, `bin`, `src/main.*`, `app.py`, `cmd/`), config files, `.env.example`,
     `Dockerfile`, CI workflows (they show the real build/test commands).
   - Existing docs and an existing README (keep any correct, valuable content).
   - `git remote -v` for the repository URL; `LICENSE` file for the license.
2. **Outline** (omit sections that do not apply):
   1. Title + one-sentence description + badges only if CI/package exist.
   2. Features (3 to 7 bullets, user benefits).
   3. Requirements (runtime versions, OS notes).
   4. Installation (copy-pasteable commands).
   5. Quick start / Usage: the smallest working example, then common tasks. Show CLI `--help`
      output or a code snippet that really runs.
   6. Configuration: table of env vars / options with default and description.
   7. Development: clone, install, run tests, lint, build; project structure (short tree of key folders).
   8. Deployment (if relevant), Troubleshooting / FAQ (from known issues), Contributing, License.
3. **Verify commands.** Run install/build/test commands where it is safe (`npm ci && npm test`,
   `pip install -e . && pytest`). If something fails, document the prerequisite or tell the user.
4. **Write it** in `README.md` at the repo root. Use fenced code blocks with language tags, relative
   links to files, and keep lines readable. No marketing fluff; prefer short sentences.
5. Check that every link and referenced path exists (`find_files`).

## Done when

- [ ] Description says what the project is and who it is for in one sentence.
- [ ] Install + quick start commands were run successfully (or limits are stated).
- [ ] Configuration options are documented from the code, with defaults.
- [ ] Development section shows how to test, lint and build.
- [ ] All links and paths resolve; license matches the LICENSE file.
