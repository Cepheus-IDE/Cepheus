---
name: debug-production-error
description: Diagnose a production error from a stack trace or log excerpt, reproduce it locally with a failing test, and ship a minimal fix.
version: 1.0.0
category: Debugging
---
# Debug a production error from a stack trace

Goal: find the root cause of the reported error, prove it with a reproducing test, fix it minimally,
and suggest how to prevent and detect it next time.

## Steps

1. **Collect the evidence.** Ask the user to paste the full stack trace, error message, request or
   job context, timestamps, app version/commit, and how often it happens. Note anything missing.
2. **Map the trace to code.**
   - Ignore frames from `node_modules`, the standard library and framework internals; find the
     deepest frame in project code and the first project frame (entry point).
   - If the trace is minified, use source maps (`npx source-map-cli resolve`) or the build output
     to map lines; for Python/Java/Go/Rust the paths are usually direct.
   - Check that the deployed version matches the code: `git log -1`, or check out the deployed
     tag/commit (`git show <commit>:<path>`) before reading.
3. **Read the code path** from entry to the failing line with `read_file`. List the assumptions that
   must be false for this error to occur (value is null, list empty, network returned 500, race
   between two requests, timezone/locale, unexpected data shape from an old record).
4. **Look for supporting clues:** `git log -L <start>,<end>:<file>` or `git log -p --since="2 weeks ago" -- <file>`
   to see recent changes on that path; `search` for other places handling the same data.
5. **Form hypotheses** in `update_plan`, ordered by likelihood; for each, the evidence that would
   confirm or reject it.
6. **Reproduce** locally with the smallest input: write a failing unit/integration test that
   triggers exactly this exception (same type and message). If it cannot be reproduced, add targeted
   logging/metrics around the suspicious values (no PII/secrets) and explain what to look for.
7. **Fix the root cause**, not the symptom: validate data at the boundary, handle the empty/null case
   explicitly, fix the race (locks, idempotency, transactions), add timeouts/retries for transient
   network failures. Avoid blanket `try/catch` that hides the error.
8. Run the new test (now passing) and the full suite.
9. **Report:** root cause in one paragraph, the fix, the test, blast radius (which users/data were
   affected, need for a data repair script), and prevention (alert, validation, type change).

## Done when

- [ ] The failing frame and the faulty assumption are identified with evidence.
- [ ] A test reproduces the error before the fix and passes after it.
- [ ] Fix addresses the root cause with minimal change; full suite passes.
- [ ] Report covers impact, any data clean-up needed, and prevention/monitoring.
