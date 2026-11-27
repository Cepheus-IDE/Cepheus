// Settings registry: every Settings key with its category, label, description and control.
// The Settings editor (SettingsModal.tsx) renders from this list; search, "Modified" filter and
// reset work on it. Keys another feature adds without registering land in "Other" automatically.
import { DEFAULT_SETTINGS, Settings } from "./settings";

export type CategoryId =
  | "motion" | "appearance" | "editor" | "languages" | "files" | "workbench" | "terminal"
  | "agent" | "git" | "notifications" | "keyboard" | "network" | "privacy" | "other";

export const CATEGORIES: { id: CategoryId; label: string; icon: string; blurb: string }[] = [
  { id: "motion", label: "Motion & Accessibility", icon: "accessibility", blurb: "Animation, cursor movement, scrolling, focus and screen readers." },
  { id: "appearance", label: "Appearance", icon: "symbol-color", blurb: "Color themes, Theme Studio, file icons and zoom." },
  { id: "editor", label: "Editor Text", icon: "edit", blurb: "Fonts, indentation, wrapping, guides, suggestions and save actions." },
  { id: "languages", label: "Language Features", icon: "symbol-namespace", blurb: "Type checking, language servers and snippets." },
  { id: "files", label: "Files & Explorer", icon: "files", blurb: "Auto save, deletion, sorting and hidden files." },
  { id: "workbench", label: "Workbench & Layout", icon: "layout", blurb: "Side bar, tabs, breadcrumbs, startup and density." },
  { id: "terminal", label: "Terminal", icon: "terminal", blurb: "Shell, font, cursor, clipboard and environment." },
  { id: "agent", label: "Agent & AI", icon: "hubot", blurb: "Provider, review policy, defaults, notifications and completions." },
  { id: "git", label: "Git", icon: "source-control", blurb: "Fetching, syncing, blame and commits." },
  { id: "notifications", label: "Notifications & Sounds", icon: "bell", blurb: "Toasts, do not disturb and sound effects." },
  { id: "keyboard", label: "Keyboard", icon: "keyboard", blurb: "Shortcuts and keymaps." },
  { id: "network", label: "Network & Updates", icon: "globe", blurb: "Proxy, certificates, extension registry and updates." },
  { id: "privacy", label: "Privacy & Data", icon: "shield", blurb: "Telemetry and clearing stored history." },
  { id: "other", label: "Other", icon: "ellipsis", blurb: "Settings added by other features." },
];

export type Control =
  | { type: "bool" }
  | { type: "enum"; options: [string, string][] }
  | { type: "number"; min: number; max: number; step?: number; unit?: string }
  | { type: "string"; placeholder?: string; multiline?: boolean }
  | { type: "list"; placeholder?: string; numeric?: boolean; presets?: [string, string][] }
  | { type: "map"; keyPlaceholder: string; valuePlaceholder: string }
  /** Rendered by a dedicated block in SettingsModal (one block may cover several keys). */
  | { type: "custom"; block: string }
  /** Stored data edited elsewhere (recent folders, SSH hosts…); not shown as a row. */
  | { type: "internal" };

export interface SettingDef {
  key: keyof Settings;
  category: CategoryId;
  group: string;
  label: string;
  description: string;
  control: Control;
  /** Only shown when this returns true (dependent settings, e.g. the wrap column). */
  when?: (s: Settings) => boolean;
  /** Excluded from "Reset category" (secrets, user data). */
  noReset?: boolean;
}

const bool = { type: "bool" } as const;
const en = (...options: [string, string][]): Control => ({ type: "enum", options });
const num = (min: number, max: number, step = 1, unit?: string): Control => ({ type: "number", min, max, step, unit });
const str = (placeholder?: string, multiline = false): Control => ({ type: "string", placeholder, multiline });
const custom = (block: string): Control => ({ type: "custom", block });
const internal = { type: "internal" } as const;
const AUTO_CLOSE = en(["languageDefined", "Language defined"], ["always", "Always"], ["beforeWhitespace", "Only before whitespace"], ["never", "Never"]);

