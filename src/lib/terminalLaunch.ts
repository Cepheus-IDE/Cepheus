// Shell + args for a new local terminal, with Settings › Terminal environment variables applied.
// term_spawn has no env parameter, so variables are set by the launch command itself:
// PowerShell `-NoExit -Command $env:K='v'`, cmd `/K set "K=v"`, POSIX shells via `/usr/bin/env K=v`.

const psQuote = (v: string) => "'" + v.replace(/'/g, "''") + "'";
const validName = (k: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);

export function terminalLaunch(
  shell: string | undefined,
  args: string[] | undefined,
  env: Record<string, string>,
  windows: boolean,
  defaultWindowsShell = "powershell.exe",
): { shell: string | undefined; args: string[] | undefined } {
  const vars = Object.entries(env ?? {}).filter(([k]) => validName(k));
  if (!vars.length) return { shell, args };
  if (!windows) {
    // env K=v <shell> [args]; with no shell configured, start the user's login shell.
    const pairs = vars.map(([k, v]) => `${k}=${v}`);
    return shell
      ? { shell: "/usr/bin/env", args: [...pairs, shell, ...(args ?? [])] }
      : { shell: "/usr/bin/env", args: [...pairs, "sh", "-c", 'exec "${SHELL:-/bin/sh}" -l'] };
  }
  const sh = shell || defaultWindowsShell;
  const name = sh.split(/[\\/]/).pop()!.toLowerCase();
  if (/^(pwsh|powershell)(\.exe)?$/.test(name)) {
    const cmd = vars.map(([k, v]) => `$env:${k}=${psQuote(v)}`).join("; ");
    return { shell: sh, args: [...(args ?? []), "-NoExit", "-Command", cmd] };
  }
  if (/^cmd(\.exe)?$/.test(name)) {
    const cmd = vars.map(([k, v]) => `set "${k}=${v.replace(/"/g, "")}"`).join(" && ");
    return { shell: sh, args: [...(args ?? []), "/K", cmd] };
  }
  // Other Windows shells (Git Bash, WSL…): no portable way without backend support.
  return { shell, args };
}
