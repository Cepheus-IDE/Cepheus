---
name: dockerize-project
description: Add a production-grade multi-stage Dockerfile, .dockerignore and docker-compose setup, built and smoke-tested locally.
version: 1.0.0
category: DevOps
---
# Dockerize a project

Goal: a small, secure, reproducible image that builds from a clean checkout and runs the app, plus a
compose file for local development with its dependencies.

## Steps

1. **Inspect the project:** language/runtime and version (`.nvmrc`, `engines`, `.python-version`,
   `rust-toolchain`, `go.mod`), build command, start command, port, required env vars
   (`.env.example`, config code), external services (database, cache), static assets, lockfile.
2. **Write `.dockerignore` first:** `.git`, `node_modules`, build output, `.env*` (keep
   `.env.example`), logs, coverage, IDE folders, `target/`, `__pycache__`, `.venv`.
3. **Write a multi-stage `Dockerfile`:**
   - Pin the base image to a specific version, slim/alpine/distroless where compatible
     (`node:22-slim`, `python:3.12-slim`, `rust:1.x` builder + `debian:bookworm-slim`/distroless runtime,
     `golang:1.x` builder + `gcr.io/distroless/static`).
   - Builder stage: copy ONLY manifests + lockfile first, install deps (`npm ci`, `pip install
     --no-cache-dir -r requirements.txt`, `cargo fetch`, `go mod download`) for layer caching; then
     copy source and build.
   - Runtime stage: copy only build artifacts and production deps; set `NODE_ENV=production` etc.
   - Run as a non-root user (`USER node` / create an app user).
   - `EXPOSE` the port; `CMD` in exec form (`["node","dist/server.js"]`); no shell wrapper unless needed
     so signals reach the process.
   - Add a `HEALTHCHECK` if the app has a health endpoint (or note one should be added).
   - No secrets in the image (no `COPY .env`, no `ARG` with tokens).
4. **Write `compose.yaml`** for local dev: the app (build: .), its services (postgres/redis with pinned
   versions, named volumes, healthchecks), `depends_on` with `condition: service_healthy`, env from
   `.env`, port mappings.
5. **Build and smoke test** (if Docker is available):
   - `docker build -t <name>:dev .`
   - `docker run --rm -p 3000:3000 --env-file .env.example <name>:dev` and hit the health/root URL.
   - `docker compose up --build -d`, check `docker compose ps` and logs, then `docker compose down`.
   - `docker image ls <name>` to report the image size.
6. Document build/run commands in the README.

## Done when

- [ ] `.dockerignore` excludes VCS, dependencies, build output and secrets.
- [ ] Multi-stage build with pinned base images and cached dependency layer.
- [ ] Runs as non-root, exec-form CMD, correct port, no secrets baked in.
- [ ] Image builds and the app responds in a container (or Docker unavailability is reported).
- [ ] compose.yaml starts the app with its services; README updated.
