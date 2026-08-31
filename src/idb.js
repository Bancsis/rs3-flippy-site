const DB_NAME = 'rs3-flippy';
const DB_VERSION = 1;
const STORES = ['cache', 'history1h', 'history5m'];
let dbPromise;

function openDb() {
  if (!('indexedDB' in globalThis)) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

async function request(storeName, mode, operation) {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let req;
    try { req = operation(store); } catch (e) { reject(e); return; }
    if (req) {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
    } else {
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    }
  }).catch(() => undefined);
}

export async function cacheGet(key) {
  return request('cache', 'readonly', (s) => s.get(key));
}

export async function cachePut(key, value) {
  return request('cache', 'readwrite', (s) => s.put(value, key));
}

export async function bucketKeys(storeName) {
  const result = await request(storeName, 'readonly', (s) => s.getAllKeys());
  return Array.isArray(result) ? result.map(Number).filter(Number.isFinite).sort((a,b) => a-b) : [];
}

export async function bucketGet(storeName, stamp) {
  return request(storeName, 'readonly', (s) => s.get(stamp));
}

export async function bucketPut(storeName, stamp, value) {
  return request(storeName, 'readwrite', (s) => s.put(value, stamp));
}

export async function bucketDelete(storeName, stamp) {
  return request(storeName, 'readwrite', (s) => s.delete(stamp));
}

export async function requestPersistentStorage() {
  try { await navigator.storage?.persist?.(); } catch {}
}
