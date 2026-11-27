/** Shim for `@tauri-apps/api/core`: `invoke` goes to the active web backend. */
import { getBackend } from "./bus";

export type InvokeArgs = Record<string, unknown>;

export async function invoke<T = unknown>(cmd: string, args: InvokeArgs = {}): Promise<T> {
  const b = await getBackend();
  try {
    return (await b.invoke(cmd, (args ?? {}) as Record<string, any>)) as T;
  } catch (e) {
    // Tauri rejects with the error string; the app's errMsg() expects that.
    throw typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  }
}

export function isTauri(): boolean {
  return false;
}

export function convertFileSrc(filePath: string, _protocol = "asset"): string {
  return filePath;
}

let cbId = 0;
export function transformCallback(cb?: (r: any) => void, once = false): number {
  const id = ++cbId;
  (window as any)[`_${id}`] = (r: any) => {
    if (once) delete (window as any)[`_${id}`];
    cb?.(r);
  };
  return id;
}

export class Channel<T = unknown> {
  id = transformCallback();
  onmessage: (response: T) => void = () => {};
}

export class Resource {
  constructor(readonly rid: number) {}
  async close() {}
}

export class PluginListener {
  async unregister() {}
}

export async function addPluginListener(): Promise<PluginListener> {
  return new PluginListener();
}
