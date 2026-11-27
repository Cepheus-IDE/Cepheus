//! Extension bridges, data: which VS Code extensions Cepheus can stand in for, with what, and what
//! has to be installed first. Cepheus never runs extension code; a bridge uses a CLI on PATH, a tool
//! from the project, a language server shipped inside the .vsix (run with Node), or a built-in feature.

import type { FormatterId, LinterId } from "./core";

export type BridgeKind = "harness" | "formatter" | "linter" | "languageServer" | "builtin";
export type OS = "win" | "mac" | "linux";

/** Something a bridge needs: a CLI on PATH, a package in the project's node_modules, or a project file. */
export interface ToolDef {
  name: string;
  /** exe: on PATH (also .venv / vendor/bin / node_modules/.bin of the workspace when `local`). */
  check: { exe: string; local?: string[] } | { npm: string; bin?: string } | { files: string[] };
  /** One-click install, per OS ("all" = every OS). Runs in a visible terminal. */
  install?: Partial<Record<OS | "all", string>>;
  note?: string;
}

const venv = (exe: string) => [`.venv/bin/${exe}`, `venv/bin/${exe}`, `.venv/Scripts/${exe}.exe`, `venv/Scripts/${exe}.exe`];

export const TOOLS: Record<string, ToolDef> = {
  node: {
    name: "Node.js", check: { exe: "node" },
    install: { win: "winget install -e --id OpenJS.NodeJS.LTS", mac: "brew install node" },
    note: "Language servers bundled in extensions run on Node.js.",
  },
  claude: { name: "Claude Code CLI", check: { exe: "claude" }, install: { all: "npm install -g @anthropic-ai/claude-code" }, note: "Run `claude` once in a terminal to sign in." },
  codex: { name: "Codex CLI", check: { exe: "codex" }, install: { all: "npm install -g @openai/codex" }, note: "Run `codex login` once in a terminal to sign in." },
  prettier: { name: "Prettier (project)", check: { npm: "prettier" }, install: { all: "npm install --save-dev prettier" } },
  eslint: { name: "ESLint (project)", check: { npm: "eslint" }, install: { all: "npm install --save-dev eslint" }, note: "ESLint 9 also needs an eslint.config.js — `npm init @eslint/config@latest` creates one." },
  stylelint: { name: "Stylelint (project)", check: { npm: "stylelint" }, install: { all: "npm install --save-dev stylelint stylelint-config-standard" }, note: "Needs a .stylelintrc (e.g. { \"extends\": \"stylelint-config-standard\" })." },
  markdownlint: { name: "markdownlint-cli2 (project)", check: { npm: "markdownlint-cli2", bin: "markdownlint-cli2" }, install: { all: "npm install --save-dev markdownlint-cli2" } },
  typescript: { name: "TypeScript (project)", check: { npm: "typescript" }, install: { all: "npm install --save-dev typescript" } },
  tailwindcss: { name: "Tailwind CSS (project)", check: { npm: "tailwindcss" }, install: { all: "npm install --save-dev tailwindcss" } },
  graphqlConfig: {
    name: "GraphQL config file",
    check: { files: [".graphqlrc", ".graphqlrc.yml", ".graphqlrc.yaml", ".graphqlrc.json", ".graphqlrc.toml", ".graphqlrc.js", ".graphqlrc.ts", "graphql.config.js", "graphql.config.ts", "graphql.config.json", "graphql.config.yml", "graphql.config.yaml"] },
    note: "Add a .graphqlrc.yml at the project root, e.g. `schema: schema.graphql` and `documents: src/**/*.graphql`.",
  },
  black: { name: "Black", check: { exe: "black", local: venv("black") }, install: { win: "python -m pip install black", mac: "brew install black", linux: "pipx install black" } },
  ruff: { name: "Ruff", check: { exe: "ruff", local: venv("ruff") }, install: { win: "python -m pip install ruff", mac: "brew install ruff", linux: "pipx install ruff" } },
  rustfmt: { name: "rustfmt", check: { exe: "rustfmt" }, install: { all: "rustup component add rustfmt" } },
  gofmt: { name: "gofmt (Go)", check: { exe: "gofmt" }, install: { win: "winget install -e --id GoLang.Go", mac: "brew install go", linux: "sudo apt install -y golang-go" } },
  clangFormat: { name: "clang-format", check: { exe: "clang-format" }, install: { win: "winget install -e --id LLVM.LLVM", mac: "brew install clang-format", linux: "sudo apt install -y clang-format" } },
  shfmt: { name: "shfmt", check: { exe: "shfmt" }, install: { win: "winget install -e --id mvdan.shfmt", mac: "brew install shfmt", linux: "sudo apt install -y shfmt" } },
  phpCsFixer: { name: "PHP CS Fixer", check: { exe: "php-cs-fixer", local: ["vendor/bin/php-cs-fixer", "vendor/bin/php-cs-fixer.bat"] }, install: { all: "composer global require friendsofphp/php-cs-fixer" } },
  taplo: { name: "Taplo", check: { exe: "taplo" }, install: { all: "npm install -g @taplo/cli" } },
  dart: { name: "Dart SDK", check: { exe: "dart" }, install: { mac: "brew tap dart-lang/dart && brew install dart" }, note: "Install the Dart or Flutter SDK and put its bin folder on PATH." },
  shellcheck: { name: "ShellCheck", check: { exe: "shellcheck" }, install: { win: "winget install -e --id koalaman.shellcheck", mac: "brew install shellcheck", linux: "sudo apt install -y shellcheck" } },
  hadolint: { name: "Hadolint", check: { exe: "hadolint" }, install: { win: "winget install -e --id hadolint.hadolint", mac: "brew install hadolint" }, note: "Linux: download the binary from github.com/hadolint/hadolint/releases." },
  pyright: { name: "Pyright", check: { exe: "pyright-langserver" }, install: { all: "npm install -g pyright" } },
  basedpyright: { name: "basedpyright", check: { exe: "basedpyright-langserver" } },
  pylsp: { name: "python-lsp-server", check: { exe: "pylsp" } },
  rustAnalyzer: { name: "rust-analyzer", check: { exe: "rust-analyzer" }, install: { all: "rustup component add rust-analyzer" } },
  gopls: { name: "gopls", check: { exe: "gopls" }, install: { all: "go install golang.org/x/tools/gopls@latest" }, note: "Needs Go; make sure $(go env GOPATH)/bin is on PATH." },
  clangd: { name: "clangd", check: { exe: "clangd" }, install: { win: "winget install -e --id LLVM.LLVM", mac: "brew install llvm", linux: "sudo apt install -y clangd" }, note: "macOS: Homebrew's llvm is keg-only — add $(brew --prefix llvm)/bin to PATH." },
  git: { name: "Git", check: { exe: "git" }, install: { win: "winget install -e --id Git.Git", mac: "xcode-select --install", linux: "sudo apt install -y git" } },
  docker: { name: "Docker", check: { exe: "docker" }, note: "Install Docker Desktop (or Podman) from the vendor's site." },
};

