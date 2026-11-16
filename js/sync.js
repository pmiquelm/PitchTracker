// Uploads pitches that aren't in the Google Sheet yet. Safe to call any time and
// as often as you like: rows carry a unique id and the sheet upserts by id, so
// retries never create duplicates.

import * as db from './db.js';

const BATCH_SIZE = 200;
const TIMEOUT_MS = 20000;

let status = { pending: 0, syncing: false, configured: false, error: null, lastSync: null };
const listeners = new Set();
let timer = null;

function emit(patch) {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn(status));
}

export function getSyncStatus() { return status; }

export function onSyncStatus(fn) {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

export async function refreshPending() {
  emit({ pending: await db.countDirty() });
}

export function syncSoon(delay = 300) {
  clearTimeout(timer);
  timer = setTimeout(syncNow, delay);
}

async function post(url, payload) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // No custom headers -> text/plain "simple" request, which Apps Script accepts
    // without a CORS preflight.
    const res = await fetch(url, { method: 'POST', body: JSON.stringify(payload), signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || 'Server error');
    return body;
  } finally {
    clearTimeout(t);
  }
}

export async function syncNow() {
  if (status.syncing) return;
  await refreshPending();
  const { url, token } = await db.getSettings();
  if (!url) { emit({ configured: false }); return; }
  emit({ configured: true });
  if (!status.pending) { emit({ error: null }); return; }

  emit({ syncing: true });
  try {
    for (let guard = 0; guard < 100; guard++) {
      const batch = await db.getDirty(BATCH_SIZE);
      if (!batch.length) break;
      await post(url, { token, rows: batch.map((e) => e.row) });
      await db.markClean(batch);
      await refreshPending();
    }
    emit({ syncing: false, error: null, lastSync: Date.now() });
  } catch (err) {
    const offline = !navigator.onLine || err.name === 'AbortError' || err instanceof TypeError;
    emit({ syncing: false, error: offline ? 'No connection' : err.message });
  }
}

export async function testConnection(url) {
  const res = await fetch(url, { method: 'GET' });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || 'Unexpected response');
  return body;
}

export function initSync() {
  window.addEventListener('online', () => syncSoon(0));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncSoon(0);
  });
  setInterval(() => { if (status.pending && !status.syncing) syncNow(); }, 30000);
  syncSoon(0);
}
