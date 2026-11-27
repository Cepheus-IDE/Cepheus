//! Port manager: who listens on which TCP port, open it, free it.

import { openUrl } from "@tauri-apps/plugin-opener";
import { runCommand } from "../procBus";
import { errMsg } from "../api";
import { toast } from "../../store";
import { ListeningPort, parseNetstat, parseTasklist, parseUnixPorts } from "./portsParse";
import { isWindows } from "./state";

const SPLIT = "===CEPHEUS_TASKLIST===";

export async function listPorts(): Promise<ListeningPort[]> {
  if (isWindows()) {
    const r = await runCommand(`netstat -ano & echo ${SPLIT} & tasklist /fo csv /nh`, null).done;
    const [net, tasks = ""] = r.stdout.split(SPLIT);
    if (!net.trim()) throw new Error(r.stderr.trim() || "netstat produced no output");
    return parseNetstat(net, parseTasklist(tasks));
  }
  // lsof names processes on macOS and Linux; ss is the fallback when lsof is missing or finds nothing.
  const r = await runCommand(
    "out=$(lsof -nP +c 0 -iTCP -sTCP:LISTEN 2>/dev/null); if [ -n \"$out\" ]; then printf '%s\\n' \"$out\"; else ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null; fi",
    null,
  ).done;
  return parseUnixPorts(r.stdout);
}

export const localUrl = (port: number) => `http://localhost:${port}`;

export async function openPortInBrowser(port: number, external = false) {
  try {
    if (external) await openUrl(localUrl(port));
    else await (await import("../browser")).openBrowser(localUrl(port));
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

/** Ends the process (Windows: the whole tree, since dev servers spawn children). */
export async function killPid(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 4) throw new Error("Refusing to kill a system process");
  const cmd = isWindows()
    ? `taskkill /PID ${pid} /T /F`
    : `kill ${pid} 2>/dev/null; for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 ${pid} 2>/dev/null || exit 0; sleep 0.2; done; kill -9 ${pid}`;
  const r = await runCommand(cmd, null).done;
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `Could not stop process ${pid}`);
}

/** Frees `port`: finds its listeners and stops them. Returns what was stopped. */
export async function freePort(port: number): Promise<string[]> {
  const owners = (await listPorts()).filter((p) => p.port === port && p.pid);
  if (!owners.length) throw new Error(`Nothing is listening on port ${port} (or it belongs to another user)`);
  const done: string[] = [];
  for (const o of owners) {
    await killPid(o.pid!);
    done.push(`${o.process || "process"} (${o.pid})`);
  }
  return done;
}
