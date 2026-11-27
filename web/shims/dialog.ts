/**
 * Shim for `@tauri-apps/plugin-dialog`. Server mode: an in-page picker over the served folder.
 * Browser mode: `open({ directory: true })` shows the File System Access directory picker and
 * returns a virtual `browser://<name>` path; other pickers are unavailable.
 */
import { getBackend } from "./bus";
import { pickOnServer } from "../ui/picker";

export interface DialogFilter {
  name: string;
  extensions: string[];
}
export interface OpenDialogOptions {
  title?: string;
  filters?: DialogFilter[];
  defaultPath?: string;
  multiple?: boolean;
  directory?: boolean;
  recursive?: boolean;
}
export interface SaveDialogOptions {
  title?: string;
  filters?: DialogFilter[];
  defaultPath?: string;
}

export async function open(options: OpenDialogOptions = {}): Promise<any> {
  const b = await getBackend();
  if (b.mode === "browser") {
    if (options.directory && b.pickDirectory) {
      const p = await b.pickDirectory();
      return p && options.multiple ? [p] : p;
    }
    alert("Picking files is not available in the browser — run `cepheus web` for the full experience.");
    return null;
  }
  const root = b.rootDir() ?? "";
  const start = options.defaultPath && options.defaultPath.toLowerCase().startsWith(root.toLowerCase()) ? options.defaultPath : root;
  const p = await pickOnServer(b, { directory: !!options.directory, title: options.title, start, root });
  return p && options.multiple ? [p] : p;
}

export async function save(options: SaveDialogOptions = {}): Promise<string | null> {
  const b = await getBackend();
  if (b.mode === "browser") {
    alert("Saving to a chosen location is not available in the browser — run `cepheus web` for the full experience.");
    return null;
  }
  const root = b.rootDir() ?? "";
  const name = (options.defaultPath ?? "").split(/[\\/]/).pop() ?? "";
  return pickOnServer(b, { directory: false, save: true, title: options.title, start: root, root, defaultName: name });
}

type MsgOpts = string | { title?: string; kind?: string; okLabel?: string; cancelLabel?: string };

export async function ask(message: string, _o?: MsgOpts): Promise<boolean> {
  return window.confirm(message);
}
export async function confirm(message: string, _o?: MsgOpts): Promise<boolean> {
  return window.confirm(message);
}
export async function message(msg: string, _o?: MsgOpts): Promise<void> {
  window.alert(msg);
}
