---
name: review-uncommitted-changes
description: Review all uncommitted git changes for bugs, security risks, missing tests and readability, and report prioritized findings.
version: 1.0.0
category: Code quality
---
# Code review of uncommitted changes

Goal: a concise, prioritized review of everything not yet committed, as a careful senior reviewer
would write it. Do not edit files unless the user asks you to apply fixes.

## Steps

1. **Collect the changes:**
   - `git status --short`
   - `git diff --stat` and `git diff --cached --stat`
   - `git diff` and `git diff --cached` (read every hunk)
   - `read_file` each new untracked file.
2. **Understand context.** For each hunk, read enough surrounding code to know the callers and the
   data flowing in. `search` for other call sites of changed functions and exported names.
3. **Check, in order of importance:**
   1. Correctness: wrong conditions, off-by-one, null/undefined handling, missing `await`,
      unhandled errors, races, resource leaks, wrong units/timezones.
   2. Security: injection (SQL, shell, HTML), secrets in code, missing authorization, path traversal,
      unsafe deserialization.
   3. Contracts: changed signatures, return shapes or defaults that break other callers or stored data.
   4. Tests: is the new behaviour covered? Were affected tests updated?
   5. Performance: N+1 queries, work in hot loops, unnecessary re-renders, blocking I/O.
   6. Readability: naming, duplication, dead code, misleading comments, leftover debug logs.
4. **Run the cheap checks** if they exist (type-check, lint, tests for touched modules) and include
   failures in the report.
5. **Double-check each finding** before reporting it; drop anything you cannot point to in the code.
6. **Write the report:**

```
## Summary
One paragraph: what the change does and the overall verdict.

## Must fix
- src/file.ts:42 — problem → suggested fix

## Should fix
- ...

## Nits
- ...

## Tests to add
- ...
```

## Done when

- [ ] Every changed file was read, not only the diff lines.
- [ ] Each finding cites file:line and proposes a concrete fix.
- [ ] Findings are grouped as Must fix / Should fix / Nits.
- [ ] Automated checks were run, or the report says why not.
