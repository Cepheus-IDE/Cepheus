// Tiny WebAudio tones (no audio files) and best-effort system notifications.
import { get } from "../store";

let ctx: AudioContext | null = null;

const TONES: Record<"done" | "approval" | "bell", [number, number][]> = {
  done: [[660, 0], [880, 0.09]], // rising pair
  approval: [[880, 0], [880, 0.14]], // double tap
  bell: [[1200, 0]],
};

/** Plays a short tone if sound effects are on (or `force`, for the terminal bell / preview). */
export function playSound(kind: keyof typeof TONES, force = false) {
  const s = get().settings;
  if ((!s.soundEffects && !force) || s.doNotDisturb) return;
  try {
    ctx ??= new AudioContext();
    const vol = Math.max(0, Math.min(1, s.soundVolume ?? 0.5)) * 0.25;
    for (const [freq, at] of TONES[kind]) {
      const t = ctx.currentTime + at;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.14);
    }
  } catch { /* no audio device */ }
}

/** OS notification while the window is in the background (Web Notification API, if the webview has it). */
export async function systemNotify(title: string, body: string) {
  const s = get().settings;
  if (!s.agentNotifySystem || s.doNotDisturb || document.hasFocus() || typeof Notification === "undefined") return;
  try {
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission === "granted") new Notification(title, { body, silent: true });
  } catch { /* unsupported in this webview */ }
}
