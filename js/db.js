// Local storage layer (IndexedDB). Every pitch is written here *before* the UI
// moves on, and nothing is ever deleted after it syncs. This module is the only
// place that touches IndexedDB, so it can later be swapped for SQLite (Capacitor).

const DB_NAME = 'pitchtracker';
const DB_VERSION = 1;
const STRICT = { durability: 'strict' }; // flush to disk before reporting success

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('games', { keyPath: 'key' });
        const events = db.createObjectStore('events', { keyPath: 'id' });
        events.createIndex('gameKey', 'gameKey');
        events.createIndex('dirty', 'dirty');
        db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

// Runs `fn(store)` in a transaction and resolves with fn's return value (or the
// result of the request it returns) once the transaction has committed.
async function run(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = mode === 'readwrite'
      ? db.transaction(storeName, mode, STRICT)
      : db.transaction(storeName, mode);
    const out = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return 'unsupported';
    if (await navigator.storage.persisted()) return 'persisted';
    return (await navigator.storage.persist()) ? 'persisted' : 'not-persisted';
  } catch {
    return 'unsupported';
  }
}

// ---- games ----
export const putGame = (game) => run('games', 'readwrite', (s) => s.put(game));
export const getGame = (key) => run('games', 'readonly', (s) => s.get(key));
export async function listGames() {
  const games = await run('games', 'readonly', (s) => s.getAll());
  return games.sort((a, b) => b.createdAt - a.createdAt);
}

// ---- events ----
export const putEvent = (ev) => run('events', 'readwrite', (s) => s.put(ev));
export const deleteEvent = (id) => run('events', 'readwrite', (s) => s.delete(id));
export const getEvents = (gameKey) =>
  run('events', 'readonly', (s) => s.index('gameKey').getAll(gameKey));
export const countDirty = () => run('events', 'readonly', (s) => s.index('dirty').count(1));
export const getDirty = (limit) =>
  run('events', 'readonly', (s) => s.index('dirty').getAll(1, limit));

// Mark events as uploaded, but only if they haven't changed since we sent them.
export function markClean(sent) {
  return run('events', 'readwrite', (s) => {
    for (const e of sent) {
      const req = s.get(e.id);
      req.onsuccess = () => {
        const cur = req.result;
        if (cur && cur.dirty && cur.rev === e.rev) {
          cur.dirty = 0;
          cur.syncedAt = Date.now();
          s.put(cur);
        }
      };
    }
  });
}

// Add events that don't exist yet (used by backup import). Returns how many were added.
export function addMissingEvents(events) {
  let added = 0;
  return run('events', 'readwrite', (s) => {
    for (const e of events) {
      const req = s.get(e.id);
      req.onsuccess = () => {
        if (!req.result) {
          s.put({ ...e, dirty: e.type === 'pitch' ? 1 : 0 });
          added += 1;
        }
      };
    }
  }).then(() => added);
}

// ---- settings ----
export async function getSettings() {
  return (await run('kv', 'readonly', (s) => s.get('settings'))) || { url: '', token: '', recorder: '' };
}
export const saveSettings = (settings) => run('kv', 'readwrite', (s) => s.put(settings, 'settings'));
