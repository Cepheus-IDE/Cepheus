/** Backend registry and the event bus behind the `@tauri-apps/api/event` shim. */
import type { Backend } from "../backend/types";

let current: Backend | null = null;
let resolveReady!: (b: Backend) => void;
const ready = new Promise<Backend>((r) => (resolveReady = r));

export function setBackend(b: Backend) {
  current = b;
  resolveReady(b);
}

export function getBackend(): Promise<Backend> {
  return current ? Promise.resolve(current) : ready;
}

export function backendNow(): Backend | null {
  return current;
}

export interface TauriLikeEvent<T> {
  event: string;
  id: number;
  payload: T;
}

type Cb = (e: TauriLikeEvent<any>) => void;
const listeners = new Map<string, Set<Cb>>();
let nextId = 0;

export function addListener(event: string, cb: Cb): () => void {
  let set = listeners.get(event);
  if (!set) listeners.set(event, (set = new Set()));
  set.add(cb);
  return () => {
    listeners.get(event)?.delete(cb);
  };
}

export function dispatch(event: string, payload: unknown) {
  const set = listeners.get(event);
  if (!set) return;
  const ev = { event, id: ++nextId, payload };
  for (const cb of [...set]) {
    try {
      cb(ev);
    } catch (e) {
      console.error(`[cepheus web] listener for '${event}' failed`, e);
    }
  }
}
