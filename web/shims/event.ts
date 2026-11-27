/** Shim for `@tauri-apps/api/event`: events pushed by the web backend (and local `emit`). */
import { addListener, dispatch, type TauriLikeEvent } from "./bus";

export type Event<T> = TauriLikeEvent<T>;
export type EventCallback<T> = (event: Event<T>) => void;
export type UnlistenFn = () => void;
export type EventName = string;

export async function listen<T>(event: EventName, handler: EventCallback<T>, _options?: unknown): Promise<UnlistenFn> {
  return addListener(event, handler as any);
}

export async function once<T>(event: EventName, handler: EventCallback<T>, _options?: unknown): Promise<UnlistenFn> {
  const un = addListener(event, (e) => {
    un();
    (handler as any)(e);
  });
  return un;
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  dispatch(event, payload);
}

export async function emitTo(_target: unknown, event: string, payload?: unknown): Promise<void> {
  dispatch(event, payload);
}

export enum TauriEvent {
  WINDOW_RESIZED = "tauri://resize",
  WINDOW_MOVED = "tauri://move",
  WINDOW_CLOSE_REQUESTED = "tauri://close-requested",
  WINDOW_DESTROYED = "tauri://destroyed",
  WINDOW_FOCUS = "tauri://focus",
  WINDOW_BLUR = "tauri://blur",
  WINDOW_SCALE_FACTOR_CHANGED = "tauri://scale-change",
  WINDOW_THEME_CHANGED = "tauri://theme-changed",
  DRAG_ENTER = "tauri://drag-enter",
  DRAG_OVER = "tauri://drag-over",
  DRAG_DROP = "tauri://drag-drop",
  DRAG_LEAVE = "tauri://drag-leave",
}
