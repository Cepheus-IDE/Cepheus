// Dev-server URL detection in terminal / process output (pure functions, unit-testable with Node).

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

// Loopback / bind-all hosts with an explicit port, e.g. http://localhost:5173/, https://127.0.0.1:8443/app.
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})(?:\/[^\s"'<>`)\]]*)?/gi;

/** Returns normalised local dev-server URLs found in `text` (0.0.0.0 and [::] become 127.0.0.1 / localhost). */
export function detectUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of stripAnsi(text).matchAll(LOCAL_URL)) {
    let u = m[0].replace(/[.,;:!?]+$/, "");
    u = u.replace(/\/\/0\.0\.0\.0/i, "//127.0.0.1").replace(/\/\/\[::\]/, "//localhost");
    const port = Number(u.match(/:(\d+)(?:\/|$)/)?.[1]);
    if (!port || port > 65535) continue;
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

/** Key used to show the prompt only once per server (scheme + host-insensitive port). */
export function serverKey(url: string): string {
  const m = url.match(/^(https?):\/\/[^/]*:(\d+)/i);
  return m ? `${m[1].toLowerCase()}:${m[2]}` : url;
}

/**
 * Feeds streamed chunks (which can split a URL across chunk boundaries) and reports newly seen
 * URLs. One instance per stream id.
 */
export class UrlScanner {
  private tail = "";
  feed(chunk: string): string[] {
    const text = this.tail + chunk;
    // Keep the last partial line so a URL split across chunks is seen whole next time.
    const nl = text.lastIndexOf("\n");
    const complete = nl >= 0 ? text.slice(0, nl + 1) : "";
    this.tail = (nl >= 0 ? text.slice(nl + 1) : text).slice(-400);
    const found = detectUrls(complete);
    // A partial line that already contains a full URL followed by whitespace is safe to report too.
    const partial = this.tail.match(/https?:\/\/\S+\s/);
    if (partial) {
      found.push(...detectUrls(partial[0]).filter((u) => !found.includes(u)));
      this.tail = this.tail.slice(this.tail.indexOf(partial[0]) + partial[0].length);
    }
    return found;
  }
}
