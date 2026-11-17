import * as db from './db.js';
import {
  PITCH_TYPES, ZONES, ACTIONS, RESULT_LABELS, PA_END_LABELS,
  replay, buildPitchRow, activeEvents,
} from './game.js';
import { initSync, syncNow, syncSoon, refreshPending, onSyncStatus, getSyncStatus, testConnection } from './sync.js';
import { backupJSON, exportCSV, importBackup } from './backup.js';
import { buildSetupLink, decodeConnect } from './connect.js';

const app = document.getElementById('app');
const LINEUP_SIZE = 9;

let current = null; // { game, events, state }
let sel = { pitchType: null, zone: null, action: null };
let persistence = 'unknown';
let settingsCache = {}; // { url, token, recorder, deviceId, appliedLink }
let updateReady = false;  // a new version has taken over; reload at the next safe moment
// How this launch was opened, with any token hidden. Shown in Settings to diagnose installs.
const launchAddress = location.origin + location.pathname
  + (location.search ? '?…' : '') + (location.hash.includes('connect=') ? '#connect=…' : location.hash);

// ---------- helpers ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }));
const playerLabel = (p) => (p ? `${p.number ? `#${esc(p.number)} ` : ''}${esc(p.name)}` : '');
// iPhone/iPad (iPadOS reports itself as a Mac, so also check for a touch screen).
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installPrompt = null; // Android/Chrome: the browser's own "Install app" prompt, saved for our button
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

let toastTimer = null;
function toast(html, kind = '') {
  const el = document.getElementById('toast');
  el.className = `show ${kind}`;
  el.innerHTML = html;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2600);
}

// One-line summary of the sync state, used by the badge and the status dialog.
function syncSummary(s = getSyncStatus()) {
  if (!s.configured) {
    return s.pending
      ? { cls: 'warn', short: `⚠ ${s.pending}`, text: `${s.pending} not uploaded: no sheet connected` }
      : { cls: 'muted', short: 'No sheet', text: 'No sheet connected' };
  }
  if (s.syncing) return { cls: 'busy', short: `↻ ${s.pending}`, text: `Uploading ${s.pending}…` };
  if (s.pending) {
    return { cls: 'warn', short: `⚠ ${s.pending}`, text: `${s.pending} not uploaded${s.error ? `: ${esc(s.error)}` : ''}` };
  }
  return { cls: 'ok', short: '✓ Synced', text: 'All synced' };
}

// The tracker uses the compact form so it never gets cut off; tap it for details.
function badgeHTML(s = getSyncStatus(), compact = false) {
  const m = syncSummary(s);
  return `<button class="sync-badge ${m.cls}${compact ? ' compact' : ''}" data-act="sync" data-compact="${compact ? 1 : ''}"
    aria-label="Sync status: ${m.text}">${compact ? m.short : m.text}</button>`;
}

onSyncStatus((s) => {
  document.querySelectorAll('.sync-badge').forEach((el) => { el.outerHTML = badgeHTML(s, !!el.dataset.compact); });
  const live = document.getElementById('sync-status-text');
  if (live) live.innerHTML = syncSummary(s).text;
});

function showSyncDialog() {
  const s = getSyncStatus();
  openDialog(`
    <h2>Upload status</h2>
    <p class="sync-line"><strong id="sync-status-text">${syncSummary(s).text}</strong></p>
    <p class="muted small">Last upload: ${s.lastSync ? new Date(s.lastSync).toLocaleTimeString() : 'none this session'}.
      Pitches are saved on this phone first and upload automatically when there's signal.</p>
    <div class="menu">
      ${s.configured ? '<button data-act="sync-now" class="primary">Upload now</button>' : '<button data-act="settings">Connect a sheet</button>'}
      ${current ? '<button data-act="backup">Back up game (file)</button>' : ''}
      <button data-act="close">Close</button>
    </div>`, async (act, btn, dlg) => {
    if (act === 'sync-now') {
      await syncNow();
      if (!getSyncStatus().pending) dlg.close();
    } else if (act === 'backup') {
      const r = await backupJSON(current.game, current.events);
      if (r !== 'cancelled') toast('Backup created');
    } else if (act === 'settings') {
      dlg.close();
      showSettings();
    }
  });
}

