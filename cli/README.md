# Cepheus CLI

An open-source AI coding agent for your terminal: the agent from [Cepheus IDE](https://github.com/Cepheus-IDE/Cepheus), packaged as a command.
It reads and edits files, runs commands and keeps a plan, and it asks before changing anything unless you tell it not to.

```bash
npm i -g cepheus-ide
cd my-project
cepheus
```

You need Node.js 18 or newer. It works in Windows Terminal, PowerShell, cmd, macOS Terminal and Linux terminals.

## Free ways to start

Cepheus needs a language model. These options cost nothing:

1. **NVIDIA developer key.** Sign in at [build.nvidia.com](https://build.nvidia.com), open a model and click **Get API Key** (the key starts with `nvapi-`). It's free for development and testing and has rate limits. Then run:
   ```bash
   export NVIDIA_API_KEY=nvapi-...        # PowerShell: $env:NVIDIA_API_KEY="nvapi-..."
   cepheus
   ```
2. **Local models.** Install [Ollama](https://ollama.com) and run `ollama pull qwen2.5-coder`, or start the local server in [LM Studio](https://lmstudio.ai). Everything stays on your machine and no key is needed, but you need a fairly powerful computer.
   ```bash
   cepheus -p ollama -m qwen2.5-coder
   ```
3. **Your own key.** Anthropic, Google Gemini, OpenAI, OpenRouter, Groq or any OpenAI-compatible server (llama.cpp, vLLM, ...). Some of these providers have free tiers. Check their pricing pages.

If nothing is configured the first time you run `cepheus`, a short setup wizard walks you through these options. You can run it again any time with `cepheus login`.

## Usage

```bash
cepheus                                   # interactive session in the current folder
cepheus "fix the failing test"            # run one task, then exit
cepheus --plan "add dark mode"            # read-only research that ends with a plan
cepheus -y "run the linter and fix all warnings"   # turbo: no approval prompts
cepheus -p anthropic -m claude-sonnet-5-5 "review src/api.ts"
cepheus --json --yes "update the changelog" > events.ndjson
echo "explain this project" | cepheus     # the prompt can come from stdin
```

| Command | What it does |
|---|---|
| `cepheus login` | Choose a provider, model and key. Saved to `~/.cepheus/config.json`. |
| `cepheus models` | List the current provider's models, fetched live from its API. |
| `cepheus doctor` | Check Node.js, the config, whether the provider is reachable, git, Ollama and the workspace's customizations. |
| `cepheus web [--port 4000] [--host 127.0.0.1] [--open]` | Start the browser UI for this folder, if this build includes it. |
| `cepheus config` | Show the configuration with keys masked. |

| Option | |
|---|---|
| `-y`, `--yes` | Same as `--mode turbo`. |
| `--mode ask\|auto-edit\|turbo` | `ask` (the default) asks before file edits and commands. `auto-edit` applies edits without asking but still asks before commands. `turbo` never asks. |
| `--plan` | Plan mode. The agent can only use read-only tools and replies with a plan. |
| `-m`, `--model <id>` | A model id, or `auto` to try the suggested models in order. |
| `-p`, `--provider <id>` | One of `nvidia`, `anthropic`, `gemini`, `openai`, `openrouter`, `groq`, `ollama`, `lmstudio`, `llamacpp`, `vllm`. |
| `--json` | Print newline-delimited JSON events, for scripts. |
| `-C`, `--cwd <dir>` | Workspace folder. Defaults to the current folder. |
| `--agent <name>` | Use a custom agent from `.cepheus/agents/<name>.md`. |
| `--verbose` | Also show thinking, full command output and debug events. |
| `--no-color` | Turn off colors. The `NO_COLOR` environment variable is honored too. |

### Interactive commands

| | |
|---|---|
| `/model [id\|auto]` | List models (fetched live, so NVIDIA's list is always current) and pick one, or set one directly. |
| `/provider [id]` | Switch provider. If no key is found, it asks for one. |
| `/mode ask\|auto-edit\|turbo` | Change the approval mode. |
| `/plan on\|off` | Turn plan mode on or off. |
| `/undo [--force]` | Revert the files changed in the last turn. Backups are kept in memory. Commands the agent ran are not undone. |
| `/diff` | Show every file change made in this session. |
| `/cost` | Show token usage. |
| `/skills` | List the skills, instruction files, hooks and MCP servers that were found. |
| `/init` | Have the agent explore the project and write an `AGENTS.md`. |
| `/clear` | Start a new conversation. |
| `/help`, `/exit` | Show help, or quit. |

When the agent asks for approval, answer `y` (yes), `n` (no) or `a` (always allow this kind of action for the rest of the session).
Anything you type while the agent is working is sent to it as an extra message.
Press **Ctrl+C** once to cancel the current turn and twice to exit.

## Tools

The agent has the same tools as the desktop app, with the same behavior:

| Tool | |
|---|---|
| `list_dir`, `find_files`, `read_file`, `search` | Read-only exploration. File listing follows `.gitignore`. |
| `write_file` | Create a file or overwrite one completely. |
| `edit_file` | Replace text exactly. `old_str` must occur exactly once in the file. |
| `run_command` | Runs in the workspace root, in PowerShell on Windows and `sh` elsewhere. Default timeout 120 s, maximum 600 s. Output is cut off after 30,000 characters. |
| `update_plan` | Show a checklist of the plan. |
| `load_skill` | Load a skill's instructions. |
| `mcp__<server>__<tool>` | Tools from your MCP servers. |

Every path is resolved inside the workspace. Paths outside it are refused.

## Customize the agent

Cepheus reads the same files as Cepheus IDE:

| Path | Purpose |
|---|---|
| `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md` | Instructions added to every run. |
| `.cepheus/instructions/*.md` | More instructions. Use `applyTo: "src/**/*.ts"` frontmatter to apply them only once the agent has touched matching files. |
| `.cepheus/skills/<name>/SKILL.md`, `~/.cepheus/skills/<name>/SKILL.md` | Skills, which are reusable procedures the agent loads when it needs them. Workspace skills take precedence over user skills that have the same name. |
| `.cepheus/agents/<name>.md` | Custom agents with their own instructions, tool allowlist (`tools:`) and model (`model:`). Use one with `--agent <name>`. |
| `.cepheus/hooks.json` | Commands that run on `preToolUse`, `postToolUse` and `stop`. They get the tool call as JSON on stdin. If a `preToolUse` hook exits with a non-zero code, the call is blocked, and its stderr is passed to the model as the reason. |
| `.cepheus/mcp.json` | MCP servers that run over stdio (`{"servers": {"name": {"command", "args", "env"}}}`). Calls to their tools need approval unless you're in turbo mode. |

```json
{
  "hooks": [
    { "event": "preToolUse", "matcher": "run_command", "command": "node scripts/check-command.js" },
    { "event": "stop", "command": "npm run lint" }
  ]
}
```

## Configuration

`cepheus login` writes `~/.cepheus/config.json`. Change the folder with `CEPHEUS_HOME`.

```json
{
  "provider": "nvidia",
  "model": "auto",
  "keys": { "nvidia": "nvapi-..." },
  "baseUrls": { "ollama": "http://192.168.1.20:11434/v1" },
  "approvalMode": "ask",
  "fallbackModels": ["meta/llama-3.3-70b-instruct"],
  "customInstructions": "Prefer small, focused commits."
}
```

Environment variables take precedence over the file: `NVIDIA_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `OPENAI_BASE_URL` (any OpenAI-compatible server), `CEPHEUS_PROVIDER` and `CEPHEUS_MODEL`. Command-line flags take precedence over both.

**Auto fallback.** With the model set to `auto`, or with `fallbackModels` in the config, a request that gets a rate limit (429), a server error (5xx), a timeout or "model not found" (404) is retried on the next model that uses the same message format. Error messages say what went wrong and what to try next.

## JSON event mode

`cepheus --json "<task>"` prints one JSON object per line on stdout. These are the same events the desktop app's agent emits: `status`, `text`, `textDelta`, `thinking`, `toolCall`, `toolResult`, `approvalRequest`, `plan`, `fileChanged`, `warning`, `error`, `usage`, `context`, `debug`.
In `ask` or `auto-edit` mode, answer an approval by writing `{"approvalId": "...", "approved": true}` as a line on stdin. You can also send `{"type": "cancel"}` or `{"type": "steer", "text": "..."}`. If stdin is a terminal or gets closed, approvals are refused. Exit codes: `0` when the turn finished, `1` on an error, `130` when it was cancelled.

## Use it as a library

The agent core runs in any environment. It doesn't import any `node:` modules, and every side effect goes through a `ToolHost` that you pass in:

```js
import { createSession, runAgentTurn } from "cepheus-ide/core/agent";
import { NodeToolHost } from "cepheus-ide/node/host";

const session = createSession();
await runAgentTurn(
  { host: new NodeToolHost(process.cwd()), session, config: { provider: "nvidia", model: "nvidia/nemotron-3-ultra-550b-a55b", apiKey: process.env.NVIDIA_API_KEY }, message: "List the TODOs", approvalMode: "ask", approve: async () => true },
  (event) => console.log(event.type),
);
```

## Security notes

- **Keys stay with you.** No key is built into the package. Keys come from your environment or `~/.cepheus/config.json`, which is written with `0600` permissions where the OS supports them (on Windows the ACLs of your user profile protect it). Commands that print keys mask them.
- Requests go directly from your machine to the provider you chose. Nothing is sent anywhere else, and there is no telemetry.
- In `ask` mode every edit and every command needs your approval. `turbo` (`--yes`) runs everything without asking, so use it only in folders and on tasks you trust, ideally under version control.
- File tools are confined to the workspace. `run_command`, hooks and MCP servers run with your user's permissions, so review `.cepheus/hooks.json` and `.cepheus/mcp.json` in repositories you didn't write.
- `/undo` only restores files the agent wrote with its file tools. It can't revert the effects of commands.

## License

MIT. See [LICENSE](LICENSE).
