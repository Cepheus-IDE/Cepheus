---
name: conventional-commit-message
description: Write a Conventional Commits message for the staged changes (or propose how to split them into several commits).
version: 1.0.0
category: Git
---
# Conventional commit message

Goal: a precise commit message in the Conventional Commits 1.0 format that describes the staged
changes. Do not commit unless the user asks.

## Steps

1. **Read the staged changes:** `git diff --cached --stat`, then `git diff --cached`.
   If nothing is staged, look at `git status --short` and `git diff`, and tell the user which files
   you assume will be committed.
2. **Check repository conventions:** `git log -n 20 --pretty=format:"%s"` for the style already
   used (scopes, capitalization, ticket prefixes). Check for `commitlint.config.*` or
   `.commitlintrc*` and follow its rules.
3. **Decide if it is one commit.** If the diff mixes unrelated changes (a feature plus an unrelated
   refactor plus formatting), propose a split with the files for each commit.
4. **Pick the type:** `feat` (new user-facing capability), `fix` (bug fix), `perf`, `refactor`
   (no behaviour change), `docs`, `test`, `build` (deps, build system), `ci`, `style` (formatting
   only), `chore` (maintenance), `revert`.
5. **Pick a scope** (optional): the module/package/area most affected, as used in history (`api`,
   `auth`, `ui`).
6. **Write the message:**

```
<type>(<scope>): <imperative summary, lower case, no period, <= 72 chars>

<body: what changed and WHY, wrapped at 72 columns; mention behaviour
changes, trade-offs, and anything reviewers must know>

BREAKING CHANGE: <what breaks and how to migrate>   (only if applicable)
Refs: #123                                           (if an issue is known)
```

   - Use `!` after the type/scope for breaking changes (`feat(api)!: ...`) in addition to the footer.
   - Summary in imperative mood: "add", "fix", "remove", not "added"/"adds".
7. Return the message in a code block. If the user asked you to commit, run
   `git commit -F <tempfile>` (multi-line safe) and show the resulting `git log -1 --stat`.

## Done when

- [ ] Type and scope match the actual change and the repository's conventions.
- [ ] Summary is imperative, specific and at most 72 characters.
- [ ] Body explains why, not just what (omit only for trivial changes).
- [ ] Breaking changes are flagged with `!` and a `BREAKING CHANGE:` footer.
- [ ] Unrelated changes were flagged with a proposed split.