function openDialog(html, onClick) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = html;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) { dlg.close(); return; } // tap on backdrop
    const btn = e.target.closest('[data-act]');
    if (btn?.dataset.act === 'close') { dlg.close(); return; }
    if (btn) onClick?.(btn.dataset.act, btn, dlg, e);
  });
  dlg.showModal();
  return dlg;
}

// ---------- home ----------
async function showHome() {
  app.classList.remove('tracker-mode');
  current = null;
  if (updateReady) { location.reload(); return; }
  const games = await db.listGames();
  app.innerHTML = `
    <header class="bar">
      <h1>PitchTracker</h1>
      ${badgeHTML()}
    </header>
    <main class="page">
      ${isStandalone() ? '' : installNoticeHTML()}
      ${persistence === 'not-persisted' && isStandalone() ? '<div class="notice">Storage is not marked persistent yet. Close the app fully and reopen it; iOS usually grants it after that.</div>' : ''}
      ${settingsCache.url ? '' : `<div class="connect-box">
        <strong>Connect to the team sheet</strong>
        <p class="muted small">Copy the setup link first: from the message you were sent, or in Safari with
          <em>Copy setup link</em> on the app's home screen.</p>
        <button class="big primary" data-act="paste-connect">Paste &amp; connect</button>
        <p class="muted small">Or paste it here yourself:</p>
        <input id="connect-input" placeholder="https://…#connect=…" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="row-buttons"><button data-act="connect">Connect</button></div>
      </div>`}
      <button class="big primary" data-act="new">＋ New game</button>
      <h2>Games</h2>
      <ul class="list">
        ${games.map((g) => `<li><button class="row" data-act="open" data-key="${esc(g.key)}">
            <strong>${esc(g.gameId)}</strong>
            <span>${new Date(g.createdAt).toLocaleString()}</span></button></li>`).join('')
          || '<li class="muted">No games yet.</li>'}
      </ul>
      <div class="row-buttons">
        <button data-act="settings">Settings</button>
        <label class="button">Import backup<input type="file" accept=".json,application/json" hidden id="import-file"></label>
      </div>
    </main>`;

  app.onclick = (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'new') showSetup();
    else if (act === 'open') showTracker(btn.dataset.key);
    else if (act === 'settings') showSettings();
    else if (act === 'sync') showSyncDialog();
    else if (act === 'paste-link') pasteInto(document.getElementById('connect-input'));
    else if (act === 'paste-connect') pasteAndConnect();
    else if (act === 'copy-link') copySetupLink();
    else if (act === 'install') installApp();
    else if (act === 'connect') {
      connectFromLink(document.getElementById('connect-input').value).then(async (ok) => {
        if (!ok) return;
        if (await keepLinkInAddress()) location.reload(); else showHome();
      });
    }
  };
  document.getElementById('import-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const r = await importBackup(file);
      toast(`Imported ${esc(r.game.gameId)}: ${r.added} new events`);
      await refreshPending();
      syncSoon(0);
      showHome();
    } catch (err) {
      toast(`Import failed: ${esc(err.message)}`, 'error');
    }
  };
}

// The "install the app" box on the home screen, different per platform.
function installNoticeHTML() {
  if (!settingsCache.url) {
    return `<div class="notice"><strong>Install the app:</strong> connect the sheet first (below, or in <em>Settings</em>),
      then install it from this screen.</div>`;
  }
  if (isIOS()) {
    // iOS: the Home Screen app gets its own empty storage, so carry the link over by clipboard.
    return `<div class="notice">
      <strong>Install on this phone</strong>
      <ol class="steps">
        <li><button class="primary" data-act="copy-link">Copy setup link</button></li>
        <li>Tap <em>Share</em> → <em>Add to Home Screen</em>.</li>
        <li>Open the new icon. If it isn't connected, tap <em>Paste &amp; connect</em>.</li>
      </ol>
      Data is only kept safely in the installed app.</div>`;
  }
  // Android and desktop Chrome/Edge: the installed app shares the browser's storage, so it
  // is connected already. Use the browser's own install prompt when it offers one.
  return `<div class="notice">
    <strong>Install on this phone</strong>
    ${installPrompt
      ? '<p><button class="primary" data-act="install">Install app</button></p>'
      : '<p>Open the browser menu (<b>⋮</b>) → <em>Install app</em> or <em>Add to Home screen</em>.</p>'}
    The installed app is already connected to the sheet. Open it from its icon from now on.</div>`;
}