type Row = [keyof Settings, string, string, Control, Partial<SettingDef>?];
const rows = (category: CategoryId, group: string, list: Row[]): SettingDef[] =>
  list.map(([key, label, description, control, extra]) => ({ key, category, group, label, description, control, ...extra }));

export const SETTINGS: SettingDef[] = [
  // ---------------------------------------------------------------- Motion & accessibility
  ...rows("motion", "Motion", [
    ["reduceMotion", "Reduce motion", "Turns off animations and transitions everywhere: UI transitions, smooth scrolling, smooth caret movement and cursor blinking in the editor and terminal. Starts on when your OS asks for reduced motion.", bool],
    ["smoothScrolling", "Smooth scrolling", "Animate editor scrolling. Ignored while Reduce motion is on.", bool],
    ["mouseWheelScrollSensitivity", "Mouse wheel scroll speed", "Multiplier for mouse wheel scrolling in the editor.", num(0.1, 5, 0.1, "×")],
    ["fastScrollSensitivity", "Fast scroll speed (Alt + wheel)", "Multiplier while holding Alt.", num(1, 20, 1, "×")],
  ]),
  ...rows("motion", "Cursor", [
    ["cursorBlinking", "Cursor blinking", "How the editor caret blinks. Reduce motion keeps it solid.", en(["blink", "Blink"], ["smooth", "Smooth fade"], ["phase", "Phase"], ["expand", "Expand"], ["solid", "Solid (no blinking)"])],
    ["cursorSmoothCaretAnimation", "Smooth caret movement", "Glide the caret to its new position. \"Explicit\" animates only clicks and keyboard moves, not typing.", en(["off", "Off"], ["explicit", "Explicit moves only"], ["on", "On"])],
    ["cursorStyle", "Cursor style", "Shape of the editor caret.", en(["line", "Line"], ["block", "Block"], ["underline", "Underline"], ["line-thin", "Thin line"], ["block-outline", "Block outline"], ["underline-thin", "Thin underline"])],
    ["cursorWidth", "Cursor width", "Width of the line caret in pixels.", num(1, 6, 1, "px"), { when: (s) => s.cursorStyle === "line" }],
    ["cursorSurroundingLines", "Lines kept around the cursor", "Minimum number of lines kept visible above and below the cursor while moving.", num(0, 20)],
  ]),
  ...rows("motion", "Vision & reading", [
    ["accessibilitySupport", "Screen reader optimized", "Optimizes the editor for screen readers; \"On\" also enables the terminal's screen reader mode.", en(["auto", "Auto-detect"], ["on", "On"], ["off", "Off"])],
    ["highContrastFocus", "High-contrast focus outlines", "Draw a thick accent outline around whatever has keyboard focus.", bool],
    ["uiFontScale", "Interface text scale", "Scales side bars, tabs, panels, menus and dialogs. Editor and terminal use their own font sizes.", num(0.8, 1.5, 0.05, "×")],
    ["reducedTransparency", "Reduce transparency", "Solid backgrounds instead of blurred, see-through overlays.", bool],
  ]),

  // ---------------------------------------------------------------- Appearance
  ...rows("appearance", "Theme", [
    ["theme", "Color theme", "Built-in, Theme Studio or extension color theme.", custom("appearance")],
    ["customThemes", "Your themes", "Themes made in Theme Studio or imported from VS Code.", custom("appearance"), { noReset: true }],
    ["iconTheme", "File icon theme", "Cepheus monograms or an icon theme from an extension.", custom("appearance")],
  ]),
  ...rows("appearance", "Window", [
    ["uiZoom", "Window zoom", "Zooms the whole window (Ctrl+= / Ctrl+- / Ctrl+0).", num(0.5, 2, 0.1, "×")],
  ]),

  // ---------------------------------------------------------------- Editor text
  ...rows("editor", "Font", [
    ["fontFamily", "Font family", "Editor font stack; empty = JetBrains Mono, Cascadia Code, Consolas.", str("'JetBrains Mono', Consolas, monospace")],
    ["fontSize", "Font size", "Editor font size in pixels.", num(6, 40, 1, "px")],
    ["fontWeight", "Font weight", "CSS font weight of editor text.", en(["normal", "Normal"], ["300", "Light (300)"], ["500", "Medium (500)"], ["600", "Semibold (600)"], ["bold", "Bold"])],
    ["lineHeight", "Line height", "0 = automatic; values below 8 are a multiple of the font size, larger values are pixels.", num(0, 60, 0.1)],
    ["letterSpacing", "Letter spacing", "Extra space between characters in pixels.", num(-2, 5, 0.1, "px")],
    ["fontLigatures", "Font ligatures", "Join character pairs such as => and != into one glyph when the font supports it.", bool],
  ]),
  ...rows("editor", "Indentation", [
    ["tabSize", "Tab size", "Number of spaces a tab equals.", num(1, 16)],
    ["insertSpaces", "Insert spaces", "Pressing Tab inserts spaces instead of a tab character.", bool],
    ["detectIndentation", "Detect indentation", "Use the indentation found in each file instead of the two settings above.", bool],
  ]),
  ...rows("editor", "Wrapping & rulers", [
    ["wordWrap", "Word wrap", "Wrap long lines instead of scrolling horizontally.", bool],
    ["wordWrapMode", "Wrap at", "Where lines wrap.", en(["viewport", "Window edge"], ["column", "Wrap column"], ["bounded", "Window edge or wrap column, whichever is first"]), { when: (s) => s.wordWrap }],
    ["wordWrapColumn", "Wrap column", "Column used by \"Wrap column\" and \"bounded\" wrapping.", num(20, 400), { when: (s) => s.wordWrap && s.wordWrapMode !== "viewport" }],
    ["rulers", "Rulers", "Vertical guide lines at these columns, e.g. 80, 120.", { type: "list", numeric: true, placeholder: "80" }],
  ]),
  ...rows("editor", "Rendering", [
    ["lineNumbers", "Line numbers", "\"Interval\" shows every 10th number.", en(["on", "On"], ["off", "Off"], ["relative", "Relative to cursor"], ["interval", "Every 10 lines"])],
    ["renderLineHighlight", "Highlight current line", "How the cursor line is highlighted.", en(["none", "None"], ["gutter", "Gutter only"], ["line", "Line"], ["all", "Gutter and line"])],
    ["renderWhitespace", "Show whitespace", "Render spaces and tabs as faint dots and arrows.", en(["none", "Never"], ["boundary", "Except single spaces between words"], ["selection", "In selected text"], ["trailing", "Trailing only"], ["all", "Always"])],
    ["renderControlCharacters", "Show control characters", "Render invisible control characters as symbols.", bool],
    ["bracketPairColorization", "Bracket pair colors", "Color matching brackets by nesting depth.", bool],
    ["bracketPairGuides", "Bracket pair guides", "Vertical lines connecting matching brackets.", bool],
    ["indentationGuides", "Indentation guides", "Vertical lines at each indentation level.", bool],
    ["glyphMargin", "Glyph margin", "Gutter column for breakpoints and other markers.", bool],
    ["scrollBeyondLastLine", "Scroll beyond last line", "Allow scrolling until the last line is at the top.", bool],
  ]),
  ...rows("editor", "Sticky scroll & minimap", [
    ["stickyScroll", "Sticky scroll", "Keep the enclosing functions/classes pinned to the top while scrolling.", bool],
    ["stickyScrollMaxLines", "Sticky scroll lines", "Maximum pinned lines.", num(1, 20), { when: (s) => s.stickyScroll }],
    ["minimap", "Minimap", "Code overview next to the scroll bar.", bool],
    ["minimapSide", "Minimap side", "Which side the minimap is on.", en(["right", "Right"], ["left", "Left"]), { when: (s) => s.minimap }],
    ["minimapSize", "Minimap size", "Proportional = real scale; Fill/Fit stretch or shrink to the editor height.", en(["proportional", "Proportional"], ["fill", "Fill"], ["fit", "Fit"]), { when: (s) => s.minimap }],
    ["minimapRenderCharacters", "Minimap characters", "Render real characters instead of color blocks.", bool, { when: (s) => s.minimap }],
    ["minimapShowSlider", "Minimap slider", "When the visible-area slider is shown.", en(["mouseover", "On hover"], ["always", "Always"]), { when: (s) => s.minimap }],
  ]),
  ...rows("editor", "Folding, lenses & hints", [
    ["folding", "Code folding", "Fold regions from the gutter.", bool],
    ["foldingStrategy", "Folding strategy", "Language-aware ranges or indentation only.", en(["auto", "Language aware"], ["indentation", "Indentation"]), { when: (s) => s.folding }],
    ["codeLens", "Code lens", "Actionable hints above code (references, tests, merge actions).", bool],
    ["inlayHints", "Inlay hints", "Inline parameter names and types from language servers. Hold Ctrl+Alt to flip the \"unless pressed\" variants.", en(["on", "On"], ["off", "Off"], ["onUnlessPressed", "On, hidden while Ctrl+Alt held"], ["offUnlessPressed", "Off, shown while Ctrl+Alt held"])],
    ["hoverDelay", "Hover delay", "Delay before hover information appears.", num(0, 3000, 50, "ms")],
  ]),
  ...rows("editor", "Suggestions", [
    ["quickSuggestions", "Suggestions while typing", "Show completions automatically in code (not in comments or strings).", bool],
    ["quickSuggestionsDelay", "Suggestion delay", "Delay before suggestions appear.", num(0, 2000, 10, "ms"), { when: (s) => s.quickSuggestions }],
    ["acceptSuggestionOnEnter", "Accept suggestion on Enter", "\"Smart\" accepts on Enter only when the suggestion changes text.", en(["on", "On"], ["smart", "Smart"], ["off", "Off (Tab only)"])],
    ["suggestPreview", "Suggestion preview", "Preview the selected suggestion inline.", bool],
    ["snippetSuggestions", "Snippet suggestions", "Where snippets appear in the suggestion list.", en(["top", "Top"], ["bottom", "Bottom"], ["inline", "Mixed in"], ["none", "Hidden"])],
    ["parameterHints", "Parameter hints", "Signature help while typing call arguments.", bool],
  ]),
  ...rows("editor", "Typing", [
    ["autoClosingBrackets", "Auto-close brackets", "Insert the closing bracket after an opening one.", AUTO_CLOSE],
    ["autoClosingQuotes", "Auto-close quotes", "Insert the closing quote after an opening one.", AUTO_CLOSE],
    ["autoSurround", "Auto-surround selection", "Typing a quote or bracket with text selected wraps the selection.", en(["languageDefined", "Language defined"], ["quotes", "Quotes only"], ["brackets", "Brackets only"], ["never", "Never"])],
    ["formatOnType", "Format on type", "Format the line after typing (e.g. after ; or }) when the language supports it.", bool],
    ["formatOnPaste", "Format on paste", "Format pasted text with the language formatter.", bool],
    ["multiCursorModifier", "Multi-cursor modifier", "Hold this key and click to add a cursor (the other one opens links / goes to definition).", en(["alt", "Alt"], ["ctrlCmd", "Ctrl / Cmd"])],
    ["dragAndDrop", "Drag and drop text", "Move selected text by dragging it.", bool],
  ]),
  ...rows("editor", "On save", [
    ["formatOnSave", "Format on save", "Run the language formatter before writing the file (files open in the editor).", bool],
    ["trimTrailingWhitespace", "Trim trailing whitespace", "Remove spaces and tabs at line ends when saving.", bool],
    ["insertFinalNewline", "Insert final newline", "End the file with a newline when saving.", bool],
    ["trimFinalNewlines", "Trim final newlines", "Remove extra empty lines at the end of the file when saving.", bool],
    ["eol", "Default line ending", "Line ending for new and empty files; existing files keep theirs. Files are always read and written as UTF-8.", en(["auto", "Platform default"], ["lf", "LF (\\n)"], ["crlf", "CRLF (\\r\\n)"])],
  ]),
  ...rows("editor", "Highlighting", [
    ["links", "Clickable links", "Detect URLs and make them Ctrl+clickable.", bool],
    ["occurrencesHighlight", "Highlight occurrences", "Highlight other uses of the symbol under the cursor.", bool],
    ["selectionHighlight", "Highlight selection matches", "Highlight other occurrences of the selected text.", bool],
    ["unicodeHighlightAmbiguous", "Highlight ambiguous characters", "Mark characters that look like ASCII ones (e.g. Cyrillic а).", bool],
    ["unicodeHighlightInvisible", "Highlight invisible characters", "Mark zero-width and other invisible characters.", bool],
  ]),

  // ---------------------------------------------------------------- Language features
  ...rows("languages", "Checking", [
    ["tsSemanticValidation", "Type-check TypeScript", "Semantic errors and quick fixes in the editor; unresolvable imports are ignored.", bool],
    ["lspWorkspaceDiagnostics", "Problems for closed files", "Ask language servers for problems in every workspace file, not only open ones (restart servers to apply).", bool],
  ]),
  ...rows("languages", "Language servers", [
    ["languageServers", "Language servers", "Command line per language; empty = auto-detect on PATH.", custom("languageServers"), { noReset: true }],
  ]),

  // ---------------------------------------------------------------- Files & explorer
  ...rows("files", "Saving", [
    ["autoSave", "Auto save", "Save edited files automatically.", bool],
    ["autoSaveMode", "Auto save when", "After a delay, when you switch to another tab, or when the window loses focus.", en(["afterDelay", "After a delay"], ["onFocusChange", "Editor loses focus"], ["onWindowChange", "Window loses focus"]), { when: (s) => s.autoSave }],
    ["autoSaveDelay", "Auto save delay", "Delay after the last edit.", num(100, 60000, 100, "ms"), { when: (s) => s.autoSave && s.autoSaveMode === "afterDelay" }],
  ]),
  ...rows("files", "Explorer", [
    ["confirmDelete", "Confirm before deleting", "Ask before moving a file or folder to the trash.", bool],
    ["explorerSortOrder", "Sort order", "How files and folders are ordered.", en(["default", "Folders first, by name"], ["mixed", "Mixed, by name"], ["filesFirst", "Files first, by name"], ["type", "Folders first, by file type"])],
    ["filesExclude", "Hidden files", "Glob patterns hidden from the explorer (e.g. **/node_modules, *.log).", { type: "list", placeholder: "**/node_modules", presets: [["**/.git", ".git"], ["**/node_modules", "node_modules"], ["**/dist", "dist"], ["**/target", "target"]] }],
    ["watcherExclude", "Ignore changes in", "Glob patterns whose file-system changes don't refresh editors, the tree or Git.", { type: "list", placeholder: "**/build/**" }],
  ]),

  // ---------------------------------------------------------------- Workbench & layout
  ...rows("workbench", "Layout", [
    ["sidebarPosition", "Side bar position", "Put the side bar and activity bar on the left or right.", en(["left", "Left"], ["right", "Right"])],
    ["activityBarVisible", "Show activity bar", "The icon strip that switches side bar views.", bool],
    ["statusBarVisible", "Show status bar", "The bar at the bottom of the window.", bool],
    ["commandCenter", "Show command center", "The search box in the title bar.", bool],
    ["compactDensity", "Compact density", "Tighter rows, tabs and panel headers.", bool],
  ]),
  ...rows("workbench", "Tabs", [
    ["tabPreview", "Preview tabs", "Opening a file reuses one italic preview tab until you edit it or double-click its tab.", bool],
    ["tabCloseButton", "Tab close button", "Where the close button sits on tabs.", en(["right", "Right"], ["left", "Left"], ["off", "Hidden (middle-click closes)"])],
    ["wrapTabs", "Wrap tabs", "Show tabs on several rows instead of scrolling.", bool],
    ["breadcrumbs", "Breadcrumbs", "File path above the editor.", bool],
  ]),
  ...rows("workbench", "Startup", [
    ["startupPage", "On startup", "What Cepheus shows when it starts.", en(["welcome", "Welcome page"], ["none", "Empty editor"], ["lastFolder", "Reopen the last folder"])],
    ["restoreTabs", "Restore open tabs", "Reopen a folder's file tabs when you open it again.", bool],
  ]),

  // ---------------------------------------------------------------- Terminal
  ...rows("terminal", "Shell", [
    ["shell", "Shell", "Executable for new terminals; empty = pwsh/PowerShell on Windows, $SHELL elsewhere.", str("pwsh.exe / bash / zsh")],
    ["shellArgs", "Shell arguments", "Arguments passed to the shell above.", { type: "list", placeholder: "-NoLogo" }],
    ["terminalCwd", "Start folder", "Folder new terminals start in; empty = the open folder. Relative paths resolve against it.", str("(open folder)")],
    ["terminalEnv", "Environment variables", "Set in new local terminals (PowerShell, cmd, and POSIX shells).", { type: "map", keyPlaceholder: "NAME", valuePlaceholder: "value" }],
  ]),
  ...rows("terminal", "Appearance", [
    ["terminalFontFamily", "Font family", "Empty = Cascadia Mono, Consolas.", str("'Cascadia Mono', monospace")],
    ["terminalFontSize", "Font size", "Terminal font size in pixels.", num(6, 40, 1, "px")],
    ["terminalLineHeight", "Line height", "Multiple of the font size.", num(1, 2, 0.05, "×")],
    ["terminalCursorStyle", "Cursor style", "Shape of the terminal cursor.", en(["block", "Block"], ["underline", "Underline"], ["bar", "Bar"])],
    ["terminalCursorBlink", "Cursor blinking", "Blink the terminal cursor. Off while Reduce motion is on.", bool],
    ["terminalScrollback", "Scrollback", "Lines kept above the visible area.", num(100, 100000, 100, "lines")],
  ]),
  ...rows("terminal", "Behaviour", [
    ["terminalCopyOnSelect", "Copy on select", "Selecting text copies it to the clipboard.", bool],
    ["terminalRightClick", "Right click", "\"Copy / paste\" copies the selection, or pastes when nothing is selected.", en(["menu", "Show context menu"], ["paste", "Copy / paste"])],
    ["terminalConfirmKill", "Confirm before killing", "Ask before killing a terminal.", bool],
    ["terminalBell", "Bell", "What happens when a program rings the bell.", en(["none", "Nothing"], ["visual", "Flash the terminal"], ["sound", "Play a sound"])],
  ]),

  // ---------------------------------------------------------------- Agent & AI
  ...rows("agent", "Provider", [
    ["provider", "Provider", "AI provider used by the agent.", custom("aiProvider")],
    ["keys", "API keys", "Per-provider API keys, stored locally.", custom("aiProvider"), { noReset: true }],
    ["models", "Models", "Model per provider.", custom("aiProvider")],
    ["baseUrls", "Base URLs", "Optional API base URL per provider.", custom("aiProvider")],
    ["effort", "Effort", "Reasoning effort (Anthropic).", custom("aiProvider")],
    ["modelPick", "Default chat model", "Model chosen in the Language Models manager.", custom("aiProvider")],
    ["customProviders", "Custom providers", "Extra OpenAI-compatible providers (Language Models manager).", custom("aiProvider"), { noReset: true }],
    ["hiddenModels", "Hidden models", "Models hidden from pickers (Language Models manager).", custom("aiProvider"), { noReset: true }],
  ]),
  ...rows("agent", "Agent defaults", [
    ["approvalMode", "Review policy", "What the agent may do without asking.", en(["ask", "Ask before file edits and commands"], ["auto-edit", "Edit files automatically, ask before commands"], ["turbo", "Turbo: run everything automatically"])],
    ["agentPlanModeDefault", "Plan mode for new tasks", "New tasks start in read-only Plan mode.", bool],
    ["agentVerifyDefault", "Verify with checks for new tasks", "New tasks run the project's checks after editing.", bool],
    ["agentMaxTurns", "Max tool calls per run", "Stop a run after this many tool calls (0 = built-in limit of 60 steps).", num(0, 500)],
    ["agentIncludeOpenFile", "Include open file by default", "Attach the active file and selection to messages (toggle per message in the chat box).", bool],
    ["agentAutoOpenChanges", "Open Changes when done", "Show the agent panel with the changed-files list when a task finishes with edits.", bool],
    ["customInstructions", "Custom instructions", "Extra instructions sent with every agent task.", str("e.g. Use TypeScript strict mode. Prefer functional components.", true)],
  ]),
  ...rows("agent", "Agent notifications", [
    ["agentNotifyApproval", "Notify when approval is needed", "Toast (and system notification when the window is in the background) when the agent waits for you.", bool],
    ["agentNotifyDone", "Notify when a task finishes", "Toast (and system notification when in the background) when a task completes.", bool],
    ["agentNotifySystem", "Use system notifications", "Also show an OS notification while Cepheus is in the background, when the platform allows it.", bool],
  ]),
  ...rows("agent", "Completions & commits", [
    ["inlineCompletion", "AI inline completion", "Ghost-text suggestions while typing (uses API tokens).", bool],
    ["completionModel", "Completion model", "Empty = the agent model; a small fast model works best.", str("(agent model)"), { when: (s) => s.inlineCompletion }],
    ["inlineCompletionDebounce", "Completion delay", "Pause after typing before asking for a completion.", num(100, 5000, 50, "ms"), { when: (s) => s.inlineCompletion }],
    ["commitMessageStyle", "Commit message style", "Style of AI-generated commit messages.", en(["plain", "Plain imperative"], ["conventional", "Conventional Commits (feat:, fix: …)"])],
  ]),
  ...rows("agent", "Tools", [
    ["mcpServers", "MCP servers", "Tools from Model Context Protocol servers.", custom("mcpServers"), { noReset: true }],
  ]),

  // ---------------------------------------------------------------- Git
  ...rows("git", "Remote", [
    ["gitAutofetch", "Auto fetch", "Fetch from remotes in the background.", bool],
    ["gitAutofetchInterval", "Fetch interval", "Time between background fetches.", num(30, 3600, 30, "s"), { when: (s) => s.gitAutofetch }],
    ["gitConfirmSync", "Confirm before sync", "Ask before pulling and pushing with Sync.", bool],
  ]),
  ...rows("git", "Editor", [
    ["inlineBlame", "Inline blame", "Show who last changed the cursor line.", bool],
    ["blameFormat", "Blame format", "Template with {author} {ago} {date} {summary} {hash}.", str("{author}, {ago} • {summary}"), { when: (s) => s.inlineBlame }],
    ["quickDiff", "Gutter change markers", "Added / modified / deleted markers vs HEAD in the gutter.", bool],
  ]),
  ...rows("git", "Commits", [
    ["gitSmartCommit", "Smart commit", "Commit all changes when nothing is staged (sets the commit options default).", bool],
    ["gitPostCommit", "After commit", "Run this after a successful commit.", en(["none", "Nothing"], ["push", "Push"], ["sync", "Sync (pull, then push)"])],
    ["gitDefaultBranch", "Initial branch name", "Branch name for \"Initialize Repository\"; empty = Git's default.", str("main")],
  ]),

  // ---------------------------------------------------------------- Notifications
  ...rows("notifications", "Toasts", [
    ["toastDuration", "Toast duration", "How long messages stay; errors stay twice as long.", num(1, 30, 0.5, "s")],
    ["doNotDisturb", "Do not disturb", "Hide informational toasts, system notifications and sounds. Errors still show.", bool],
  ]),
  ...rows("notifications", "Sounds", [
    ["soundEffects", "Sound effects", "Short tones when the agent finishes or needs approval.", bool],
    ["soundVolume", "Volume", "Sound effect volume.", num(0, 1, 0.05), { when: (s) => s.soundEffects }],
  ]),

  // ---------------------------------------------------------------- Keyboard
  ...rows("keyboard", "Shortcuts", [
    ["keybindings", "Keyboard shortcuts", "Your shortcut overrides.", custom("keyboard"), { noReset: true }],
  ]),

  // ---------------------------------------------------------------- Network & updates
  ...rows("network", "Network", [
    ["proxy", "Proxy", "HTTP(S) proxy for backend requests, git and docker.", custom("network")],
    ["trustedCertificates", "Trusted certificates", "Extra CA certificates (PEM files).", custom("network"), { noReset: true }],
    ["extensionRegistryUrl", "Extension registry", "Open VSX-compatible registry URL; empty = open-vsx.org.", str("https://open-vsx.org")],
  ]),
  ...rows("network", "Updates", [
    ["updateMode", "Updates", "How Cepheus checks for updates.", en(["automatic", "Automatic — download, then ask to restart"], ["startup", "Check on startup and notify"], ["manual", "Manual (Help › Check for Updates…)"], ["none", "Never check"])],
  ]),

  // ---------------------------------------------------------------- Privacy
  ...rows("privacy", "Telemetry", [
    ["telemetryLevel", "Telemetry", "Cepheus collects no telemetry. This is always off.", en(["off", "Off"])],
  ]),
  ...rows("privacy", "Stored data", [
    ["recent", "Recent folders", "Folders shown on the Welcome page and in Open Recent.", custom("privacy"), { noReset: true }],
  ]),

  // ---------------------------------------------------------------- Internal data (not rows)
  ...rows("other", "Internal", [
    ["disabledExtensions", "Disabled extensions", "Managed in the Extensions view.", internal, { noReset: true }],
    ["extensionOptions", "Extension options", "Grammar overrides, auto-update, pinned versions and keymap; managed in the Extensions view.", internal, { noReset: true }],
    ["githubToken", "GitHub token", "Managed in the GitHub view.", internal, { noReset: true }],
    ["sshHosts", "SSH hosts", "Managed in the Remote view.", internal, { noReset: true }],
  ]),
];

