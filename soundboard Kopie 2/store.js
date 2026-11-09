// IndexedDB: Audiodaten (Blobs) und Projektzustand. Kein Dateizugriff nötig.

const DB_NAME = 'soundboard-live-v1';
const DB_VER = 1;
let dbp = null;

function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbp = null; };
      db.onclose = () => { dbp = null; };
      resolve(db);
    };
    req.onerror = () => { dbp = null; reject(req.error); };
    req.onblocked = () => { dbp = null; reject(new Error('IndexedDB blockiert (andere Instanz offen?)')); };
  });
  return dbp;
}

async function run(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    let req;
    try { req = fn(t.objectStore(storeName)); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaktion abgebrochen'));
  });
}

export const putAudio = (rec) => run('audio', 'readwrite', (s) => s.put(rec)); // {id,name,type,data:Blob}
export const getAudio = (id) => run('audio', 'readonly', (s) => s.get(id));
export const deleteAudio = (id) => run('audio', 'readwrite', (s) => s.delete(id));
export const listAudioKeys = () => run('audio', 'readonly', (s) => s.getAllKeys());
export const clearAudio = () => run('audio', 'readwrite', (s) => s.clear());
export const saveProject = (obj) => run('meta', 'readwrite', (s) => s.put(obj, 'project'));
export const loadProject = () => run('meta', 'readonly', (s) => s.get('project'));

export async function requestPersist() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return null; }
}

export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}