async function installApp() {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  if (outcome === 'accepted') toast('Installing… open PitchTracker from its icon');
  if (!current) showHome();
}

// ---------- setup ----------
function showSetup() {
  app.classList.remove('tracker-mode');
  const today = new Date().toISOString().slice(0, 10);
  const rows = Array.from({ length: LINEUP_SIZE }, (_, i) => `
    <div class="lineup-row">
      <span class="slot">${i + 1}</span>
      <input name="num${i}" inputmode="numeric" placeholder="#" class="num" autocomplete="off">
      <input name="name${i}" placeholder="Batter ${i + 1}" autocomplete="off" autocapitalize="words">
    </div>`).join('');

  app.innerHTML = `
    <header class="bar">
      <button class="icon" data-act="back" aria-label="Back">‹</button>
      <h1>New game</h1>
      <span></span>
    </header>
    <main class="page">
      <form id="setup" autocomplete="off">
        <label>Game ID<input name="gameId" required value="${today}-" autocapitalize="characters"></label>
        <label>Starting pitcher <span class="muted">(optional)</span><input name="pitcher" autocapitalize="words"></label>
        <h2>Batting order</h2>
        ${rows}
        <button class="big primary" type="submit">Start game</button>
      </form>
    </main>`;

  app.onclick = (e) => {
    if (e.target.closest('[data-act="back"]')) showHome();
  };
  document.getElementById('setup').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const gameId = String(f.get('gameId')).trim();
    const lineup = [];
    for (let i = 0; i < LINEUP_SIZE; i++) {
      const name = String(f.get(`name${i}`)).trim();
      const number = String(f.get(`num${i}`)).trim();
      if (name || number) lineup.push({ name: name || `Batter ${i + 1}`, number });
    }
    if (!gameId) { toast('Enter a game ID', 'error'); return; }
    if (!lineup.length) { toast('Enter at least one batter', 'error'); return; }
    const game = { key: uuid(), gameId, pitcher: String(f.get('pitcher')).trim(), lineup, createdAt: Date.now() };
    await db.putGame(game);
    showTracker(game.key);
  };
}

// ---------- tracker ----------
async function showTracker(key) {
  const game = await db.getGame(key);
  if (!game) { showHome(); return; }
  const events = await db.getEvents(key);
  current = { game, events, state: replay(game, events) };
  // Leave a history entry so Android's Back button comes back here (see popstate in boot).
  if (!history.state?.tracker) history.pushState({ tracker: true }, '', location.href);
  sel = { pitchType: null, zone: null, action: null };
  renderTracker();
}

function nextSeq() {
  return current.events.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
}

async function addEvent(type, data, extra = {}) {
  const ev = {
    id: uuid(), gameKey: current.game.key, seq: nextSeq(), type, data,
    createdAt: Date.now(), deleted: 0, dirty: 0, rev: 1, ...extra,
  };
  if (type === 'pitch') {
    ev.row = buildPitchRow(current.game, current.state, data, ev);
    ev.row.recorded_by = recorderLabel();
    ev.dirty = 1;
  }
  await db.putEvent(ev); // committed to disk before we move on
  current.events.push(ev);
  current.state = replay(current.game, current.events);
  return ev;
}

function dots(n, max, cls) {
  return Array.from({ length: max }, (_, i) => `<i class="dot ${i < n ? cls : ''}"></i>`).join('');
}

