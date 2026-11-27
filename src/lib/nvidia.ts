import { useEffect, useState } from "react";
import { api } from "./api";
import { get } from "../store";

/** NVIDIA's chat model list, fetched live from the API and cached for the session. */
let cache: string[] | null = null;
let inflight: Promise<string[]> | null = null;
const subs = new Set<(m: string[]) => void>();

export function fetchNvidiaModels(force = false): Promise<string[]> {
  if (cache && !force) return Promise.resolve(cache);
  if (inflight && !force) return inflight;
  inflight = api
    .nvidiaModels(get().settings.keys.nvidia)
    .then((m) => {
      cache = m;
      subs.forEach((f) => f(m));
      return m;
    })
    .finally(() => (inflight = null));
  return inflight;
}

/** Live model list; `null` while loading, `error` set when the API can't be reached. */
export function useNvidiaModels(enabled = true) {
  const [models, setModels] = useState<string[] | null>(cache);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    subs.add(setModels);
    fetchNvidiaModels().then(setModels, (e) => setError(String(e)));
    return () => { subs.delete(setModels); };
  }, [enabled]);
  const refresh = () => {
    setError(null);
    fetchNvidiaModels(true).then(setModels, (e) => setError(String(e)));
  };
  return { models, error, refresh };
}

/** "nvidia/nemotron-3-ultra-550b-a55b" → "nemotron-3-ultra-550b-a55b" */
export const shortModel = (id: string) => id.split("/").pop() ?? id;
