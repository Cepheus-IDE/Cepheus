/** `cepheus web`: starts the browser UI server when this build includes it (src/web). */
import { c } from "./ansi.js";

export async function runWeb(opts: { root: string; port: number; host: string; open: boolean }): Promise<number> {
  // Non-literal specifier: the web module is optional and built separately (src/web/server.ts).
  const spec = "../web/server.js";
  let mod: any;
  try {
    mod = await import(spec);
  } catch (e: any) {
    const missing = e?.code === "ERR_MODULE_NOT_FOUND" && String(e?.message ?? "").includes("server.js");
    if (missing) {
      process.stderr.write("Web UI not built in this version\n");
      return 1;
    }
    throw e;
  }
  if (typeof mod?.startWebServer !== "function") {
    process.stderr.write("Web UI not built in this version\n");
    return 1;
  }
  if (opts.host !== "127.0.0.1" && opts.host !== "localhost" && opts.host !== "::1") {
    process.stderr.write(
      c.yellow(`Warning: listening on ${opts.host} exposes the agent (which can edit files and run commands) to your network.\n`),
    );
  }
  await mod.startWebServer({ root: opts.root, port: opts.port, host: opts.host, open: opts.open });
  // The server keeps the process alive until it is closed (Ctrl+C).
  return -1;
}
