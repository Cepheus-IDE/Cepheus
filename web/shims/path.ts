/** Shim for `@tauri-apps/api/path`: app folders live under the backend's data folder. */
import { getBackend } from "./bus";

const sepOf = (p: string) => (/^[A-Za-z]:\\/.test(p) || (p.includes("\\") && !p.includes("/")) ? "\\" : "/");
const joinTo = (base: string, name: string) => {
  const s = sepOf(base);
  return base.replace(/[\\/]+$/, "") + s + name;
};

export async function appDataDir() {
  return (await getBackend()).dataDir();
}
export async function appConfigDir() {
  return joinTo(await appDataDir(), "config");
}
export async function appLocalDataDir() {
  return appDataDir();
}
export async function appCacheDir() {
  return joinTo(await appDataDir(), "cache");
}
export async function appLogDir() {
  return joinTo(await appDataDir(), "logs");
}
export async function homeDir() {
  return (await getBackend()).homeDir();
}
export async function tempDir() {
  return joinTo(await appDataDir(), "tmp");
}
export async function resourceDir() {
  return appDataDir();
}
export async function documentDir() {
  return homeDir();
}
export async function downloadDir() {
  return homeDir();
}
export async function desktopDir() {
  return homeDir();
}

export function sep() {
  return "/";
}
export function delimiter() {
  return navigator.platform.startsWith("Win") ? ";" : ":";
}
export async function join(...parts: string[]) {
  return parts.filter(Boolean).reduce((a, b) => (a ? joinTo(a, b.replace(/^[\\/]+/, "")) : b), "");
}
export async function normalize(p: string) {
  return p;
}
export async function resolve(...parts: string[]) {
  return join(...parts);
}
export async function dirname(p: string) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i <= 0 ? p : p.slice(0, i);
}
export async function basename(p: string, ext?: string) {
  const b = p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
}
export async function extname(p: string) {
  const b = await basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1) : "";
}
export async function isAbsolute(p: string) {
  return /^([A-Za-z]:[\\/]|\/|[a-z]+:\/\/)/.test(p);
}

export enum BaseDirectory {
  AppData = 14,
  AppConfig = 13,
  Home = 21,
}
