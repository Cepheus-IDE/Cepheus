---
name: explain-codebase
description: Explore an unfamiliar repository and produce an architecture map - components, data flow, entry points, key files and how to work on it.
version: 1.0.0
category: Documentation
---
# Explain a codebase (architecture map)

Goal: a clear, accurate mental model of the repository for a new contributor, grounded in files you
actually read. Read-only: do not modify code.

## Steps

1. **Survey the top level:** `list_dir` the root; read the README, manifests (`package.json`,
   `Cargo.toml`, `pyproject.toml`, `go.mod`), workspace/monorepo config (`pnpm-workspace.yaml`,
   `turbo.json`, Cargo workspace), Docker/compose files and CI workflows.
2. **Identify the kind of system:** web app, API service, library, CLI, desktop app, monorepo of
   several. List runtimes, frameworks and major libraries (from dependencies).
3. **Find the entry points:** `main`/`bin` fields, `src/main.*`, `index.*`, `app.py`, `cmd/*`,
   server bootstrap, router definitions, CLI command registration, background workers, cron jobs.
4. **Trace 2-3 core flows end to end** (e.g. "HTTP request to DB and back", "user clicks Save",
   "CLI command run"). Follow the calls with `search` and `read_file`, noting each layer.
5. **Map the modules:** for each top-level source folder, one line on its responsibility and its main
   dependencies on other folders. Note where state lives (database, stores, caches, files) and how
   configuration is loaded.
6. **Note cross-cutting concerns:** auth, error handling, logging, i18n, testing strategy (where tests
   live, how to run them), build and deploy pipeline.
7. **Write the explanation:**

```
# <Project> architecture

## In one paragraph
## Tech stack
## Directory map
| Path | Responsibility |
## How a request/command flows
(numbered steps or a Mermaid diagram)
## Key concepts and data model
## Where to start for common changes
- Add an API endpoint: ...
- Add a UI page: ...
## Running, testing, building
## Gotchas
```

   Include a Mermaid `flowchart` for the main flow when it helps. Reference real paths.
8. Offer to save it as `docs/ARCHITECTURE.md` (only write it if the user agrees).

## Done when

- [ ] Every statement is based on files that were read; uncertain points are marked as such.
- [ ] Entry points and 2-3 core flows are traced through real file paths.
- [ ] Directory map covers all top-level source folders.
- [ ] "Where to start" guidance and run/test/build commands are included.
