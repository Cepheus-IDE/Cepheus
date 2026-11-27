/** Shim for `@tauri-apps/api/window`: window controls are no-ops or browser equivalents. */

type Unlisten = () => void;

class WebWindow {
  label = "main";
  async minimize() {}
  async maximize() {}
  async unmaximize() {}
  async toggleMaximize() {}
  async isMaximized() {
    return false;
  }
  async isMinimized() {
    return false;
  }
  async isFullscreen() {
    return !!document.fullscreenElement;
  }
  async setFullscreen(on: boolean) {
    if (on) await document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  }
  async close() {
    window.close(); // only works for windows opened by script; otherwise the tab stays open
  }
  async destroy() {}
  async show() {}
  async hide() {}
  async setFocus() {
    window.focus();
  }
  async isFocused() {
    return document.hasFocus();
  }
  async isVisible() {
    return document.visibilityState === "visible";
  }
  async setTitle(t: string) {
    document.title = t;
  }
  async title() {
    return document.title;
  }
  async startDragging() {}
  async setDecorations() {}
  async setAlwaysOnTop() {}
  async setSize() {}
  async setMinSize() {}
  async setZoom() {}
  async scaleFactor() {
    return window.devicePixelRatio || 1;
  }
  async theme() {
    return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  async onResized(cb: (e: unknown) => void): Promise<Unlisten> {
    const h = () => cb({ payload: { width: innerWidth, height: innerHeight } });
    addEventListener("resize", h);
    return () => removeEventListener("resize", h);
  }
  async onMoved(): Promise<Unlisten> {
    return () => {};
  }
  async onFocusChanged(cb: (e: { payload: boolean }) => void): Promise<Unlisten> {
    const f = () => cb({ payload: true });
    const b = () => cb({ payload: false });
    addEventListener("focus", f);
    addEventListener("blur", b);
    return () => {
      removeEventListener("focus", f);
      removeEventListener("blur", b);
    };
  }
  async onCloseRequested(): Promise<Unlisten> {
    return () => {};
  }
  async onThemeChanged(): Promise<Unlisten> {
    return () => {};
  }
  async onDragDropEvent(): Promise<Unlisten> {
    return () => {};
  }
  async listen(): Promise<Unlisten> {
    return () => {};
  }
  async once(): Promise<Unlisten> {
    return () => {};
  }
  async emit() {}
}

const main = new WebWindow();

export function getCurrentWindow() {
  return main;
}
export const getCurrent = getCurrentWindow;
export const appWindow = main;
export function getAllWindows() {
  return [main];
}
export { WebWindow as Window };
