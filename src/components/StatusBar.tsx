import { set, useStore } from "../store";
import { saveSettings } from "../lib/workspace";
import { ProfileStatus } from "./ProfilesModal";
import LspInstallButton from "./LspInstallButton";
import { openBranchPicker } from "./BranchPicker";
import { aheadBehind, syncNow } from "../lib/gitApi";

export default function StatusBar() {
  const git = useStore((s) => s.git);
  const remote = useStore((s) => s.workspace?.match(/^ssh:\/\/([^/]+)/)?.[1] ?? null);
  const sshLabel = useStore((s) => (remote ? s.ssh[remote]?.label : undefined));
  const cursor = useStore((s) => s.cursor);
  const language = useStore((s) => s.language);
  const hasFile = useStore((s) => s.tabs.some((t) => t.id === s.activeId && t.kind === "file"));
  const settings = useStore((s) => s.settings);
  const running = useStore((s) => s.sessions.filter((x) => x.status === "running").length);
  const waiting = useStore((s) => s.sessions.filter((x) => x.status === "waiting").length);
  const lsp = useStore((s) => s.lsp[s.language]);
  const errors = useStore((s) => s.problems.filter((p) => p.severity === "error").length);
  const warnings = useStore((s) => s.problems.filter((p) => p.severity === "warning").length);

  return (
    <div className="statusbar">
      {remote && (
        <button className="remote-badge" onClick={() => set({ sidebar: "remote", view: "editor" })} title="Remote connection">
          <i className="codicon codicon-remote" /> SSH: {sshLabel ?? remote}
        </button>
      )}
      {git?.isRepo && (
        <>
          <button title="Checkout branch…" onClick={openBranchPicker}>
            <i className="codicon codicon-git-branch" /> {git.branch}
          </button>
          {git.files.length > 0 && <button title="Source Control" onClick={() => set({ sidebar: "git", view: "editor" })}>{git.files.length} changes</button>}
          <button title={`Synchronize changes (pull, then push)${git.aheadBehind ? ` — ${git.aheadBehind}` : ""}`} onClick={() => syncNow()}>
            <i className="codicon codicon-sync" /> {aheadBehind(git.aheadBehind).behind}↓ {aheadBehind(git.aheadBehind).ahead}↑
          </button>
        </>
      )}
      <button title="Problems" onClick={() => set((s) => ({ panelOpen: !(s.panelOpen && s.panelTab === "problems"), panelTab: "problems" }))}>
        <i className="codicon codicon-error" /> {errors} <i className="codicon codicon-warning" /> {warnings}
      </button>
      {(running > 0 || waiting > 0) && (
        <button onClick={() => set({ view: "manager" })} className={waiting ? "attention" : ""}>
          <i className={`codicon codicon-${waiting ? "bell-dot" : "loading codicon-modifier-spin"}`} />
          {running > 0 && ` ${running} agent${running > 1 ? "s" : ""} working`}
          {waiting > 0 && ` · ${waiting} waiting for approval`}
        </button>
      )}
      <div className="spacer" />
      <ProfileStatus />
      {hasFile && (
        <>
          <span>Ln {cursor.line}, Col {cursor.col}{cursor.selection ? ` (${cursor.selection} selected)` : ""}</span>
          <span>Spaces: {settings.tabSize}</span>
          <span>{language}</span>
          {lsp && (
            <span title={lsp.message ?? `${lsp.name}: ${lsp.status}`} className={`lsp-pill lsp-${lsp.status}`}>
              <i className={`codicon codicon-${lsp.status === "ready" ? "check" : lsp.status === "starting" ? "loading codicon-modifier-spin" : "error"}`} /> {lsp.name}
            </span>
          )}
          <LspInstallButton />
        </>
      )}
      <button
        title="Toggle AI inline completion"
        onClick={() => saveSettings({ ...settings, inlineCompletion: !settings.inlineCompletion })}
      >
        <i className={`codicon codicon-${settings.inlineCompletion ? "sparkle-filled" : "sparkle"}`} /> {settings.inlineCompletion ? "AI complete on" : "AI complete off"}
      </button>
      <button onClick={() => set({ settingsOpen: true })} title="Model">
        <i className="codicon codicon-hubot" /> {settings.models[settings.provider]}
      </button>
    </div>
  );
}