export interface FormatterDef { name: string; tool: string; languages: string[] }
export const FORMATTERS: Record<FormatterId, FormatterDef> = {
  prettier: { name: "Prettier", tool: "prettier", languages: ["javascript", "typescript", "json", "css", "scss", "less", "html", "vue", "markdown", "mdx", "yaml", "graphql", "handlebars"] },
  black: { name: "Black", tool: "black", languages: ["python"] },
  ruff: { name: "Ruff", tool: "ruff", languages: ["python"] },
  rustfmt: { name: "rustfmt", tool: "rustfmt", languages: ["rust"] },
  gofmt: { name: "gofmt", tool: "gofmt", languages: ["go"] },
  "clang-format": { name: "clang-format", tool: "clangFormat", languages: ["c", "cpp", "objective-c"] },
  shfmt: { name: "shfmt", tool: "shfmt", languages: ["shell"] },
  "php-cs-fixer": { name: "PHP CS Fixer", tool: "phpCsFixer", languages: ["php"] },
  taplo: { name: "Taplo", tool: "taplo", languages: ["toml"] },
  dart: { name: "dart format", tool: "dart", languages: ["dart"] },
};

export interface LinterDef { name: string; tool: string; languages: string[] }
export const LINTERS: Record<LinterId, LinterDef> = {
  eslint: { name: "ESLint", tool: "eslint", languages: ["javascript", "typescript", "vue"] },
  ruff: { name: "Ruff", tool: "ruff", languages: ["python"] },
  stylelint: { name: "Stylelint", tool: "stylelint", languages: ["css", "scss", "less"] },
  shellcheck: { name: "ShellCheck", tool: "shellcheck", languages: ["shell"] },
  markdownlint: { name: "markdownlint", tool: "markdownlint", languages: ["markdown"] },
  hadolint: { name: "Hadolint", tool: "hadolint", languages: ["dockerfile"] },
};