const BY_KEY = new Map(SETTINGS.map((d) => [d.key as string, d]));
export const settingDef = (key: string) => BY_KEY.get(key);

/** All definitions, plus generic ones for keys added to Settings without registering here. */
export function allDefs(): SettingDef[] {
  const extra: SettingDef[] = [];
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (BY_KEY.has(k)) continue;
    const control: Control = typeof v === "boolean" ? bool : typeof v === "number" ? num(-1e9, 1e9, 1) : typeof v === "string" ? str() : internal;
    extra.push({ key: k as keyof Settings, category: "other", group: "Other", label: k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()), description: `Setting "${k}".`, control });
  }
  return extra.length ? [...SETTINGS, ...extra] : SETTINGS;
}

export const isModified = (s: Settings, key: keyof Settings) => JSON.stringify(s[key]) !== JSON.stringify(DEFAULT_SETTINGS[key]);

/** Lowercased haystack for search. */
export function searchText(d: SettingDef): string {
  const opts = d.control.type === "enum" ? d.control.options.map((o) => o[1]).join(" ") : "";
  const cat = CATEGORIES.find((c) => c.id === d.category)?.label ?? "";
  return `${d.label} ${d.description} ${d.key} ${d.group} ${cat} ${opts}`.toLowerCase();
}

/** Every search word must appear somewhere. */
export function matches(d: SettingDef, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = searchText(d);
  return words.every((w) => hay.includes(w));
}
