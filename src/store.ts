/**
 * Where the SDK keeps what must outlive the page: tokens, the device key, queued events, progress and
 * uploads. Values are structured-cloneable (plain objects, Uint8Array, CryptoKey): the device's private
 * key is a non-extractable CryptoKey and is only ever stored as one, never as bytes.
 */
export interface KrtuStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every key that starts with `prefix`. */
  keys(prefix: string): Promise<string[]>;
}

/** Kept in this process only (tests, servers, a page that must remember nothing). */
export function memoryStore(): KrtuStore {
  const data = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return data.has(key) ? (structuredClone(data.get(key)) as T) : undefined;
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
    },
    async delete(key) {
      data.delete(key);
    },
    async keys(prefix) {
      return [...data.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The browser's IndexedDB: one object store, survives reloads, shared by the origin's tabs. */
export function indexedDbStore(name = 'krtuworks-sdk'): KrtuStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return db;
  };
  const tx = async (mode: IDBTransactionMode) => (await open()).transaction('kv', mode).objectStore('kv');
  return {
    async get<T>(key: string) {
      return (await request((await tx('readonly')).get(key))) as T | undefined;
    },
    async set(key, value) {
      await request((await tx('readwrite')).put(value, key));
    },
    async delete(key) {
      await request((await tx('readwrite')).delete(key));
    },
    async keys(prefix) {
      const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
      return ((await request((await tx('readonly')).getAllKeys(range))) as IDBValidKey[]).map(String);
    },
  };
}

/** IndexedDB where there is one, otherwise this process's memory. */
export function defaultStore(): KrtuStore {
  return typeof indexedDB === 'undefined' ? memoryStore() : indexedDbStore();
}