function padGroup(title, group, options, cols) {
  return `<section class="group group-${group}">
    <h3>${title}</h3>
    <div class="pads cols-${cols}">
      ${Object.entries(options).map(([value, label]) => `
        <button class="pad ${sel[group] === value ? 'selected' : ''}" data-act="pad" data-group="${group}" data-value="${value}">${label}</button>`).join('')}
    </div></section>`;
}

function renderTracker() {
  const { game, state } = current;
  const batter = state.lineup[state.slot];
  const onDeck = state.lineup[(state.slot + 1) % state.lineup.length];
  app.classList.add('tracker-mode');
  app.innerHTML = `
    <header class="scorebar">
      <button class="icon" data-act="menu" aria-label="Menu">☰</button>
      <div class="count" aria-label="Count ${state.balls} balls ${state.strikes} strikes">
        <div class="count-num">${state.balls}<span>-</span>${state.strikes}</div>
        <div class="count-dots"><span>B ${dots(state.balls, 3, 'ball')}</span><span>S ${dots(state.strikes, 2, 'strike')}</span></div>
      </div>
      ${badgeHTML(getSyncStatus(), true)}
    </header>
    <div class="batter-bar">
      <div class="batter-row">
        <div class="batter-name"><span class="label">Batting ${state.slot + 1}</span> <strong>${playerLabel(batter)}</strong>
          <span class="muted"> · PA ${state.paNumber}</span></div>
        <div class="inning" aria-label="Inning ${state.inning}">
          <button data-act="inning" data-delta="-1" aria-label="Previous inning">−</button>
          <span><small>INN</small>${state.inning}</span>
          <button data-act="inning" data-delta="1" aria-label="Next inning">+</button>
        </div>
      </div>
      <div class="last ${current.last?.paEnd ? 'pa-end' : ''}">${current.last?.html || '&nbsp;'}</div>
      <div class="muted small">On deck: ${playerLabel(onDeck)}${state.pitcher ? ` · P: ${esc(state.pitcher)} (${state.pitcherPitches})` : ` · ${state.pitchNumber} pitches`}</div>
    </div>
    <main class="tracker">
      ${padGroup('Pitch', 'pitchType', { FB: 'Fastball', CB: 'Curveball' }, 2)}
      ${padGroup('Zone', 'zone', { IN: 'In', OUT: 'Out' }, 2)}
      ${padGroup('Batter', 'action', { TAKE: 'Take', SWING: 'Swing', FOUL: 'Foul', IN_PLAY: 'In play' }, 4)}
    </main>
    <footer class="actions">
      <button data-act="undo" ${activeEvents(current.events).length ? '' : 'disabled'}>↶ Undo</button>
      <button data-act="next">Next batter ›</button>
      <button data-act="lineup">Lineup / Subs</button>
      <button data-act="log">Log</button>
    </footer>`;

  app.onclick = (e) => { queue = queue.then(() => handleTrackerClick(e)).catch((err) => toast(`Error: ${esc(err.message)}`, 'error')); };
}

// Taps are handled strictly one after another so fast double-taps can't race.
let queue = Promise.resolve();

async function handleTrackerClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.disabled) return;
  const act = btn.dataset.act;
  if (act === 'pad') {
    const { group, value } = btn.dataset;
    sel[group] = sel[group] === value ? null : value;
    if (sel.pitchType && sel.zone && sel.action) {
      const input = { ...sel };
      sel = { pitchType: null, zone: null, action: null };
      await recordPitch(input);
    }
    renderTracker();
  } else if (act === 'undo') {
    await undo();
  } else if (act === 'next') {
    await addEvent('nextBatter', {});
    current.last = { html: 'Moved to next batter', paEnd: false };
    renderTracker();
  } else if (act === 'inning') {
    await addEvent('inning', { delta: Number(btn.dataset.delta) });
    renderTracker();
  } else if (act === 'lineup') {
    showLineupDialog();
  } else if (act === 'log') {
    showLogDialog();
  } else if (act === 'menu') {
    showMenu();
  } else if (act === 'sync') {
    showSyncDialog();
  }
}

