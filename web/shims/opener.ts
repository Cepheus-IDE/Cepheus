/** Shim for `@tauri-apps/plugin-opener`: URLs open in a new tab; local paths cannot be revealed. */

export async function openUrl(url: string | URL, _openWith?: string): Promise<void> {
  const u = String(url);
  if (!/^(https?|mailto):/i.test(u)) throw "Only web links can be opened from Cepheus Web";
  window.open(u, "_blank", "noopener,noreferrer");
}

export async function openPath(_path: string, _openWith?: string): Promise<void> {
  throw "Opening files with other programs is not available in Cepheus Web";
}

export async function revealItemInDir(_path: string | string[]): Promise<void> {
  console.info("[cepheus web] Reveal in file manager is not available in the browser");
}
