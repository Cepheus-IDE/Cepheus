---
name: api-docs-from-code
description: Generate accurate API reference documentation (OpenAPI for HTTP services, or reference docs for libraries) directly from the source code.
version: 1.0.0
category: Documentation
---
# API docs from code

Goal: complete, accurate API documentation derived from the code itself: an OpenAPI 3.1 spec for
HTTP services, or a reference for a library's public API, plus doc comments where missing.

## Steps

1. **Decide the kind of API:**
   - HTTP service: routes/controllers exist.
   - Library/SDK: exported modules (`index.ts` exports, `__init__.py` `__all__`, `pub` items in
     `lib.rs`, exported Go identifiers).
2. **Prefer generators the stack already supports** (check dependencies first):
   - FastAPI: built-in (`app.openapi()`); NestJS: `@nestjs/swagger`; Fastify: `@fastify/swagger`;
     Django REST: `drf-spectacular`; Spring: springdoc; Axum: `utoipa`; Express with zod:
     `zod-to-openapi`.
   - Libraries: TypeDoc (`npx typedoc`), Sphinx/pdoc (`pdoc -o docs pkg`), `cargo doc`, `go doc`.
   If a generator fits, configure it and add a script rather than hand-writing a spec.
3. **HTTP services without a generator:** inventory every route with `search` (`app.get(`,
   `router.post(`, `@Get(`, `.route(`). For each, read the handler and validation schema and record:
   method, path, summary, auth, path/query/header params, request body schema, each response status
   with schema, and examples. Write `openapi.yaml` (OpenAPI 3.1) with shared `components/schemas`,
   `securitySchemes`, tags per resource and realistic examples.
4. **Libraries without a generator:** for each public symbol document purpose, signature, parameters,
   return value, errors/exceptions, a minimal example, and since/deprecated notes. Add missing doc
   comments (JSDoc/TSDoc, docstrings, `///`) in the source so generators pick them up.
5. **Cross-check against the code:** every documented field exists, required/optional matches the
   validation, enums list every value, status codes match what the handler returns. Note undocumented
   behaviour you discover.
6. **Validate:** `npx @redocly/cli lint openapi.yaml` (or `npx swagger-cli validate`) for specs; run
   the doc generator and fix warnings for libraries.
7. Link the docs from the README and add a script (e.g. `"docs": "redocly build-docs openapi.yaml"`).

## Done when

- [ ] Every public endpoint / exported symbol is documented; nothing documented that does not exist.
- [ ] Schemas, required fields, enums and status codes match the code.
- [ ] Each operation/function has at least one realistic example.
- [ ] Spec passes a linter, or the doc generator runs without warnings.
- [ ] README links to the docs and a script regenerates them.