async function recordPitch(input) {
  const ev = await addEvent('pitch', input);
  const r = ev.row;
  let msg = `Last: ${PITCH_TYPES[input.pitchType]} · ${input.zone === 'IN' ? 'In' : 'Out'} · ${ACTIONS[input.action]} → <b>${RESULT_LABELS[r.result]}</b>`;
  if (r.pa_end) {
    msg += ` · <b>${PA_END_LABELS[r.pa_end]}</b>`;
  }
  current.last = { html: msg, paEnd: !!r.pa_end };
  await refreshPending();
  syncSoon();
}

function describeEvent(ev) {
  switch (ev.type) {
    case 'pitch': return `pitch (${PITCH_TYPES[ev.data.pitchType]}, ${ACTIONS[ev.data.action]})`;
    case 'nextBatter': return 'next batter';
    case 'setBatter': return 'batter change';
    case 'sub': return `substitution (${esc(ev.data.name)})`;
    case 'pitcher': return `pitcher change (${esc(ev.data.name)})`;
    case 'inning': return 'inning change';
    default: return ev.type;
  }
}

async function undo() {
  const last = activeEvents(current.events).at(-1);
  if (!last) return;
  if (last.type === 'pitch') {
    // Keep a tombstone so the row is marked deleted in the sheet too.
    last.deleted = 1;
    last.dirty = 1;
    last.rev += 1;
    last.row = { ...last.row, deleted: true };
    await db.putEvent(last);
  } else {
    await db.deleteEvent(last.id);
    current.events = current.events.filter((e) => e !== last);
  }
  current.state = replay(current.game, current.events);
  sel = { pitchType: null, zone: null, action: null };
  current.last = { html: `Undid ${describeEvent(last)}`, paEnd: false };
  renderTracker();
  await refreshPending();
  syncSoon();
}

function showLineupDialog() {
  const { state } = current;
  const rows = state.lineup.map((p, i) => `
    <div class="lineup-row">
      <label class="slot-radio"><input type="radio" name="current" value="${i}" ${i === state.slot ? 'checked' : ''}><span>${i + 1}</span></label>
      <input name="num${i}" class="num" inputmode="numeric" value="${esc(p.number)}" placeholder="#">
      <input name="name${i}" value="${esc(p.name)}" autocapitalize="words">
    </div>`).join('');
  const dlg = openDialog(`
    <form method="dialog" id="lineup-form">
      <h2>Lineup &amp; substitutions</h2>
      <p class="muted small">Edit a name to substitute that spot. The selected circle is the current batter.</p>
      ${rows}
      <label>Pitcher<input name="pitcher" value="${esc(state.pitcher)}" autocapitalize="words"></label>
      <div class="row-buttons">
        <button type="button" data-act="close">Cancel</button>
        <button type="button" class="primary" data-act="save">Save</button>
      </div>
    </form>`, async (act, btn, d) => {
    if (act !== 'save') return;
    const f = new FormData(d.querySelector('form'));
    let changes = 0;
    for (let i = 0; i < state.lineup.length; i++) {
      const name = String(f.get(`name${i}`)).trim();
      const number = String(f.get(`num${i}`)).trim();
      const p = current.state.lineup[i];
      if (name && (name !== p.name || number !== p.number)) {
        await addEvent('sub', { slot: i, name, number, replaced: p.name });
        changes++;
      }
    }
    const pitcher = String(f.get('pitcher')).trim();
    if (pitcher !== current.state.pitcher) { await addEvent('pitcher', { name: pitcher }); changes++; }
    const slot = Number(f.get('current'));
    if (slot !== current.state.slot) { await addEvent('setBatter', { slot }); changes++; }
    d.close();
    if (changes) toast(`Saved ${changes} change${changes > 1 ? 's' : ''}`);
    renderTracker();
  });
  dlg.querySelector('form').onsubmit = (e) => e.preventDefault();
}

