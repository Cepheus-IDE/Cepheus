---
name: security-review
description: OWASP Top 10 security review of the codebase or a change set, with evidence, severity and concrete fixes.
version: 1.0.0
category: Security
---
# Security review (OWASP-style)

Goal: find real, exploitable weaknesses and report each with evidence, severity and a fix.
Read-only by default; apply fixes only when the user asks.

## Steps

1. **Scope.** If the user mentions a change, review `git diff` plus the touched files. Otherwise map
   the attack surface: HTTP routes, CLI arguments, file uploads, queue consumers, auth code,
   database access, templates, configuration and secrets.
2. **Inventory entry points** with `search`: `app.get(`, `router.`, `@app.route`, `@Get(`,
   `#[get(`, `req.body`, `request.args`, `process.argv`, `os.environ`.
3. **Walk the OWASP Top 10:**
   - **A01 Broken access control:** every sensitive route checks authentication AND authorization
     (ownership, role). Look for IDOR (`/orders/:id` without an owner check), CORS `*` with credentials.
   - **A02 Cryptographic failures:** passwords hashed with bcrypt/argon2/scrypt, never MD5/SHA1;
     TLS enforced; no secrets in code (`search` for `api_key`, `secret`, `password`, `PRIVATE KEY`).
   - **A03 Injection:** SQL built by string concatenation, `exec`/`spawn` with a shell and user
     input, `eval`, template injection, `innerHTML` / `dangerouslySetInnerHTML` with unsanitized data,
     NoSQL operator injection.
   - **A04 Insecure design:** no rate limit on login/OTP/reset, predictable tokens, missing CSRF
     protection for cookie-authenticated state changes.
   - **A05 Misconfiguration:** debug mode in production, stack traces returned to clients, default
     credentials, missing security headers (CSP, HSTS, X-Content-Type-Options).
   - **A06 Vulnerable components:** run `npm audit --omit=dev`, `pip-audit`, `cargo audit` or
     `govulncheck ./...` when available.
   - **A07 Authentication failures:** session fixation, JWT `alg: none` or unverified signatures,
     long-lived tokens, account enumeration in login/reset messages.
   - **A08 Integrity failures:** `pickle.loads`, `yaml.load` without SafeLoader, unsigned updates,
     CI using unpinned third-party actions.
   - **A09 Logging failures:** secrets or PII in logs; security events not logged.
   - **A10 SSRF:** server fetches user-supplied URLs without an allowlist or private-IP blocking.
   - Also: path traversal (`../` in file paths), open redirects, upload type/size limits, XXE.
4. **Verify each finding** by tracing data from source to sink. Drop it if the input is not attacker
   controlled or is already validated.
5. **Report:**

```
| # | Severity | Category | Location | Issue | Fix |
|---|----------|----------|----------|-------|-----|
| 1 | High | A03 Injection | api/users.ts:88 | ORDER BY built from req.query.sort | Allowlist sort columns, parameterize |
```

   Severity: Critical (remote, unauthenticated, data loss) / High / Medium / Low / Info.

## Done when

- [ ] Entry points and trust boundaries are listed.
- [ ] Every OWASP category was considered, even when there are no findings.
- [ ] Each finding has file:line evidence, the data flow, severity and a concrete fix.
- [ ] A dependency audit was run or noted as unavailable.
- [ ] Secrets found are masked in the report, never repeated in full.
