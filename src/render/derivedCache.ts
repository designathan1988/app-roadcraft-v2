/**
 * DERIVED DATA kept in the player's browser: what the game makes from its own
 * code the same way every time - the Builder's pictures, the surfaces'
 * texels, the countryside's trees - made once and read back afterwards, as an
 * engine keeps its Derived Data Cache (Unreal: derived data is generated once,
 * cached locally, and can always be generated again).
 *
 * Each entry is filed as `kind:fingerprint:id`, the fingerprint being that of
 * the code that makes it (`cook-plugin.ts`, the import closure of its maker):
 * a change to that code never serves an old one. IndexedDB, not localStorage,
 * because the values are blobs and buffers of megabytes and localStorage is
 * synchronous (MDN, "Web Storage API"). The store is best effort - the browser
 * may evict it under storage pressure (MDN, "Storage quotas and eviction
 * criteria") - so every reader makes the thing itself when it is missing, and
 * every failure here is silent.
 */
const DB = 'roadcraft-derived';
const STORE = 'entries';

let opening: Promise<IDBDatabase | null> | null = null;

function database(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab of a newer build asks to upgrade: let it.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return opening;
}

/** The keys from `prefix` up to every key that starts with it. */
const prefixRange = (prefix: string): IDBKeyRange => IDBKeyRange.bound(prefix, `${prefix}￿`);

/** One entry, or undefined when it is not kept. */
export async function readDerived<T>(key: string): Promise<T | undefined> {
  const db = await database();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** Every entry whose key starts with `prefix`, by the rest of its key. */
export async function readDerivedAll<T>(prefix: string): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const db = await database();
  if (!db) return out;
  return new Promise((resolve) => {
    try {
      const store = db.transaction(STORE, 'readonly').objectStore(STORE);
      const keys = store.getAllKeys(prefixRange(prefix));
      const values = store.getAll(prefixRange(prefix));
      values.onsuccess = () => {
        const list = keys.result ?? [];
        list.forEach((key, i) => out.set(String(key).slice(prefix.length), values.result[i] as T));
        resolve(out);
      };
      values.onerror = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
}

/** Keeps a value under `key`, without waiting: a write that fails is made again next time. */
export function writeDerived(key: string, value: unknown): void {
  void database().then((db) => {
    if (!db) return;
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const request = tx.objectStore(STORE).put(value, key);
      request.onerror = (event) => event.preventDefault();
    } catch {
      // Not kept (no space, private window): made again next time.
    }
  });
}

/** Forgets the entries of `kind` kept under any other fingerprint (an older build's). */
export function forgetOtherDerived(kind: string, fingerprint: string): void {
  void database().then((db) => {
    if (!db) return;
    try {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
      const keep = `${kind}:${fingerprint}:`;
      const request = store.getAllKeys(prefixRange(`${kind}:`));
      request.onsuccess = () => {
        for (const key of request.result) if (!String(key).startsWith(keep)) store.delete(key);
      };
    } catch {
      // Left for another time.
    }
  });
}
