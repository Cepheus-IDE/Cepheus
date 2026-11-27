/** Tiny IndexedDB key/value store (folder handles, Time Machine snapshots, agent sessions). */

let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open("cepheus-web", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction("kv", mode).objectStore("kv"));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const idbGet = <T = any>(key: string) => tx<T>("readonly", (s) => s.get(key)).catch(() => undefined as T | undefined);
export const idbSet = (key: string, value: unknown) => tx("readwrite", (s) => s.put(value, key));
export const idbDel = (key: string) => tx("readwrite", (s) => s.delete(key));
export const idbKeys = (prefix: string) =>
  tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys(IDBKeyRange.bound(prefix, prefix + "￿"))).then((k) => k.map(String));
