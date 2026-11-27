//! Lets other features run a command in a visible terminal and learn its exit code
//! (one-click language server installs). TerminalPanel listens for the event.

import { set } from "../store";

export interface TermProfile { id: string; label: string; shell: string; args?: string[] }
export interface RunRequest { title: string; command: string; onExit?: (code: number) => void }

export const RUN_EVENT = "cepheus:run-in-terminal";

export function runInTerminal(req: RunRequest) {
  set({ panelOpen: true, panelTab: "terminal" });
  // Let the panel mount/show first.
  setTimeout(() => window.dispatchEvent(new CustomEvent<RunRequest>(RUN_EVENT, { detail: req })), 0);
}

/** Marker printed after the command finishes; built by concatenation so the echoed command line doesn't match. */
export const DONE_RE = /__CEPHEUS_DONE_(-?\d+)__/;

/**
 * PowerShell line that runs `command` through cmd.exe (so npm/pip .cmd shims work regardless of
 * the script execution policy) and then prints the exit code marker.
 */
export function wrapForPowerShell(command: string): string {
  const escaped = command.replace(/"/g, '""');
  return `cmd /d /c "${escaped}"; Write-Host ("__CEPHEUS_" + "DONE_" + $LASTEXITCODE + "__")\r`;
}

let profilesCache: Promise<TermProfile[]> | null = null;

/** Shell profiles available on this machine (Windows: PowerShell, pwsh, cmd, Git Bash, WSL). */
export function detectProfiles(): Promise<TermProfile[]> {
  if (!profilesCache) {
    profilesCache = (async () => {
      const { api } = await import("./api");
      if (!navigator.userAgent.includes("Windows")) {
        const found = await api.which(["bash", "zsh", "fish", "sh"]).catch(() => [] as string[]);
        return found.map((s) => ({ id: s, label: s, shell: s }));
      }
      const list: TermProfile[] = [{ id: "powershell", label: "Windows PowerShell", shell: "powershell.exe" }];
      const found = new Set(await api.which(["pwsh", "wsl"]).catch(() => [] as string[]));
      if (found.has("pwsh")) list.push({ id: "pwsh", label: "PowerShell 7 (pwsh)", shell: "pwsh.exe" });
      list.push({ id: "cmd", label: "Command Prompt", shell: "cmd.exe" });
      for (const p of ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe"]) {
        if (await api.exists(p).catch(() => false)) { list.push({ id: "gitbash", label: "Git Bash", shell: p, args: ["--login", "-i"] }); break; }
      }
      if (found.has("wsl")) list.push({ id: "wsl", label: "WSL", shell: "wsl.exe" });
      return list;
    })();
  }
  return profilesCache;
}