/** A Node language server inside the extension's .vsix (verified to answer `initialize`, see report). */
export interface ServerBridge {
  name: string;
  languages: string[];
  /** Paths below `extension/` to unpack ("dir/" for folders). */
  extract: string[];
  /** Server entry, relative to the unpack folder. */
  entry: string;
  args?: string;
  /** `${dir}` = unpack folder, `${workspace}` = open folder. */
  initializationOptions?: any;
  /** Answers to `workspace/configuration` by section. */
  config?: Record<string, any>;
  /** Approximate download, shown before enabling. */
  size: string;
}

export interface BuiltinAction { label: string; command?: string; sidebar?: string; setting?: string; primary?: boolean }

export interface BridgeDef {
  /** Extension ids, lower-case. */
  ids: string[];
  kind: BridgeKind;
  title: string;
  /** What works, one or two sentences. */
  description: string;
  /** How it works (shown under "How it works"). */
  how: string;
  /** Tool ids that must be present; "a|b" = any of them. */
  requires?: string[];
  formatters?: FormatterId[];
  linters?: LinterId[];
  harness?: "claude-code" | "codex";
  server?: ServerBridge;
  actions?: BuiltinAction[];
  /** Boolean setting that is the feature's on/off switch (builtin bridges). */
  setting?: "inlineErrors" | "pathCompletion" | "autoRenameTag" | "editorConfig" | "inlineBlame" | "inlineCompletion";
  /** Cepheus offers an alternative, not the extension's own service (e.g. Copilot). */
  alternative?: boolean;
  /** Settings it changes, for the card. */
  settings?: string[];
}

