# VS Code feature parity tracker

Source: the 7 pages under code.visualstudio.com/features (code-editing, enterprise, extensibility,
agents, models, customizations, continuity), read 2026-11-27.

Status: ✅ done · 🟡 partial · ⬜ todo · 🚫 not applicable to Cepheus (reason given)

## Code editing

### Smarter coding
- ✅ IntelliSense (Monaco TS/JS/JSON/CSS/HTML + LSP for other languages)
- ✅ AI inline suggestions (ghost text)
- ✅ Multi-cursor editing
- ✅ Snippets — extensions + user snippets (active profile folder) + workspace snippets (`.cepheus/snippets/*.json`, `.vscode/*.code-snippets`) in VS Code format; "Snippets: Configure User/Workspace Snippets" (JSON schema), tab stops/placeholders/choices, variables ($TM_*, $CURRENT_*, $CLIPBOARD, $UUID, $WORKSPACE_*, comments…) resolved, live reload on save
- ✅ Quick fixes — LSP `textDocument/codeAction` as Monaco code action provider (lightbulb, Ctrl+.), WorkspaceEdits (text + create/rename/delete) and `workspace/executeCommand`, `codeAction/resolve`; TS/JS: Monaco TS quick fixes with semantic checking on (unresolvable-module noise filtered, setting `tsSemanticValidation`)
- ✅ Refactorings — "Refactor…" (Ctrl+Shift+R), "Source Action…", "Organize Imports" (Shift+Alt+O) for LSP servers; TS/JS via an extended Monaco TS worker (extract function/constant/type, convert…, organize imports; rename starts on the extracted name)
- ✅ Rename symbol (LSP)

### Debugging
- ✅ Breakpoints (gutter, F9), step over/into/out, variables, call stack, debug console, Run and Debug view
- ✅ Built-in Node.js / JavaScript / TypeScript debugger; attach to a running Node process by port (`request: "attach"`); hover evaluation while paused
- ✅ Debug toolbar — in the sidebar + floating toolbar over the editor (drag sideways)
- ✅ Watch expressions (add/edit/remove, re-evaluated on every pause in the selected frame)
- ✅ Inline values (`name = value` after each line of the paused function)
- ✅ Launch configurations (`.vscode/launch.json` + `.cepheus/launch.json`, JSONC: program, args, cwd, env, envFile, runtimeExecutable, runtimeArgs, port, stopOnEntry, `${workspaceFolder}`/`${file}`/`${fileDirname}`…); picker + "Add Configuration…" gear
- ✅ Conditional breakpoints, hit counts, logpoints (gutter right-click / inline widget); enable/disable each; "Deactivate all"
- 🟡 Generic DAP client (stdio) ✅ — any adapter via `"adapterCommand"`; Python via debugpy implemented, verified only against a mock DAP adapter (Python not installed here; shows an install hint); ⬜ C#/Java presets

### Testing
- ✅ Test Explorer (discover/run all/file/suite/single, debug, durations, failure details + expected/actual diff, TEST RESULTS panel)
- ✅ Inline pass/fail indicators (▶ Run | Debug CodeLens, ✓/✗ glyphs, failure squiggle + message at the assertion line)
- ✅ Code coverage overlays (per-line gutter/background, per-file %, toggle)
- ✅ Continuous run mode (re-runs affected tests on save)
- 🟡 Framework adapters: ✅ node:test (verified end to end); Vitest/Jest, pytest, cargo test, go test implemented with report parsers verified on fixtures (runners not installed here); ⬜ JUnit
- ✅ "Fix Test Failure" with the agent

### Git
- ✅ Stage, commit, branches, pull/push, inline diff vs HEAD, AI commit messages
- ✅ Merge conflict resolution (Accept Current/Incoming/Both)
- ✅ Inline blame, stash, identity prompt
- ✅ 3-way merge editor: Incoming (stage 3) / Current (stage 2) / editable Result from the base (stage 1), one-sided changes auto-merged, per-conflict Accept Incoming/Current/Both/Ignore (CodeLens + toolbar), next/prev, remaining counter, Complete Merge (write + stage)
- ✅ Timeline (Source Control → Timeline): `git log --follow` + Time Machine snapshots in one list; diff vs current, copy hash, open commit, restore version
- ✅ Commits view with lane graph, branch/tag badges, all-branches toggle, search (message/author/hash), commit details (message, files → parent ↔ commit diff), branch/tag from commit, cherry-pick, revert
- ✅ Branches view: local + remote with ahead/behind, checkout, create from…, rename, delete (confirm, force-delete step), merge into current, rebase onto, fetch --prune; tags list/create/delete/push; status-bar branch → quick branch picker
- ✅ Quick diff gutter vs HEAD (added/modified/deleted), click to peek original with Revert this change / Stage this hunk (`git apply --cached --unidiff-zero`)
- ✅ Commit options: amend, sign-off, staged only / all / smart, undo last commit (soft reset), Sync (pull then push) with ahead/behind in panel + status bar
- ✅ GitHub PRs: list (open/closed/mine/review requested), PR tab with Markdown description, checks, files with diffs, conversation + inline review comments, comment, approve / request changes, checkout branch (incl. forks), merge/squash/rebase with confirm
- 🟡 Not yet: inline PR review comments on lines, interactive rebase, per-line staging within a hunk, graph lanes capped at 8 columns

