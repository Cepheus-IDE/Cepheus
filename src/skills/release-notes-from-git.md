---
name: release-notes-from-git
description: Generate a CHANGELOG entry and human-friendly release notes from the git history since the last tag.
version: 1.0.0
category: Git
---
# CHANGELOG and release notes from git log

Goal: an accurate, readable changelog entry for the next release, grouped by change type, based only
on real commits.

## Steps

1. **Find the range.**
   - Last tag: `git describe --tags --abbrev=0` (if none, use the first commit:
     `git rev-list --max-parents=0 HEAD`).
   - Commits: `git log <last-tag>..HEAD --no-merges --pretty=format:"%h|%s|%an|%b<END>"`
   - Merged PRs (for PR numbers): `git log <last-tag>..HEAD --merges --pretty=format:"%h %s"`
2. **Determine the next version** (semver). If commits follow Conventional Commits: any `!` or
   `BREAKING CHANGE:` means major; any `feat` means minor; otherwise patch. Check the current version in
   the manifest (`package.json`, `Cargo.toml`, `pyproject.toml`). Ask the user if unclear.
3. **Classify each commit:**
   - Breaking changes, Features (`feat`), Fixes (`fix`), Performance (`perf`), Security,
     Deprecations, Documentation (`docs`), Internal (`refactor`, `chore`, `ci`, `build`, `test`, `style`).
   - For non-conventional messages, read the diff (`git show --stat <hash>`) to classify.
   - Merge duplicates (fix + follow-up fix of the same thing) and drop noise (typo fixes, reverts that
     were reverted back).
4. **Write user-facing lines:** what changed for the user and why it matters, past tense, one line
   each, with the short hash or PR number: `- Export to CSV from the reports page (#123)`.
   Breaking changes get a migration note (what to change, before/after snippet).
5. **Update `CHANGELOG.md`** following Keep a Changelog: newest version on top,
   `## [1.4.0] - YYYY-MM-DD` with sections Added / Changed / Deprecated / Removed / Fixed / Security.
   Create the file with a header if it does not exist. Keep the existing format if one exists.
6. **Draft release notes** for the GitHub release: a 2-3 sentence highlight summary, then the grouped
   list, then "Upgrade notes" if there are breaking changes, and contributors
   (`git shortlog -sn <last-tag>..HEAD`).
7. Do NOT create tags or push unless the user asks.

## Done when

- [ ] Range and version bump are stated and justified.
- [ ] Every non-trivial commit is represented exactly once, in the right group.
- [ ] Breaking changes have migration instructions.
- [ ] CHANGELOG.md updated in its existing style; release notes text returned to the user.
- [ ] Nothing was tagged or pushed without permission.
