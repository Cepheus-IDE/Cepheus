# Cepheus IDE

A lightweight code editor with a built-in AI agent that plans, edits, runs and checks your code.
Backend in **Rust** (Tauri 2), frontend in **React + TypeScript** with **Monaco** and **xterm.js**.
Free NVIDIA models are included, and the project is open source under the [MIT license](LICENSE).

**Platforms:** Windows 10/11, macOS 11+ (Intel and Apple Silicon), Linux (deb, rpm, AppImage).
Installers for every platform are built by GitHub Actions and attached to [Releases](https://github.com/Cepheus-IDE/Cepheus/releases).

## Features

**Editor**
- Monaco editor: syntax highlighting for ~80 languages, IntelliSense for TS/JS/JSON/CSS/HTML, minimap, sticky scroll, bracket colors, multi-cursor
- Tabs with dirty indicator, breadcrumbs, auto save (optional)
- File explorer: create / rename / delete (to Recycle Bin), git status colors, live refresh via a file watcher
- Search across files (regex, match case, whole word) and replace all, respects `.gitignore`
- Quick Open (`Ctrl+P`), Command Palette (`Ctrl+Shift+P`), Go to Line (`Ctrl+G`)
- Integrated terminal: real PTY (PowerShell / pwsh / cmd), multiple tabs
- Source control: stage / unstage / discard, side-by-side diff vs HEAD, commit, pull / push, **AI commit messages**

**AI (Antigravity-style)**
- **Agent panel** (`Ctrl+L`): an autonomous coding agent that explores the codebase, edits files, and runs commands
- **Agent Manager** (`Ctrl+Shift+M`): run several agent tasks in parallel and watch their status
- **Artifacts**: live task plan (checklist) and a list of changed files with diffs, *Revert all* / *Keep*
- **Review policy**: *Ask* (approve every edit/command), *Auto-edit* (approve only commands), *Turbo* (fully autonomous)
- **Inline edit** (`Ctrl+K`): rewrite the selection from an instruction
- **AI inline completion** (ghost text, optional)
- Multi-provider: **Claude** (Anthropic), **Gemini**, and any **OpenAI-compatible** API (OpenAI, OpenRouter, Groq, **Ollama**, LM Studio)

**Personalization & ecosystem**
- Themes: Ink, Graphite, Noir, Moss, Paper, plus **Theme Studio** (design your own with 10 colors and a live preview)
- Import any VS Code color theme `.json`
- **Extensions** from Open VSX: color themes and snippets are activated (no extension code is executed)
- **Import from VS Code / Cursor / Windsurf / VSCodium**: settings (font, tab size, wrap, minimap, auto save, terminal, color theme) plus installed theme/snippet extensions

**GitHub**
- Connect with a personal access token; list and clone repositories
- Publish the open folder as a new repo; push / pull; open pull requests
- **Issue → Agent**: one click turns an open issue into an agent task

**Unique**
- **Time Machine** (`Ctrl+Alt+H`): scrub a timeline of every saved / agent-edited version of a file, diff against the current one, restore
- **AI Review**: a code review of uncommitted changes before you commit

## Requirements

- Node.js 18+ and Rust (stable)
- Git (for source control features)
- **Windows:** Visual Studio Build Tools with the C++ workload. WebView2 is built into Windows 11; the installer adds it on Windows 10.
- **macOS:** Xcode Command Line Tools (`xcode-select --install`).
- **Linux (Debian/Ubuntu):** `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev`

The built-in free NVIDIA models need a key at build time: put it in `src-tauri/nvidia.key` (git-ignored) or set `NVIDIA_API_KEY`. Without it, users add their own key in Settings.

## Development

```powershell
npm install
npm run app:dev      # starts Vite + the Tauri window with hot reload
```

## Release build

```bash
npm run app:build
```

On GitHub, pushing a tag such as `v0.2.0` runs [.github/workflows/build.yml](.github/workflows/build.yml), which builds Windows, macOS (universal) and Linux installers and attaches them to a draft release. Add the repository secret `NVIDIA_API_KEY` to include the free models in those builds.

Outputs:
- `src-tauri/target/release/cepheus-ide.exe` (portable executable)
- `src-tauri/target/release/bundle/nsis/Cepheus IDE_0.1.0_x64-setup.exe` (installer)

## Setting up AI

1. Open **Settings** (`Ctrl+,` or the gear icon).
2. Choose a provider and enter its API key:
   - Claude: key from console.anthropic.com, default model `claude-opus-5-5`
   - Gemini: key from aistudio.google.com
   - Ollama (free, local): provider *OpenAI-compatible*, base URL `http://localhost:11434/v1`, no key, model e.g. `qwen2.5-coder`
3. Keys are stored locally in `%APPDATA%\dev.cepheus.ide\settings.json` and are sent only to the provider you chose.

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Command Palette | `Ctrl+Shift+P` / `F1` |
| Quick Open file | `Ctrl+P` |
| Open Folder | `Ctrl+O` |
| Save / Save All | `Ctrl+S` / `Ctrl+Alt+S` |
| Close tab | `Ctrl+W` |
| Toggle sidebar / terminal / agent | `Ctrl+B` / ``Ctrl+` `` / `Ctrl+L` |
| New agent task | `Ctrl+Shift+N` |
| Agent Manager | `Ctrl+Shift+M` |
| Inline AI edit | `Ctrl+K` |
| Search in files | `Ctrl+Shift+F` |
| Source control | `Ctrl+Shift+G` |
| Settings | `Ctrl+,` |

## Project layout

```
src-tauri/src/
  lib.rs            command registration
  fs_cmds.rs        file system commands
  search.rs         ripgrep-style search (ignore + regex crates)
  terminal.rs       PTY terminals (portable-pty)
  git.rs            git integration (git CLI)
  watcher.rs        file watcher (notify)
  settings.rs       settings persistence
  agent/mod.rs      agent loop, approvals, sessions, events
  agent/tools.rs    agent tools: list_dir, find_files, read_file, search, write_file, edit_file, run_command, update_plan
  agent/providers.rs  Claude / OpenAI-compatible / Gemini adapters
src/
  App.tsx           layout and global key handling
  lib/              API wrappers, workspace/model management, agent client, AI helpers, commands
  components/       UI: Explorer, Search, Git, Editor, Terminal, Agent panel, Agent Manager, Palette, Settings
```

## Safety

- Agent file tools are confined to the open workspace folder.
- Deleting from the explorer moves files to the Recycle Bin.
- In *Ask* mode, every file write and command needs your approval. Agent changes can be reverted from the Changes list.

## License

[MIT](LICENSE)