### Languages
- ✅ Built-in JS/TS/JSON/CSS/HTML; ✅ LSP for Python, Rust, Go, C/C++, Java, PHP, Ruby, Lua, C#, Bash, YAML, Docker
- ✅ One-click language server install — "Install Pyright" (etc.) status bar action + one-time hint when a known server is missing; runs the install in a terminal (npm/pip/rustup/go/gem/dotnet/winget) and restarts servers on success (jdtls: manual)
- ✅ Problems for files that are not open — publishDiagnostics for unopened files kept and shown in Problems; Pyright/basedpyright asked for `diagnosticMode: workspace` (setting `lspWorkspaceDiagnostics`)

### Integrated browser
- ✅ Live browser preview — Browser editor tab (native child webview: address bar, back/forward/reload, open externally, device-size presets); dev-server URLs detected in terminal/process output ("Open in Browser"); "Browser: Open URL…", "Browser: Open Preview of Current HTML File" (built-in 127.0.0.1 static server) with live reload on save. Limits: tab only (no split editor yet); the webview is hidden while menus/modals overlap it; app shortcuts don't fire while the page has focus; SSH workspaces can't be previewed via the static server
- ✅ Inspect DOM / debug front end — WebView2 DevTools for the preview + in-app Console pane (console.*, errors, failed resource loads, unhandled rejections)
- 🟡 Agent can use the browser to verify changes — `browser` tool (open / read / click / type / eval, approval for click/type/eval in Ask mode); "Share with Agent" attaches URL, title, visible text, DOM outline and console; ⬜ screenshot (not captured)