function showLogDialog() {
  const pitches = activeEvents(current.events).filter((e) => e.type === 'pitch').map((e) => e.row);
  const byPa = new Map();
  for (const r of pitches) {
    if (!byPa.has(r.pa_number)) byPa.set(r.pa_number, []);
    byPa.get(r.pa_number).push(r);
  }
  const items = [...byPa.entries()].reverse().map(([pa, rows]) => {
    const first = rows[0];
    const end = rows.at(-1).pa_end;
    return `<li><div class="log-head"><strong>PA ${pa}</strong> · Inn ${first.inning} · ${first.batter_number ? `#${esc(first.batter_number)} ` : ''}${esc(first.batter)}
        ${end ? `<span class="tag">${PA_END_LABELS[end]}</span>` : ''}</div>
      <ol>${rows.map((r) => `<li>${r.balls_before}-${r.strikes_before} · ${r.pitch_type} · ${r.zone === 'IN' ? 'In' : 'Out'} · ${ACTIONS[r.action]} → ${RESULT_LABELS[r.result]}</li>`).join('')}</ol></li>`;
  }).join('');
  openDialog(`
    <h2>Pitch log · ${pitches.length} pitches</h2>
    <ul class="log">${items || '<li class="muted">No pitches yet.</li>'}</ul>
    <div class="row-buttons"><button data-act="close" class="primary">Close</button></div>`);
}

function showMenu() {
  const s = getSyncStatus();
  openDialog(`
    <h2>${esc(current.game.gameId)}</h2>
    <p>${s.pending ? `<strong>${s.pending} pitch${s.pending > 1 ? 'es' : ''} not uploaded yet.</strong> Back up if you have no signal.` : 'All pitches are uploaded.'}</p>
    <div class="menu">
      <button data-act="backup" class="primary">Back up game (file)</button>
      <button data-act="csv">Export CSV</button>
      <button data-act="sync">Sync now</button>
      <button data-act="exit">Exit to games list</button>
      <button data-act="close">Close</button>
    </div>`, async (act, btn, dlg) => {
    if (act === 'backup') {
      const r = await backupJSON(current.game, current.events);
      if (r !== 'cancelled') toast('Backup created');
    } else if (act === 'csv') {
      await exportCSV(current.game, current.events);
    } else if (act === 'sync') {
      dlg.close();
      await syncNow();
      const after = getSyncStatus();
      toast(after.pending ? `Not synced: ${esc(after.error || 'still pending')}` : 'All synced', after.pending ? 'error' : '');
    } else if (act === 'exit') {
      if (getSyncStatus().pending && !confirm('Some pitches are not uploaded yet. They stay safe on this device. Exit anyway?')) return;
      dlg.close();
      showHome();
    }
  });
}

// ---------- settings ----------
async function showSettings() {
  app.classList.remove('tracker-mode');
  const settings = await db.getSettings();
  const s = getSyncStatus();
  app.innerHTML = `
    <header class="bar">
      <button class="icon" data-act="back" aria-label="Back">‹</button>
      <h1>Settings</h1>
      <span></span>
    </header>
    <main class="page">
      <form id="settings">
        <h2>Google Sheet connection</h2>
        <label>Apps Script web app URL<input name="url" type="url" value="${esc(settings.url)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
        <label>Token<input name="token" value="${esc(settings.token)}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <label>Your name <span class="muted">(saved on each pitch as recorded_by)</span><input name="recorder" value="${esc(settings.recorder)}" autocapitalize="words" placeholder="optional"></label>
        <div class="row-buttons">
          <button type="button" data-act="test">Test connection</button>
          <button type="submit" class="primary">Save</button>
        </div>
      </form>
      <h2>Share with other recorders</h2>
      ${settings.url && settings.token ? `
        <p class="muted small">Anyone who opens this link gets connected to this sheet and can add pitches to it. Share it only with people who record for you.
        To let people <em>view</em> the data, share the Google Sheet itself instead.</p>
        <input id="setup-link" readonly value="${esc(buildSetupLink(appBaseUrl(), settings))}">
        <div class="row-buttons"><button data-act="share-link" class="primary">Share setup link</button></div>`
        : '<p class="muted small">Connect a sheet first, then you can share a setup link from here.</p>'}
      <h2>Use a setup link</h2>
      <input id="connect-input" placeholder="Paste a setup link" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="row-buttons"><button data-act="paste-link">Paste</button><button data-act="connect">Connect</button></div>
      <h2>Status</h2>
      <ul class="facts">
        <li>Pitches waiting to upload: <strong>${s.pending}</strong></li>
        <li>Last sync: ${s.lastSync ? new Date(s.lastSync).toLocaleString() : 'not this session'}</li>
        <li>Installed as app: ${isStandalone() ? 'yes' : '<strong>no</strong> — add to Home Screen'}</li>
        <li>Persistent storage: ${esc(persistence)}</li>
        <li>App version: <span id="app-version">…</span></li>
        <li>Opened at: <code class="small">${esc(launchAddress)}</code></li>
      </ul>
    </main>`;
  appVersion().then((v) => { const el = document.getElementById('app-version'); if (el) el.textContent = v; });
  const form = document.getElementById('settings');
  app.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'back') showHome();
    if (btn.dataset.act === 'test') {
      const url = form.url.value.trim();
      try { await testConnection(url); toast('Connection works ✓'); }
      catch (err) { toast(`Connection failed: ${esc(err.message)}`, 'error'); }
    }
    if (btn.dataset.act === 'share-link') shareSetupLink(document.getElementById('setup-link').value);
    if (btn.dataset.act === 'paste-link') pasteInto(document.getElementById('connect-input'));
    if (btn.dataset.act === 'connect') {
      if (await connectFromLink(document.getElementById('connect-input').value)) {
        if (await keepLinkInAddress()) location.reload(); else showSettings();
      }
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    await updateSettings({ url: form.url.value.trim(), token: form.token.value.trim(), recorder: form.recorder.value.trim() });
    if (await keepLinkInAddress()) { location.reload(); return; }
    toast('Saved');
    syncNow();
  };
}

// ---------- setup links ----------
function appBaseUrl() {
  return location.origin + location.pathname;
}

async function updateSettings(patch) {
  settingsCache = { ...settingsCache, ...patch };
  await db.saveSettings(settingsCache);
}

function recorderLabel() {
  return settingsCache.recorder || `device-${(settingsCache.deviceId || '').slice(0, 6)}`;
}

async function pasteInto(input) {
  try {
    input.value = await navigator.clipboard.readText();
  } catch {
    input.focus();
    toast('Long-press the box and choose Paste');
  }
}

// Saves the connection from a setup link. Returns true if connected.
async function connectFromLink(text, { fromUrl = false } = {}) {
  const c = decodeConnect(text);
  if (!c) {
    if (!fromUrl) toast('That is not a valid setup link', 'error');
    return false;
  }
  if (fromUrl && settingsCache.appliedLink === c.code) return false; // already applied
  const same = settingsCache.url === c.url && settingsCache.token === c.token;
  if (!same && settingsCache.url && !confirm('Replace the current sheet connection with the one from this link?')) {
    await updateSettings({ appliedLink: c.code });
    return false;
  }
  await updateSettings({ url: c.url, token: c.token, appliedLink: c.code });
  const msg = same ? 'Already connected to this sheet' : 'Connected to the sheet ✓';
  toast(msg);
  try { sessionStorage.setItem('pt-toast', msg); } catch { /* shown again after a reload, if storage works */ }
  syncNow();
  return true;
}

// iOS gives an app added to the Home Screen its own, empty storage, so a
// connection saved in Safari doesn't carry over. Instead, while the page is open
// in a browser tab and connected, the setup link is kept in the address bar:
// "Add to Home Screen" saves that address, and the installed app connects itself
// on first launch. Returns true if the address changed (the caller reloads so the
// page is loaded fresh from the new address).
async function keepLinkInAddress() {
  if (isStandalone() || !settingsCache.url || !settingsCache.token) return false;
  const link = buildSetupLink(appBaseUrl(), settingsCache);
  if (location.href === link) return false;
  await updateSettings({ appliedLink: decodeConnect(link).code });
  history.replaceState(null, '', link);
  return true;
}

async function appVersion() {
  try {
    const keys = (await caches.keys()).filter((k) => k.startsWith('pitchtracker-'));
    return keys.map((k) => k.slice('pitchtracker-'.length)).join(', ') || 'not cached yet';
  } catch {
    return 'unknown';
  }
}

// Safari side of the hand-over: put this phone's setup link on the clipboard.
async function copySetupLink() {
  const link = buildSetupLink(appBaseUrl(), settingsCache);
  try {
    await navigator.clipboard.writeText(link);
    toast('Setup link copied. Now Share → Add to Home Screen');
  } catch {
    toast('Could not copy. Use Settings → Share setup link', 'error');
  }
}

// Installed-app side: read the link from the clipboard and connect, in one tap.
// iOS shows a small "Paste" bubble to confirm reading the clipboard.
async function pasteAndConnect() {
  const input = document.getElementById('connect-input');
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    input?.focus();
    toast('Long-press the box below and choose Paste, then Connect');
    return;
  }
  if (input) input.value = text;
  if (!(await connectFromLink(text))) return;
  if (await keepLinkInAddress()) location.reload(); else showHome();
}

async function shareSetupLink(link) {
  try {
    if (navigator.share) {
      await navigator.share({ title: 'PitchTracker setup link', text: 'Open this to set up PitchTracker, then Add to Home Screen:', url: link });
      return;
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
  }
  try {
    await navigator.clipboard.writeText(link);
    toast('Setup link copied');
  } catch {
    const input = document.getElementById('setup-link');
    input.select();
    toast('Select the link and copy it');
  }
}

// ---------- boot ----------
async function boot() {
  if ('serviceWorker' in navigator) {
    // When a new version finishes installing it takes over (sw.js). Reload so it's
    // used straight away, except during a game: then wait until back on the home screen.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || updateReady) return; // first install: nothing old to replace
      updateReady = true;
      if (!current) location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
  }
  persistence = await db.requestPersistence();
  settingsCache = await db.getSettings();
  if (!settingsCache.deviceId) await updateSettings({ deviceId: uuid() });
  // The link stays in the address bar on purpose: iOS keeps it when the page is
  // added to the Home Screen, so the installed app connects on first launch too.
  if (location.hash.includes('connect=')) await connectFromLink(location.hash, { fromUrl: true });
  if (await keepLinkInAddress()) { location.reload(); return; }
  // Android Back during a game: close an open dialog, or go back to the games list.
  // Pitches are already saved, so leaving the tracker never loses anything.
  window.addEventListener('popstate', () => {
    const dlg = document.querySelector('dialog[open]');
    if (dlg) { dlg.close(); if (current) history.pushState({ tracker: true }, '', location.href); return; }
    if (current) showHome();
  });
  // Chrome/Android offers its own install prompt; keep it for the "Install app" button.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    if (!current && document.querySelector('[data-act="new"]')) showHome();
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; });
  initSync();
  await showHome();
  try {
    const msg = sessionStorage.getItem('pt-toast');
    if (msg) { sessionStorage.removeItem('pt-toast'); toast(esc(msg)); }
  } catch { /* ignore */ }
}

window.addEventListener('error', (e) => {
  // Errors from scripts that aren't the app's own (Safari's share sheet, browser
  // extensions) arrive as a bare "Script error." with no file. They don't affect
  // the app, so don't show them.
  if (!e.filename || !e.filename.startsWith(location.origin)) {
    console.warn('Ignored error from outside the app:', e.message);
    return;
  }
  toast(`Error: ${esc(e.message)}`, 'error');
});
window.addEventListener('unhandledrejection', (e) => toast(`Error: ${esc(e.reason?.message || e.reason)}`, 'error'));
boot();
