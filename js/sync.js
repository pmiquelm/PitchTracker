// Uploads pitches that aren't in the Google Sheet yet. Safe to call any time and
// as often as you like: rows carry a unique id and the sheet upserts by id, so
// retries never create duplicates.

import * as db from './db.js';
import { normalizeRosters } from './roster.js';

const BATCH_SIZE = 200;
// Longer than the server's lock wait (Code.gs), so a busy sheet answers with a
// clear error instead of the request being cut off.
const TIMEOUT_MS = 30000;
// The sheet script must be at least this version (it reports it in every reply).
// Older scripts lack the session_type column, so live BP rows would be counted as games.
export const SCRIPT_VERSION = 6;
// Rosters need a newer script than uploads do. Uploads keep working with an older one.
export const ROSTER_SCRIPT_VERSION = 4;
// So do dashboard links (the viewer key and the read-only dashboard action).
export const DASHBOARD_SCRIPT_VERSION = 8;
const OUTDATED = 'The sheet script is out of date: deploy the new Code.gs (merge to main, or paste it and Deploy → Manage deployments → Edit → New version)';

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

// Turns a failed request into a message a recorder can act on. Only a device
// that reports itself offline is "No connection": fetch also throws TypeError
// when Google answers with a sign-in or error page that lacks CORS headers.
export function describeError(err, online = globalThis.navigator?.onLine !== false) {
  if (!online) return 'No connection';
  if (err?.name === 'AbortError') return 'The sheet took too long to answer. Try again';
  if (err instanceof TypeError) {
    return "Couldn't reach the sheet script. Check the web app is deployed with access \"Anyone\" and the address is current";
  }
  if (err instanceof SyntaxError) return 'The sheet script sent back a page instead of data. Check the deployment address';
  return err?.message || String(err);
}

async function post(url, payload, minVersion = SCRIPT_VERSION) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // No custom headers -> text/plain "simple" request, which Apps Script accepts
    // without a CORS preflight.
    const res = await fetch(url, { method: 'POST', body: JSON.stringify(payload), signal: ctrl.signal });
    if (!res.ok) throw new Error(`The sheet script answered HTTP ${res.status}`);
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || 'Server error');
    if (!(body.version >= minVersion)) throw new Error(OUTDATED);
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
      // Pitches go to the Pitches sheet, finished plate appearances to PlateAppearances.
      await post(url, {
        token,
        rows: batch.filter((e) => e.row).map((e) => e.row),
        pas: batch.filter((e) => e.paRow).map((e) => e.paRow),
      });
      await db.markClean(batch);
      await refreshPending();
    }
    emit({ syncing: false, error: null, lastSync: Date.now() });
  } catch (err) {
    emit({ syncing: false, error: describeError(err) });
  }
}

// Checks the whole upload path (address, deployment access and token) with an
// empty upload, which the script accepts without touching the sheet's rows.
export async function testConnection(url, token) {
  try {
    return await post(url, { token, rows: [] });
  } catch (err) {
    throw new Error(describeError(err));
  }
}

// Downloads the sheet's Rosters tab and keeps a copy on this phone, so lineups can
// be picked from it with no signal. Resolves with the rosters; throws a readable error.
export async function fetchRosters() {
  const { url, token } = await db.getSettings();
  if (!url) throw new Error('Connect a sheet first');
  let body;
  try {
    body = await post(url, { token, action: 'rosters' }, ROSTER_SCRIPT_VERSION);
  } catch (err) {
    // A script from before rosters reads this as an empty upload.
    throw new Error(err?.message === 'No rows' ? OUTDATED : describeError(err));
  }
  const data = { rosters: normalizeRosters(body.rosters), fetchedAt: Date.now() };
  await db.saveRosters(data);
  return data;
}

export function initSync() {
  window.addEventListener('online', () => syncSoon(0));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncSoon(0);
  });
  setInterval(() => { if (status.pending && !status.syncing) syncNow(); }, 30000);
  syncSoon(0);
}

// The sheet's read-only viewer key, for team dashboard links. The script makes it the first
// time; `renew` replaces it, so every dashboard link shared before stops working.
export async function fetchViewerKey({ renew = false } = {}) {
  const { url, token } = await db.getSettings();
  if (!url) throw new Error('Connect a sheet first');
  try {
    const body = await post(url, { token, action: 'viewerKey', renew }, DASHBOARD_SCRIPT_VERSION);
    return { url, key: body.key };
  } catch (err) {
    // A script from before dashboards reads this as an empty upload.
    throw new Error(err?.message === 'No rows' ? OUTDATED : describeError(err));
  }
}