### Terminal
- ✅ Shell choice, multiple terminals
- ✅ Split terminals (side-by-side panes per tab, `Ctrl+\`), rename (double-click tab / "Terminal: Rename…"), launch profile menu (PowerShell, pwsh, cmd, Git Bash, WSL when present)
- ✅ Clickable file links in terminal output — path, path:line, path:line:col, path(line,col), Python tracebacks; relative to the workspace; Ctrl+click opens in the editor (existence checked first)

### Make it yours
- ✅ Color themes, icon themes, Theme Studio, VS Code theme import
- ✅ Remap keyboard shortcuts (editor with conflict detection)
- ✅ Settings — UI with search box (filters sections/fields); "Open User/Workspace Settings (JSON)" with schema validation/completion/hover and live apply on save; workspace level `<folder>/.cepheus/settings.json` overrides user settings (allowlisted keys only — a repo can't change commands, providers, keys or agent policy); 🚫 multi-root folder level (Cepheus opens one folder)
- ✅ Settings Sync across machines — private GitHub Gist (profiles, keybindings, snippets, extensions list), conflict choice, machine-specific exclusion; never syncs keys/tokens
- ✅ Profiles (settings + enabled extensions + keybindings + snippets folder + layout; create/switch/rename/delete, `.cepheus-profile` export/import, per-folder auto-switch)
- ✅ Export printable keyboard shortcut reference (HTML print-ready or Markdown, save dialog; includes custom bindings)
- 🟡 Keymap presets — Default / Sublime-like / JetBrains-like (Keyboard Shortcuts editor); ⬜ Vim / Emacs modes (need a large dependency; skipped)
- ✅ Accessibility — High Contrast Dark/Light themes (Monaco hc bases, strong borders), visible `:focus-visible` outlines, accessible names on all icon-only buttons (from their tooltips), `accessibilitySupport` setting (editor + terminal screen-reader mode); 🟡 no full screen-reader audit of every view
- ✅ UI zoom

## Enterprise
- ✅ Organization policy file that overrides user settings (system-wide JSON, `CEPHEUS_POLICY_PATH` override; locked settings shown as managed)
- 🚫 ADMX/ADML Group Policy, MDM profiles — Windows/macOS packaging work for a later stage; the JSON policy file covers the mechanism
- ✅ AI governance policies: allowed providers/models, agent tools, MCP servers, approval mode floor, shared instructions
- ✅ Extension allowlist (publisher / id / version)
- ✅ Preinstalled extensions on first launch; ✅ workspace recommendations (.vscode/.cepheus extensions.json)
- ✅ Private marketplace — configurable Open VSX-compatible registry URL (setting or policy)
- ✅ Telemetry level setting ("off" only — Cepheus sends no telemetry; policy can lock it)
- ✅ Proxy configuration, trusted certificates (all backend HTTP clients via `net::builder()`, proxy exported to git/docker)
- 🟡 Update behavior (automatic / startup / manual / none / policy) with tauri-plugin-updater — ⬜ signing key, pubkey and release feed not set up yet (updater stays off until then)

## Extensibility
- ✅ Extensions from Open VSX (themes, icon themes, snippets)
- 🚫 Running VS Code extension code (needs a full extension host; Cepheus deliberately runs no extension code)
- ✅ MCP servers for the agent (stdio + streamable HTTP/SSE; `.cepheus/mcp.json` + global `mcpServers`; Settings → MCP Servers with start/stop/status/tools); ⬜ MCP marketplace/list
- 🟡 Model provider plugins — any number of named OpenAI-compatible providers (Language Models → Providers); ⬜ non-OpenAI-protocol provider plugins
- ⬜ Agent plugins (bundle instructions, skills, agents, hooks, MCP)
- 🚫 Visual Studio Marketplace — its terms only allow Microsoft products; Open VSX is used instead

## Agents
- ✅ Agent edits code, runs commands, iterates; approvals (Ask / Auto-edit / Turbo); plan checklist; changes list with revert
- ✅ Parallel sessions (Agent Manager)
- ✅ Plan mode (read-only research + plan before editing, then "Start implementation")
- ✅ Redirect / steer a running agent without losing progress (queue a message mid-run)
- ✅ Persist sessions across restarts (UI state + backend conversation history, app data dir)
- ✅ Agent uses tests/builds to self-check ("Verify" option: typecheck/lint/test scripts, cargo check, go test, pytest; up to 3 fix rounds)
- ⬜ Background / worktree-isolated sessions
- 🚫 Cloud agents, GitHub Mobile, GitHub.com surfaces — Microsoft/GitHub services
- ⬜ CLI agent (`cepheus` command in the terminal sharing sessions with the app)
- ✅ Deep links (`cepheus://open?folder=…`, `cepheus://agent/new?prompt=…` prefills, never auto-sends) + single instance

## Models
- ✅ Providers: NVIDIA (free), Anthropic, Google, OpenAI-compatible (OpenAI, OpenRouter, Groq, Ollama, LM Studio); BYOK; local models
- ✅ Thinking effort: Claude effort, OpenAI `reasoning_effort` (o-series, gpt-5, gpt-oss incl. NVIDIA), Gemini thinking budget (2.5) / level (3); effort picker in the chat footer for reasoning models
- ✅ Model picker in the chat footer for every provider (grouped, enabled models only, Auto), per session
- 🟡 Agent harnesses: Cepheus / Claude Code (`claude -p --output-format stream-json`, `--resume`) / Codex (`codex exec --json`, `resume`) per session, events in the same chat, install hint when missing; ⬜ harness edits in the "files changed" list (CLI tool calls are shown, not diffed); Codex path untested (CLI not installed here)
- ✅ Language Models editor (Chat: Manage Language Models…): live lists for NVIDIA, Anthropic, Gemini, OpenAI-compatible/Ollama/LM Studio, capabilities (tools, vision, reasoning, context), show/hide per model, multiple named custom providers
- ✅ Auto model selection: fast vs strongest tier from the prompt, escalates after many tool turns, request-level fallback on 429/5xx/timeouts/404 (models 404ing for the account are marked unavailable and skipped)
- ✅ Friendly provider errors (401/402/403/404/429/5xx/timeout/network) with suggested actions
- ✅ Usage view: per-session and today tokens/requests per model; compact counter in the chat header (no $ cost)
- ✅ Cache explorer: per-turn cache hit/write/miss, hit rate (Anthropic, Claude Code; OpenAI/Gemini cached tokens when reported)

## Agent customizations
- ✅ Custom instructions — global textbox + instruction files (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `.cepheus/instructions/*.md` with `applyTo` globs), loaded files shown as chips
- ✅ Skills (`.cepheus/skills/<name>/SKILL.md` in workspace + app data dir, listed in the prompt, `load_skill` on demand)
- ✅ Custom agents (`.cepheus/agents/*.md`: instructions, enforced tool allowlist, model override; picker in the chat)
- ✅ Hooks (`.cepheus/hooks.json`: preToolUse can block via exit code, postToolUse, stop)
- ⬜ Plugins bundling the above; Agent Customizations editor (files are edited as plain Markdown/JSON today)
- ✅ Agent debug log: per-turn model calls, tool calls, hooks, checks, token counts, flow summary (toggle in the chat header)

## Continuity
- ✅ Remote SSH (files, terminal, git, search, agent on the server)
- ✅ Move a session between the Agent Manager and the editor panel (pop out / dock, keeps draft + scroll)
- 🟡 Dev Containers — Reopen in Container (image/Dockerfile, env, ports, mounts, lifecycle commands), terminals + agent commands inside; ⬜ Docker Compose, ⬜ language servers inside the container
- 🚫 Codespaces, vscode.dev, Dev Tunnels — Microsoft-hosted services
- ⬜ Remote access to agent sessions from another device (self-hosted tunnel)
