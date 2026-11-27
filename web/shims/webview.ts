/** Shim for `@tauri-apps/api/webview`: zoom becomes CSS zoom on the page. */

class WebWebview {
  label = "main";
  async setZoom(scale: number) {
    (document.documentElement.style as any).zoom = String(scale || 1);
  }
  async setFocus() {
    window.focus();
  }
  async onDragDropEvent() {
    return () => {};
  }
  async listen() {
    return () => {};
  }
}

const main = new WebWebview();

export function getCurrentWebview() {
  return main;
}
export function getAllWebviews() {
  return [main];
}
export { WebWebview as Webview };
