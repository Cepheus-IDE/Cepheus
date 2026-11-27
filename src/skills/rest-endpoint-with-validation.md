---
name: rest-endpoint-with-validation
description: Add a REST API endpoint with input validation, proper status codes, error handling, auth checks and tests, following the project's framework.
version: 1.0.0
category: Back end
---
# REST API endpoint with validation and tests

Goal: a new endpoint that validates input, returns correct status codes and consistent error bodies,
is protected appropriately, and is covered by tests.

## Steps

1. **Learn the existing API style.** Detect the framework (Express, Fastify, NestJS, Hono, Next.js
   route handlers, FastAPI, Flask, Django REST, Axum, Actix, Gin, Spring). Read one similar existing
   endpoint end to end: routing, controller/handler, service, data access, validation library,
   error format, auth middleware, and its tests.
2. **Specify the endpoint** in `update_plan` (confirm with the user if ambiguous):
   method, path (plural nouns, `/api/v1/orders/:id`), auth requirement, request params/query/body
   schema, response schema, status codes, pagination/filtering, idempotency.
3. **Validation** with the project's library (zod, joi, class-validator, Pydantic, serde + validator,
   go-playground/validator). Validate path params, query and body; reject unknown fields when the
   project does; limit string lengths and array sizes; coerce types explicitly.
4. **Implement** in the existing layers (route, handler, service, repository):
   - Status codes: 200 OK / 201 Created (+ `Location` header) / 204 No Content / 400 validation /
     401 unauthenticated / 403 forbidden / 404 not found / 409 conflict / 422 if the project uses it /
     500 only for unexpected errors.
   - Error body in the project's format (or RFC 9457 `application/problem+json`) with field-level
     validation messages; never leak stack traces or SQL errors.
   - Authorization: check the caller may access THIS resource (ownership), not only that they are logged in.
   - Use parameterized queries / the ORM; wrap multi-step writes in a transaction.
5. **Tests** using the project's HTTP testing approach (supertest, Fastify `inject`, FastAPI
   `TestClient`, `httptest`, Axum `oneshot`):
   - happy path with response shape assertion;
   - each validation failure class (missing field, wrong type, out of range) returns 400 with details;
   - unauthenticated 401, other user's resource 403/404, missing resource 404, conflict 409.
6. **Document** it where the project documents APIs (OpenAPI spec/decorators, README, docs folder).
7. Run the tests, linter and type-check.

## Done when

- [ ] Endpoint follows existing routing, layering and naming conventions.
- [ ] All inputs validated; invalid input never reaches the database layer.
- [ ] Correct status codes and consistent error bodies.
- [ ] Authentication and per-resource authorization enforced.
- [ ] Tests for success, validation, auth and not-found cases pass.
- [ ] API docs / OpenAPI updated.
