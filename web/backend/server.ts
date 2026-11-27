/** Server mode: every command goes over the `cepheus web` WebSocket (see cli/src/web/server.ts). */
import type { Backend } from "./types";
import { dispatch } from "../shims/bus";

export interface ServerInfo {
  root: string;
  home: string;
  platform: string;
  sep: string;
  pty: boolean;
}

type Pending = { resolve: (v: any) => void; reject: (e: any) => void };

export function connectServer(token: string | null, onState: (s: "connected" | "reconnecting" | "unauthorized") => void): Promise<{ backend: Backend; info: ServerInfo }> {
  const url = new URL("/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.search = token ? `?token=${encodeURIComponent(token)}` : "";
  let ws: WebSocket | null = null;
  let info: ServerInfo | null = null;
  let nextId = 0;
  const pending = new Map<number, Pending>();
  const queue: string[] = [];
  let everConnected = false;

  return new Promise((resolveFirst, rejectFirst) => {
    const backend: Backend = {
      mode: "server",
      invoke(cmd, args) {
        return new Promise((resolve, reject) => {
          const id = ++nextId;
          pending.set(id, { resolve, reject });
          const msg = JSON.stringify({ t: "invoke", id, cmd, args });
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
          else queue.push(msg);
        });
      },
      dataDir: () => (info ? info.home.replace(/[\\/]+$/, "") + info.sep + ".cepheus" + info.sep + "web-data" : "/"),
      homeDir: () => info?.home ?? "/",
      rootDir: () => info?.root ?? null,
    };

    const open = () => {
      const sock = new WebSocket(url.toString());
      ws = sock;
      sock.onmessage = (ev) => {
        let m: any;
        try {
          m = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (m.t === "hello") {
          info = { root: m.root, home: m.home, platform: m.platform, sep: m.sep, pty: !!m.pty };
          onState("connected");
          for (const q of queue.splice(0)) sock.send(q);
          if (!everConnected) {
            everConnected = true;
            resolveFirst({ backend, info });
          }
        } else if (m.t === "result") {
          const p = pending.get(m.id);
          if (!p) return;
          pending.delete(m.id);
          if (m.ok) p.resolve(m.value);
          else p.reject(String(m.error ?? "Unknown error"));
        } else if (m.t === "event") {
          dispatch(m.event, m.payload);
        }
      };
      sock.onclose = () => {
        for (const p of pending.values()) p.reject("Lost the connection to `cepheus web`; reconnecting…");
        pending.clear();
        if (!everConnected) {
          onState("unauthorized");
          rejectFirst(new Error("Could not connect to the Cepheus Web server (wrong or missing token?)"));
          return;
        }
        onState("reconnecting");
        setTimeout(open, 2000);
      };
    };
    open();
  });
}
