/** A web backend answers the app's `invoke(cmd, args)` calls and pushes events through `dispatch`. */
export interface Backend {
  mode: "server" | "browser";
  invoke(cmd: string, args: Record<string, any>): Promise<any>;
  /** Base folder for app data paths (`appDataDir()`), e.g. ~/.cepheus/web-data. */
  dataDir(): string;
  /** Home folder for `homeDir()`. */
  homeDir(): string;
  /** Folder the dialog shim's picker starts in (server mode). */
  rootDir(): string | null;
  /** Folder picker for `open({ directory: true })` in browser mode; null when cancelled. */
  pickDirectory?(): Promise<string | null>;
}

export const BROWSER_ONLY = "Not available in the browser — run `cepheus web` for the full experience";
