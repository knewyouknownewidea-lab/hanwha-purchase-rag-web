// 업로드 데이터 저장 (IndexedDB) — localStorage보다 용량이 커서 업로드 데이터에 쓴다.
// 저장소를 쓸 수 없는 환경(사생활 보호 모드, 차단)에서는 null/false를 돌려주고 화면은 계속 동작한다.
const DB_NAME = "procure-ai";
const STORE = "uploads";
const OPEN_TIMEOUT = 2000;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let done = false;
    const finish = (v: IDBDatabase | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      if (typeof indexedDB === "undefined") return finish(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => finish(req.result);
      req.onerror = () => finish(null);
      req.onblocked = () => finish(null);
      setTimeout(() => finish(null), OPEN_TIMEOUT);
    } catch {
      finish(null);
    }
  });
  dbPromise.then((db) => {
    if (!db) dbPromise = null; // 다음에 다시 시도
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          req.onsuccess = () => resolve((req.result as T) ?? null);
          req.onerror = () => resolve(null);
          tx.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export const idbGet = <T,>(key: string) => run<T>("readonly", (s) => s.get(key));
export const idbSet = (key: string, value: unknown) => run<IDBValidKey>("readwrite", (s) => s.put(value, key)).then((r) => r !== null);
export const idbDel = (key: string) => run<undefined>("readwrite", (s) => s.delete(key)).then(() => true);