export const BRIDGES: BridgeDef[] = [
  // ---- Agents --------------------------------------------------------------------------------
  {
    ids: ["anthropic.claude-code"], kind: "harness", harness: "claude-code", requires: ["claude"],
    title: "Claude Code as the Cepheus agent",
    description: "Runs the Claude Code CLI as the agent behind the Cepheus chat: same sessions, diffs, approvals and review policy.",
    how: "Cepheus starts `claude` headless in the workspace and streams its events into the agent panel. The extension's own UI code is not used.",
  },
  {
    ids: ["openai.chatgpt"], kind: "harness", harness: "codex", requires: ["codex"],
    title: "Codex as the Cepheus agent",
    description: "Runs OpenAI's Codex CLI as the agent behind the Cepheus chat.",
    how: "Cepheus starts `codex` headless in the workspace and streams its events into the agent panel. The extension's own UI code is not used.",
  },
  // ---- Formatters ----------------------------------------------------------------------------
  {
    ids: ["esbenp.prettier-vscode"], kind: "formatter", formatters: ["prettier"], requires: ["prettier"],
    title: "Prettier", description: "Formats JavaScript, TypeScript, JSON, CSS/SCSS/Less, HTML, Vue, Markdown, YAML and GraphQL with the project's Prettier and its config.",
    how: "Format Document and format on save pipe the buffer through `prettier --stdin-filepath <file>` from the project's node_modules (never downloaded on its own).",
    settings: ["defaultFormatter"],
  },
  {
    ids: ["ms-python.black-formatter"], kind: "formatter", formatters: ["black"], requires: ["black"],
    title: "Black", description: "Formats Python files with Black (uses pyproject.toml settings).",
    how: "Pipes the buffer through `black --stdin-filename <file> -` (Black from PATH or the workspace .venv).",
    settings: ["defaultFormatter"],
  },
  {
    ids: ["charliermarsh.ruff"], kind: "linter", formatters: ["ruff"], linters: ["ruff"], requires: ["ruff"],
    title: "Ruff", description: "Lints Python on open and save (Problems + squiggles) and formats with `ruff format`.",
    how: "Runs `ruff check --output-format json` on the saved file and `ruff format --stdin-filename <file> -` for formatting (Ruff from PATH or the workspace .venv).",
    settings: ["defaultFormatter"],
  },
  {
    ids: ["xaver.clang-format"], kind: "formatter", formatters: ["clang-format"], requires: ["clangFormat"],
    title: "clang-format", description: "Formats C, C++ and Objective-C with your .clang-format.",
    how: "Pipes the buffer through `clang-format --assume-filename=<file>`.", settings: ["defaultFormatter"],
  },
  {
    ids: ["mkhl.shfmt", "foxundermoon.shell-format"], kind: "formatter", formatters: ["shfmt"], requires: ["shfmt"],
    title: "shfmt", description: "Formats shell scripts (respects .editorconfig).",
    how: "Pipes the buffer through `shfmt -filename <file>`.", settings: ["defaultFormatter"],
  },
  {
    ids: ["junstyle.php-cs-fixer"], kind: "formatter", formatters: ["php-cs-fixer"], requires: ["phpCsFixer"],
    title: "PHP CS Fixer", description: "Formats PHP files with your .php-cs-fixer.php rules.",
    how: "Runs `php-cs-fixer fix` on a temporary copy of the buffer and reads it back.", settings: ["defaultFormatter"],
  },
  {
    ids: ["tamasfe.even-better-toml"], kind: "formatter", formatters: ["taplo"], requires: ["taplo"],
    title: "Taplo (TOML)", description: "Formats TOML files. Syntax highlighting comes from the extension's grammar.",
    how: "Pipes the buffer through `taplo fmt -`. (The extension's bundled server talks over Node IPC, which Cepheus doesn't use.)", settings: ["defaultFormatter"],
  },
  {
    ids: ["dart-code.dart-code", "dart-code.flutter"], kind: "formatter", formatters: ["dart"], requires: ["dart"],
    title: "dart format", description: "Formats Dart files with the Dart SDK.",
    how: "Pipes the buffer through `dart format`.", settings: ["defaultFormatter"],
  },
  // ---- Linters -------------------------------------------------------------------------------
  {
    ids: ["dbaeumer.vscode-eslint"], kind: "linter", linters: ["eslint"], requires: ["eslint"],
    title: "ESLint", description: "Lints JavaScript and TypeScript on open and save with the project's ESLint and config; results go to Problems and the editor.",
    how: "Runs `eslint -f json <file>` from the project's node_modules after each save (debounced, previous run cancelled).",
  },
  {
    ids: ["stylelint.vscode-stylelint"], kind: "linter", linters: ["stylelint"], requires: ["stylelint"],
    title: "Stylelint", description: "Lints CSS, SCSS and Less on open and save with the project's Stylelint config.",
    how: "Runs `stylelint -f json <file>` from the project's node_modules.",
  },
  {
    ids: ["timonwong.shellcheck"], kind: "linter", linters: ["shellcheck"], requires: ["shellcheck"],
    title: "ShellCheck", description: "Lints shell scripts on open and save.",
    how: "Runs `shellcheck -f json <file>`.",
  },
  {
    ids: ["davidanson.vscode-markdownlint"], kind: "linter", linters: ["markdownlint"], requires: ["markdownlint"],
    title: "markdownlint", description: "Lints Markdown on open and save with the project's markdownlint config.",
    how: "Runs `markdownlint-cli2 <file>` from the project's node_modules and reads its problem lines.",
  },
  {
    ids: ["exiasr.hadolint"], kind: "linter", linters: ["hadolint"], requires: ["hadolint"],
    title: "Hadolint", description: "Lints Dockerfiles on open and save.",
    how: "Runs `hadolint -f json <file>`.",
  },
  // ---- Language servers bundled in the .vsix -------------------------------------------------
  {
    ids: ["redhat.vscode-yaml"], kind: "languageServer", requires: ["node"],
    title: "YAML language server", description: "Validation, completion, hover, outline and formatting for YAML, with JSON schemas from SchemaStore (GitHub workflows, Compose, Kubernetes…).",
    how: "Unpacks the extension's bundled server (dist/) and runs it with Node over stdio.",
    server: {
      name: "YAML (extension)", languages: ["yaml"], extract: ["dist/"], entry: "dist/languageserver.js", size: "≈4 MB",
      initializationOptions: { l10nPath: "${dir}/dist/l10n" },
      config: { yaml: { validate: true, hover: true, completion: true, format: { enable: true }, schemaStore: { enable: true, url: "https://www.schemastore.org/api/json/catalog.json" } } },
    },
  },
  {
    ids: ["prisma.prisma"], kind: "languageServer", requires: ["node"],
    title: "Prisma language server", description: "Diagnostics, completion, hover, go to definition, rename and formatting for schema.prisma.",
    how: "Unpacks the extension's bundled server (dist/language-server/) and runs it with Node over stdio.",
    server: {
      name: "Prisma (extension)", languages: ["prisma"], extract: ["dist/language-server/"], entry: "dist/language-server/bin.js", size: "≈7 MB",
      config: { prisma: { enableDiagnostics: true } },
    },
  },
  {
    ids: ["graphql.vscode-graphql"], kind: "languageServer", requires: ["node", "graphqlConfig"],
    title: "GraphQL language server", description: "Completion, hover, go to definition and validation for .graphql files against your schema.",
    how: "Unpacks the extension's bundled server (out/serverStdio/) and runs it with Node over stdio. It reads the project's GraphQL config to find the schema.",
    server: { name: "GraphQL (extension)", languages: ["graphql"], extract: ["out/serverStdio/"], entry: "out/serverStdio/index.js", size: "≈10 MB" },
  },
  {
    ids: ["svelte.svelte-vscode"], kind: "languageServer", requires: ["node"],
    title: "Svelte language server", description: "Diagnostics, completion, hover, go to definition and formatting for .svelte files (TypeScript included).",
    how: "Unpacks the extension's bundled svelte-language-server (node_modules/) and runs it with Node over stdio.",
    server: {
      name: "Svelte (extension)", languages: ["svelte"], extract: ["node_modules/"], entry: "node_modules/svelte-language-server/bin/server.js", size: "≈55 MB",
      initializationOptions: { configuration: {}, dontFilterIncompleteCompletions: true },
    },
  },
  {
    ids: ["astro-build.astro-vscode"], kind: "languageServer", requires: ["node", "typescript"],
    title: "Astro language server", description: "Completion, hover, diagnostics and go to definition for .astro files.",
    how: "Unpacks the extension's bundled server (dist/node/ + node_modules/) and runs it with Node, using the project's TypeScript.",
    server: {
      name: "Astro (extension)", languages: ["astro"], extract: ["dist/node/", "node_modules/"], entry: "dist/node/server.js", size: "≈30 MB",
      initializationOptions: { typescript: { tsdk: "${workspace}/node_modules/typescript/lib" } },
    },
  },
  {
    ids: ["bradlc.vscode-tailwindcss"], kind: "languageServer", requires: ["node", "tailwindcss"],
    title: "Tailwind CSS IntelliSense", description: "Class completion, hover previews and color swatches in HTML and CSS files of projects that use Tailwind.",
    how: "Unpacks the extension's bundled server (dist/) and runs it with Node over stdio for HTML, CSS, SCSS and Less (not TS/JSX: Monaco's TypeScript service owns those).",
    server: { name: "Tailwind CSS (extension)", languages: ["html", "css", "scss", "less"], extract: ["dist/"], entry: "dist/tailwindServer.js", size: "≈7 MB" },
  },
  // ---- Built into Cepheus ---------------------------------------------------------------------
  {
    ids: ["eamodio.gitlens"], kind: "builtin", requires: ["git"], setting: "inlineBlame",
    title: "GitLens features", description: "Inline blame, file history timeline, commit graph and Time Machine are built in.",
    how: "Cepheus reads git directly; the toggle controls inline blame.",
    actions: [{ label: "Commit graph", command: "git.showCommits", primary: true }, { label: "File timeline", command: "git.timeline" }, { label: "Time Machine", command: "view.timeMachine" }],
    settings: ["inlineBlame"],
  },
  {
    ids: ["ritwickdey.liveserver", "ms-vscode.live-server"], kind: "builtin",
    title: "Live preview", description: "Preview HTML in the integrated browser with live reload; dev servers are detected automatically.",
    how: "Uses the built-in browser tab.",
    actions: [{ label: "Preview current HTML file", command: "browser.preview", primary: true }, { label: "Open URL…", command: "browser.open" }],
  },
  {
    ids: ["ms-azuretools.vscode-docker", "docker.docker", "ms-azuretools.vscode-containers"], kind: "builtin", requires: ["docker"],
    title: "Docker", description: "Containers, images, Compose up/down and cleanup from the Docker view.",
    how: "Uses the docker CLI.",
    actions: [{ label: "Open Docker view", command: "docker.show", primary: true }],
  },
  {
    ids: ["ms-python.python", "ms-python.vscode-pylance", "ms-pyright.pyright", "detachhead.basedpyright"], kind: "builtin", requires: ["pyright|basedpyright|pylsp"],
    title: "Python language server", description: "Completion, hover, diagnostics, go to definition and rename via Pyright (or basedpyright / pylsp).",
    how: "Cepheus' language server client starts the server from PATH; one click installs Pyright.",
    actions: [{ label: "Restart language servers", command: "lsp.restart" }],
  },
  {
    ids: ["rust-lang.rust-analyzer"], kind: "builtin", requires: ["rustAnalyzer"], formatters: ["rustfmt"],
    title: "rust-analyzer", description: "Rust language features via rust-analyzer from rustup, plus rustfmt formatting.",
    how: "Cepheus' language server client runs `rust-analyzer`; Format Document pipes through `rustfmt --emit stdout`.",
    actions: [{ label: "Restart language servers", command: "lsp.restart" }],
  },
  {
    ids: ["golang.go"], kind: "builtin", requires: ["gopls"], formatters: ["gofmt"],
    title: "Go", description: "Go language features via gopls, plus gofmt formatting.",
    how: "Cepheus' language server client runs `gopls`; Format Document pipes through `gofmt`.",
    actions: [{ label: "Restart language servers", command: "lsp.restart" }],
  },
  {
    ids: ["ms-vscode.cpptools", "ms-vscode.cpptools-extension-pack", "llvm-vs-code-extensions.vscode-clangd"], kind: "builtin", requires: ["clangd"],
    title: "C/C++ (clangd)", description: "C and C++ completion, diagnostics and navigation via clangd (uses compile_commands.json).",
    how: "Cepheus' language server client runs `clangd`.",
    actions: [{ label: "Restart language servers", command: "lsp.restart" }],
  },
  {
    ids: ["ms-vscode-remote.remote-ssh"], kind: "builtin",
    title: "Remote SSH", description: "Open folders on SSH hosts: files, terminals and git run on the remote machine.",
    how: "Built-in SSH/SFTP client.", actions: [{ label: "Open Remote view", sidebar: "remote", primary: true }],
  },
  {
    ids: ["ms-vscode-remote.remote-containers"], kind: "builtin", requires: ["docker"],
    title: "Dev Containers", description: "Reopen the folder in its devcontainer.json container, rebuild, and go back.",
    how: "Uses the docker CLI.", actions: [{ label: "Reopen in Container", command: "devcontainer.reopen", primary: true }, { label: "Rebuild and Reopen", command: "devcontainer.rebuild" }],
  },
  {
    ids: ["github.vscode-pull-request-github"], kind: "builtin",
    title: "GitHub pull requests", description: "List, review, comment on and check out pull requests and issues in the GitHub view.",
    how: "Uses the GitHub API with your token.", actions: [{ label: "Open GitHub view", sidebar: "github", primary: true }],
  },
  {
    ids: ["github.copilot", "github.copilot-chat"], kind: "builtin", alternative: true, setting: "inlineCompletion",
    title: "Copilot alternative",
    description: "GitHub Copilot needs GitHub's own service and extension code, so it does not run in Cepheus. Cepheus has its own agent and inline completions with the model provider you choose.",
    how: "The toggle turns on Cepheus inline completion (AI: Toggle Inline Completion); the agent panel replaces Copilot Chat.",
    actions: [{ label: "Open agent", command: "view.toggleAgent", primary: true }, { label: "Choose models…", command: "chat.manageModels" }],
    settings: ["inlineCompletion"],
  },
  {
    ids: ["usernamehw.errorlens"], kind: "builtin", setting: "inlineErrors",
    title: "Inline errors", description: "Shows the first error or warning of each line at the end of that line, colored by severity.",
    how: "Built in; the toggle is Settings → inlineErrors.", settings: ["inlineErrors"],
  },
  {
    ids: ["wayou.vscode-todo-highlight", "gruntfuggly.todo-tree"], kind: "builtin",
    title: "TODO tree", description: "Finds TODO / FIXME / HACK comments across the workspace in the Toolbox.",
    how: "Built in.", actions: [{ label: "Show TODO tree", command: "toolbox.todo", primary: true }],
  },
  {
    ids: ["christian-kohler.path-intellisense"], kind: "builtin", setting: "pathCompletion",
    title: "Path completion", description: "Completes relative file paths in strings (imports, src/href, url()) from the folder on disk.",
    how: "Built in; the toggle is Settings → pathCompletion.", settings: ["pathCompletion"],
  },
  {
    ids: ["formulahendry.auto-rename-tag"], kind: "builtin", setting: "autoRenameTag",
    title: "Auto rename tag", description: "Editing an HTML/XML/JSX opening tag renames its closing tag at the same time (and vice versa).",
    how: "Built in via linked editing; the toggle is Settings → autoRenameTag.", settings: ["autoRenameTag"],
  },
  {
    ids: ["editorconfig.editorconfig"], kind: "builtin", setting: "editorConfig",
    title: "EditorConfig", description: "Applies indent style/size, line endings, final newline and trailing whitespace rules from .editorconfig files.",
    how: "Built in; read when a file opens and applied on save. The toggle is Settings → editorConfig.", settings: ["editorConfig"],
  },
];

const byId = new Map<string, BridgeDef>();
for (const b of BRIDGES) for (const id of b.ids) byId.set(id.toLowerCase(), b);

/** Bridge for an extension id (publisher.name, any case). */
export function bridgeFor(extId: string | undefined | null): BridgeDef | null {
  return extId ? byId.get(extId.toLowerCase()) ?? null : null;
}

/** Stable key of a bridge (its first extension id). */
export const bridgeKey = (b: BridgeDef) => b.ids[0];

/** Install command for this OS, if any. */
export function installFor(tool: ToolDef, os: OS): string | undefined {
  return tool.install?.[os] ?? tool.install?.all;
}
