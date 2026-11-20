import * as db from './db.js';
import {
  PITCH_TYPES, ACTIONS, RESULT_LABELS, PA_END_LABELS, PA_RESULTS, OUTCOME_TREE, NEXT_BATTER_REASONS, BP_NEXT_REASONS, isBp,
  replay, buildPitchRow, pitchPaRow, outcomePaRow, nextBatterPaRow, activeEvents,
  battingIndex, fieldingIndex, battingTeam, fieldingTeam, currentBatter, halfLabel, gameTeams,
} from './game.js';
import {
  initSync, syncNow, syncSoon, refreshPending, onSyncStatus, getSyncStatus, testConnection, fetchRosters,
} from './sync.js';
import { findByName, findByNumber } from './roster.js';
import { backupJSON, exportCSV, exportPaCSV, importBackup } from './backup.js';
import { buildSetupLink, decodeConnect, isSetupLinkHash, isValidScriptUrl, sheetCode } from './connect.js';
import qrcodegen from './vendor/qrcodegen.js';

const app = document.getElementById('app');
const LINEUP_SIZE = 9;

let current = null; // { game, events, state }
let sel = { pitchType: null, zone: null, action: null };
let tree = { category: null, result: null }; // ball-in-play decision tree progress
let picking = false; // live BP: changing the batter in the middle of an at-bat
let persistence = 'unknown';
let settingsCache = {}; // { url, token, recorder, deviceId, appliedLink }
let updateReady = false;  // a new version has taken over; reload at the next safe moment
// How this launch was opened, with any token hidden. Shown in Settings to diagnose installs.
const launchAddress = location.origin + location.pathname
  + (location.search ? '?…' : '') + (isSetupLinkHash(location.hash) ? '#c=… (setup link)' : location.hash);

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
  // Errors stay up longer: they're often a sentence worth reading.
  toastTimer = setTimeout(() => { el.className = ''; }, kind === 'error' ? 6000 : 2600);
}

// One-line summary of the sync state, used by the badge and the status dialog.
function syncSummary(s = getSyncStatus()) {
  if (!s.configured) {
    return s.pending
      ? { cls: 'warn', short: `⚠ ${s.pending}`, text: `${s.pending} not uploaded: no sheet connected` }
      : { cls: 'muted', short: 'No sheet', text: 'No sheet connected' };
  }
  if (s.syncing) return { cls: 'busy', short: `↻ ${s.pending}`, text: `Uploading ${s.pending}…` };
  // Waiting a moment before the upload starts is normal, not a warning: only an
  // upload that failed turns the badge yellow.
  if (s.pending && !s.error) return { cls: 'busy', short: `↻ ${s.pending}`, text: `${s.pending} waiting to upload` };
  if (s.pending) return { cls: 'warn', short: `⚠ ${s.pending}`, text: `${s.pending} not uploaded: ${esc(s.error)}` };
  return { cls: 'ok', short: '✓', text: 'All synced' };
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
        <input id="connect-input" placeholder="https://…#c=…" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="row-buttons"><button data-act="connect">Connect</button></div>
      </div>`}
      <div class="new-buttons">
        <button class="big primary" data-act="new">＋ New game</button>
        <button class="big" data-act="new-bp">＋ Live BP</button>
      </div>
      <h2>Games</h2>
      <ul class="list">
        ${games.map((g) => `<li><button class="row" data-act="open" data-key="${esc(g.key)}">
            <strong>${esc(g.gameId)}${isBp(g) ? ' <span class="tag">Live BP</span>' : ''}</strong>
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
    else if (act === 'new-bp') showBpSetup();
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

// ---------- rosters ----------
const rosterOption = (p) => `<option value="${esc(p.name)}">${p.number ? `#${esc(p.number)}` : ''}</option>`;
const rosterDatalist = (id, players) => (players?.length ? `<datalist id="${id}">${players.map(rosterOption).join('')}</datalist>` : '');
const rosterPlayerLabel = (p) => `${p.number ? `<b>#${esc(p.number)}</b> ` : ''}${esc(p.name)}`;

// Lineup boxes (t<team>_num<i>, t<team>_name<i>, t<team>_pitcher): picking or typing a
// roster name fixes its spelling and fills the number; a roster number fills the name,
// unless a different name was already typed there. `playersFor(team)` gives the roster.
function wireRosterInputs(root, playersFor) {
  root.addEventListener('change', (e) => {
    const m = /^t(\d+)_(num|name|pitcher)(\d*)$/.exec(e.target.name || '');
    if (!m) return;
    const players = playersFor(Number(m[1]));
    if (!players?.length) return;
    const field = (kind) => root.querySelector(`[name="t${m[1]}_${kind}${m[3]}"]`);
    if (m[2] === 'num') {
      const p = findByNumber(players, e.target.value);
      const name = field('name');
      if (p && name && (!name.value.trim() || name.value === name.defaultValue)) name.value = p.name;
      return;
    }
    const p = findByName(players, e.target.value);
    if (!p) return;
    e.target.value = p.name;
    const num = m[2] === 'name' && field('num');
    if (num) num.value = p.number;
  });
}

// Tap players into the batting order; the result is written into the setup form.
function showRosterPicker(form, t, roster) {
  const players = roster.players;
  const nameOf = (i) => form.querySelector(`[name="t${t}_name${i}"]`);
  const numOf = (i) => form.querySelector(`[name="t${t}_num${i}"]`);
  const pitcherInput = form.querySelector(`[name="t${t}_pitcher"]`);
  // Start from what's in the form already, so reopening the picker keeps the order.
  const order = Array.from({ length: LINEUP_SIZE }, (_, i) => {
    const p = findByName(players, nameOf(i).value);
    return p ? players.indexOf(p) : null;
  }).map((v, i, a) => (v !== null && a.indexOf(v) === i ? v : null));
  let pitcher = findByName(players, pitcherInput.value)?.name || '';

  const render = () => {
    const used = new Set(order.filter((v) => v !== null));
    const filled = used.size;
    return `
      <h2>${esc(roster.name)} · starting ${LINEUP_SIZE}</h2>
      <p class="muted small">Tap players in batting order. ${filled}/${LINEUP_SIZE} picked.</p>
      <ol class="order">
        ${order.map((v, i) => `<li class="${v === null ? 'empty' : ''}">
          <span class="slot">${i + 1}</span>
          <span class="who">${v === null ? '<span class="muted">tap a player below</span>' : rosterPlayerLabel(players[v])}</span>
          ${v === null ? '' : `<span class="moves">
            <button type="button" data-act="up" data-slot="${i}" aria-label="Move up" ${i ? '' : 'disabled'}>↑</button>
            <button type="button" data-act="down" data-slot="${i}" aria-label="Move down" ${i < LINEUP_SIZE - 1 ? '' : 'disabled'}>↓</button>
            <button type="button" data-act="remove" data-slot="${i}" aria-label="Remove">✕</button></span>`}
        </li>`).join('')}
      </ol>
      <h3 class="sub">Bench <span class="muted">(${players.length - filled})</span></h3>
      <div class="bench">
        ${players.map((p, i) => (used.has(i) ? '' : `<button type="button" data-act="add" data-i="${i}">${rosterPlayerLabel(p)}</button>`)).join('')
          || '<p class="muted small">Everyone is in the lineup.</p>'}
      </div>
      <label>Starting pitcher
        <select name="picker-pitcher">
          <option value="">${pitcherInput.value && !pitcher ? esc(pitcherInput.value) : '— none —'}</option>
          ${players.map((p) => `<option value="${esc(p.name)}" ${p.name === pitcher ? 'selected' : ''}>${p.number ? `#${esc(p.number)} ` : ''}${esc(p.name)}</option>`).join('')}
        </select></label>
      <div class="row-buttons">
        <button type="button" data-act="clear">Clear</button>
        <button type="button" data-act="close">Cancel</button>
        <button type="button" class="primary" data-act="use">Use lineup</button>
      </div>`;
  };
  const dlg = openDialog('<div class="picker"></div>', (act, btn, d) => {
    const slot = Number(btn.dataset.slot);
    if (act === 'add') {
      const free = order.indexOf(null);
      if (free < 0) { toast(`The batting order is full. Remove someone first`); return; }
      order[free] = Number(btn.dataset.i);
    } else if (act === 'remove') {
      order[slot] = null;
    } else if (act === 'up' || act === 'down') {
      const to = act === 'up' ? slot - 1 : slot + 1;
      [order[slot], order[to]] = [order[to], order[slot]];
    } else if (act === 'clear') {
      order.fill(null);
    } else if (act === 'use') {
      order.forEach((v, i) => {
        nameOf(i).value = v === null ? '' : players[v].name;
        numOf(i).value = v === null ? '' : players[v].number;
      });
      // "— none —" keeps a pitcher typed by hand who isn't on the roster.
      if (pitcher || findByName(players, pitcherInput.value)) pitcherInput.value = pitcher;
      d.close();
      return;
    } else return;
    draw();
  });
  const box = dlg.querySelector('.picker');
  const draw = () => { const y = dlg.scrollTop; box.innerHTML = render(); dlg.scrollTop = y; };
  dlg.addEventListener('change', (e) => { if (e.target.name === 'picker-pitcher') pitcher = e.target.value; });
  draw();
}

// ---------- setup ----------
async function showSetup() {
  app.classList.remove('tracker-mode');
  const today = new Date().toISOString().slice(0, 10);
  let { rosters, fetchedAt } = await db.getRosters();
  const connected = !!settingsCache.url;
  // Team 0 is the away team (bats in the top of each inning), team 1 the home team.
  const teamForm = (t, title) => `
    <fieldset class="team">
      <legend>${title}</legend>
      <div class="roster-choice" id="roster-choice-${t}"></div>
      <label>Team name<input name="t${t}_team" value="${t ? 'Home' : 'Away'}" autocapitalize="words"></label>
      <label>Starting pitcher <span class="muted">(optional)</span><input name="t${t}_pitcher" autocapitalize="words" autocomplete="off" list="roster-list-${t}"></label>
      <h3>Batting order <span class="muted">(blank = Batter 1–9)</span></h3>
      ${Array.from({ length: LINEUP_SIZE }, (_, i) => `
        <div class="lineup-row">
          <span class="slot">${i + 1}</span>
          <input name="t${t}_num${i}" inputmode="numeric" placeholder="#" class="num" autocomplete="off">
          <input name="t${t}_name${i}" placeholder="Batter ${i + 1}" autocomplete="off" autocapitalize="words" list="roster-list-${t}">
        </div>`).join('')}
      <div id="roster-lists-${t}"></div>
    </fieldset>`;

  app.innerHTML = `
    <header class="bar">
      <button class="icon" data-act="back" aria-label="Back">‹</button>
      <h1>New game</h1>
      <span></span>
    </header>
    <main class="page">
      <form id="setup" autocomplete="off">
        <label>Game ID<input name="gameId" required value="${today}-" autocapitalize="characters"></label>
        ${connected ? '<div class="roster-status" id="roster-status"></div>' : ''}
        <div class="teams">
          ${teamForm(0, 'Away team <span class="muted">· bats first</span>')}
          ${teamForm(1, 'Home team')}
        </div>
        <button class="big primary" type="submit">Start game</button>
      </form>
    </main>`;

  const form = document.getElementById('setup');
  const chosen = [null, null]; // roster picked for each team
  let rosterError = connected ? null : '';
  let loading = connected;
  const drawRosters = () => {
    const status = document.getElementById('roster-status');
    if (status) {
      const saved = rosters.length
        ? `${rosters.length} roster${rosters.length > 1 ? 's' : ''} from the sheet${fetchedAt ? ` · ${new Date(fetchedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : ''}`
        : 'No rosters yet. Fill in the <b>Rosters</b> tab of the sheet, then refresh.';
      // Say why a download failed: otherwise an old script or a bad connection looks like an empty tab.
      status.innerHTML = `<span class="small ${rosterError ? 'roster-error' : 'muted'}">${loading ? 'Loading rosters…'
        : rosterError ? `Rosters not loaded: ${esc(rosterError)}${rosters.length ? ` <span class="muted">(using the saved copy: ${saved})</span>` : ''}`
        : saved}</span>
        <button type="button" data-act="refresh-rosters" ${loading ? 'disabled' : ''}>↻ Rosters</button>`;
    }
    for (const t of [0, 1]) {
      // Keep the choice when the list is refreshed, if that roster is still there.
      if (chosen[t]) chosen[t] = rosters.find((r) => r.name === chosen[t].name) || null;
      document.getElementById(`roster-choice-${t}`).innerHTML = rosters.length ? `
        <label>Roster
          <select name="t${t}_roster">
            <option value="">— type the lineup —</option>
            ${rosters.map((r, i) => `<option value="${i}" ${r === chosen[t] ? 'selected' : ''}>${esc(r.name)} (${r.players.length})</option>`).join('')}
          </select></label>
        ${chosen[t] ? `<button type="button" class="primary pick" data-act="pick" data-team="${t}">Pick starting ${LINEUP_SIZE} from ${esc(chosen[t].name)}</button>` : ''}` : '';
      document.getElementById(`roster-lists-${t}`).innerHTML = rosterDatalist(`roster-list-${t}`, chosen[t]?.players);
    }
  };
  const refreshRosters = async (quiet) => {
    loading = true;
    drawRosters();
    try {
      ({ rosters, fetchedAt } = await fetchRosters());
      rosterError = null;
      if (!quiet) toast(rosters.length ? `${rosters.length} roster${rosters.length > 1 ? 's' : ''} loaded` : 'The Rosters tab is empty');
    } catch (err) {
      rosterError = err.message;
    }
    loading = false;
    if (document.body.contains(form)) drawRosters();
  };
  if (connected) refreshRosters(true); else drawRosters(); // the saved copy is shown meanwhile, and used offline
  wireRosterInputs(form, (t) => chosen[t]?.players);
  form.addEventListener('change', (e) => {
    const m = /^t(\d)_roster$/.exec(e.target.name || '');
    if (!m) return;
    const t = Number(m[1]);
    const before = chosen[t];
    chosen[t] = rosters[e.target.value] || null;
    // Name the team after its roster, unless a name was typed by hand.
    const team = form.querySelector(`[name="t${t}_team"]`);
    if (chosen[t] && [team.defaultValue, before?.name, ''].includes(team.value.trim())) team.value = chosen[t].name;
    drawRosters();
    if (chosen[t]) showRosterPicker(form, t, chosen[t]);
  });

  app.onclick = (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'back') showHome();
    else if (btn.dataset.act === 'refresh-rosters') refreshRosters(false);
    else if (btn.dataset.act === 'pick') {
      const t = Number(btn.dataset.team);
      if (chosen[t]) showRosterPicker(form, t, chosen[t]);
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const gameId = String(f.get('gameId')).trim();
    const teams = [0, 1].map((t) => {
      const lineup = [];
      for (let i = 0; i < LINEUP_SIZE; i++) {
        const name = String(f.get(`t${t}_name${i}`)).trim();
        const number = String(f.get(`t${t}_num${i}`)).trim();
        if (name || number) lineup.push({ name: name || `Batter ${i + 1}`, number });
      }
      // Opponent's lineup unknown? Track them by batting-order spot.
      if (!lineup.length) for (let i = 0; i < LINEUP_SIZE; i++) lineup.push({ name: `Batter ${i + 1}`, number: '' });
      return {
        name: String(f.get(`t${t}_team`)).trim() || (t ? 'Home' : 'Away'),
        pitcher: String(f.get(`t${t}_pitcher`)).trim(),
        lineup,
        // A copy of the roster, for substitutions later (works offline, unaffected by sheet edits).
        ...(chosen[t] ? { roster: chosen[t] } : {}),
      };
    });
    if (!gameId) { toast('Enter a game ID', 'error'); return; }
    const game = { key: uuid(), gameId, teams, createdAt: Date.now() };
    await db.putGame(game);
    showTracker(game.key);
  };
}

// Live BP: one team, its own pitchers against its own hitters, batters picked as they come up.
async function showBpSetup() {
  app.classList.remove('tracker-mode');
  const today = new Date().toISOString().slice(0, 10);
  let { rosters, fetchedAt } = await db.getRosters();
  const connected = !!settingsCache.url;
  app.innerHTML = `
    <header class="bar">
      <button class="icon" data-act="back" aria-label="Back">‹</button>
      <h1>Live BP</h1>
      <span></span>
    </header>
    <main class="page">
      <form id="bp-setup" autocomplete="off">
        <p class="muted small">Your own pitchers against your own hitters. No batting order, innings or outs:
          after every at-bat the app asks who's up.</p>
        <label>Session ID<input name="gameId" required value="${today}-BP" autocapitalize="characters"></label>
        ${connected ? '<div class="roster-status" id="roster-status"></div>' : ''}
        <fieldset class="team">
          <legend>Team</legend>
          <div class="roster-choice" id="roster-choice-0"></div>
          <label>Team name<input name="t0_team" value="" autocapitalize="words" placeholder="Team"></label>
          <h3>Pitcher <span class="muted">(change any time)</span></h3>
          <div class="bench pitcher-pick" id="pitcher-pick"></div>
          <label><span id="pitcher-label">Pitcher</span><input name="t0_pitcher" autocapitalize="words" autocomplete="off" list="roster-list-0"></label>
          <div id="roster-lists-0"></div>
        </fieldset>
        <button class="big primary" type="submit">Start live BP</button>
      </form>
    </main>`;
  const form = document.getElementById('bp-setup');
  let chosen = null;
  let rosterError = connected ? null : '';
  let loading = connected;
  const draw = () => {
    const status = document.getElementById('roster-status');
    if (status) {
      status.innerHTML = `<span class="small ${rosterError ? 'roster-error' : 'muted'}">${loading ? 'Loading rosters…'
        : rosterError ? `Rosters not loaded: ${esc(rosterError)}`
        : rosters.length ? `${rosters.length} roster${rosters.length > 1 ? 's' : ''} from the sheet${fetchedAt ? ` · ${new Date(fetchedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : ''}`
        : 'No rosters yet. Fill in the <b>Rosters</b> tab of the sheet, then refresh.'}</span>
        <button type="button" data-act="refresh-rosters" ${loading ? 'disabled' : ''}>↻ Rosters</button>`;
    }
    if (chosen) chosen = rosters.find((r) => r.name === chosen.name) || null;
    document.getElementById('roster-choice-0').innerHTML = rosters.length ? `
      <label>Roster <span class="muted">(the batters to pick from)</span>
        <select name="t0_roster">
          <option value="">— type names as they come up —</option>
          ${rosters.map((r, i) => `<option value="${i}" ${r === chosen ? 'selected' : ''}>${esc(r.name)} (${r.players.length})</option>`).join('')}
        </select></label>` : '';
    document.getElementById('roster-lists-0').innerHTML = rosterDatalist('roster-list-0', chosen?.players);
    drawPitchers();
  };
  // With a roster, the pitcher is a tap on a player; typing stays for anyone else.
  const drawPitchers = () => {
    const box = document.getElementById('pitcher-pick');
    const players = chosen?.players || [];
    const cur = form.querySelector('[name="t0_pitcher"]').value.trim();
    box.hidden = !players.length;
    box.innerHTML = players.map((p, i) => `<button type="button" data-act="pick-pitcher" data-i="${i}"
      class="${p.name === cur ? 'selected' : ''}" aria-pressed="${p.name === cur}">${rosterPlayerLabel(p)}</button>`).join('');
    document.getElementById('pitcher-label').textContent = players.length ? 'Or type a name' : 'Pitcher';
  };
  const refresh = async (quiet) => {
    loading = true;
    draw();
    try {
      ({ rosters, fetchedAt } = await fetchRosters());
      rosterError = null;
      if (!quiet) toast(rosters.length ? `${rosters.length} roster${rosters.length > 1 ? 's' : ''} loaded` : 'The Rosters tab is empty');
    } catch (err) {
      rosterError = err.message;
    }
    loading = false;
    if (document.body.contains(form)) draw();
  };
  if (connected) refresh(true); else draw();
  wireRosterInputs(form, () => chosen?.players);
  form.addEventListener('change', (e) => {
    if (e.target.name === 't0_pitcher') { drawPitchers(); return; }
    if (e.target.name !== 't0_roster') return;
    const before = chosen;
    chosen = rosters[e.target.value] || null;
    const team = form.querySelector('[name="t0_team"]');
    if (chosen && [before?.name, ''].includes(team.value.trim())) team.value = chosen.name;
    draw();
  });
  app.onclick = (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'back') showHome();
    else if (btn.dataset.act === 'refresh-rosters') refresh(false);
    else if (btn.dataset.act === 'pick-pitcher') {
      const p = chosen?.players[Number(btn.dataset.i)];
      const input = form.querySelector('[name="t0_pitcher"]');
      if (p) input.value = input.value === p.name ? '' : p.name; // tap again to clear
      drawPitchers();
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const gameId = String(f.get('gameId')).trim();
    if (!gameId) { toast('Enter a session ID', 'error'); return; }
    const team = {
      name: String(f.get('t0_team')).trim() || chosen?.name || 'Team',
      pitcher: String(f.get('t0_pitcher')).trim(),
      lineup: [],
      ...(chosen ? { roster: chosen } : {}),
    };
    const game = { key: uuid(), gameId, mode: 'bp', teams: [team], createdAt: Date.now() };
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
  tree = { category: null, result: null };
  picking = false;
  renderTracker();
}

function nextSeq() {
  return current.events.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
}

// Saves an event (and any rows it changes) to disk, then replays the game.
// Events that end a plate appearance carry a `paRow` for the PlateAppearances sheet.
async function addEvent(type, data, extra = {}) {
  const { game, state } = current;
  const ev = {
    id: uuid(), gameKey: game.key, seq: nextSeq(), type, data,
    createdAt: Date.now(), deleted: 0, dirty: 0, rev: 1, ...extra,
  };
  const changed = []; // other events whose rows this one updates
  if (type === 'pitch') {
    ev.row = buildPitchRow(game, state, data, ev);
    ev.row.recorded_by = recorderLabel();
    const pa = pitchPaRow(game, state, data, ev);
    if (pa) ev.paRow = pa;
  } else if (type === 'outcome') {
    ev.paRow = outcomePaRow(game, state, data, ev);
    // The ball-in-play pitch row gets the result too.
    const pitch = current.events.find((e) => e.id === data.pitchId);
    if (pitch?.row) changed.push(withRow(pitch, { pa_result: data.result }));
  } else if (type === 'nextBatter') {
    const pa = nextBatterPaRow(game, state, data.reason, ev);
    if (pa) ev.paRow = pa;
  }
  if (ev.paRow) ev.paRow.recorded_by = recorderLabel();
  if (ev.row || ev.paRow) ev.dirty = 1;
  await db.putEvents([ev, ...changed]); // committed to disk before we move on
  replaceEvents(changed);
  current.events.push(ev);
  current.state = replay(game, current.events);
  return ev;
}

// A copy of a pitch event with its sheet row changed, queued for upload again.
function withRow(ev, patch) {
  return { ...ev, row: { ...ev.row, ...patch }, rev: ev.rev + 1, dirty: 1 };
}

function replaceEvents(updated) {
  const byId = new Map(updated.map((e) => [e.id, e]));
  current.events = current.events.map((e) => byId.get(e.id) || e);
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

const teamLabel = (state, i) => esc(state.teams[i].name || (i ? 'Home' : 'Away'));

// The ball-in-play decision tree: category → detail → fielder. The pitch is already
// saved; the outcome is saved as its own event once the last choice is made.
function treeHTML() {
  const { state } = current;
  const batter = playerLabel(currentBatter(state));
  let title; let pads; let cols;
  if (!tree.category) {
    title = `Ball in play: ${batter}`;
    cols = 'tree-5';
    pads = Object.entries(OUTCOME_TREE).map(([k, c]) => [k, c.label, 'tree-cat']);
  } else if (!tree.result) {
    const c = OUTCOME_TREE[tree.category];
    title = c.label;
    const opts = Object.entries(c.options);
    cols = `tree-${opts.length}`;
    pads = opts.map(([k, o]) => [k, o.short || o.label, 'tree-result']);
  } else {
    title = `${PA_RESULTS[tree.result].label}: where did the ball go?`;
    cols = 'tree-fielder';
    // Laid out roughly like the field, outfield at the top.
    pads = ['LF', 'CF', 'RF', '3B', 'SS', '2B', 'P', 'C', '1B'].map((f) => [f, f, 'tree-fielder']);
    pads.push(['', 'Skip', 'tree-fielder skip']);
  }
  return `<section class="group group-outcome">
    <div class="tree-head">
      ${tree.category ? '<button data-act="tree-back" class="tree-back" aria-label="Back">‹ Back</button>' : ''}
      <h3>${title}</h3>
    </div>
    <div class="pads tree-pads ${cols}">
      ${pads.map(([value, label, act]) => `<button class="pad ${act.includes('skip') ? 'skip' : ''}" data-act="${act.split(' ')[0]}" data-value="${value}">${label}</button>`).join('')}
    </div></section>`;
}

// Live BP: finished plate appearances per batter in this session, for the "who's up" buttons.
function bpAtBats() {
  const n = new Map();
  for (const e of activeEvents(current.events)) if (e.paRow) n.set(e.paRow.batter, (n.get(e.paRow.batter) || 0) + 1);
  return n;
}
const bpRoster = () => gameTeams(current.game)[0]?.roster?.players || [];

// Live BP: who's up? Shown in place of the pads after every at-bat.
function whoUpHTML() {
  const { state } = current;
  const last = state.batter;
  const pitcher = findByName(bpRoster(), state.teams[0].pitcher);
  const abs = bpAtBats();
  const players = bpRoster().map((p, i) => ({ p, i })).filter(({ p }) => p !== pitcher);
  return `<section class="group group-whoup">
    <div class="tree-head">
      ${picking ? '<button data-act="bp-cancel" class="tree-back">‹ Cancel</button>' : ''}
      <h3>${picking ? `Change batter <span class="muted">(${playerLabel(last)}'s at-bat is left unfinished)</span>` : "Who's up?"}</h3>
    </div>
    ${last && !picking ? `<button class="pad same" data-act="bp-same">Same batter again: ${playerLabel(last)}</button>` : ''}
    <div class="bench whoup">
      ${players.map(({ p, i }) => `<button type="button" data-act="bp-pick" data-i="${i}" class="${last && p.name === last.name ? 'last-up' : ''}">
        <span>${rosterPlayerLabel(p)}</span>${abs.get(p.name) ? `<span class="note">${abs.get(p.name)} PA</span>` : ''}</button>`).join('')}
    </div>
    <div class="whoup-other">
      <input id="bp-name" placeholder="${players.length ? 'Someone else: name or #' : 'Batter name or #'}" autocomplete="off" autocapitalize="words"${players.length ? ' list="bp-list"' : ''}>
      <button data-act="bp-other" class="primary">Up</button>
      ${rosterDatalist('bp-list', bpRoster())}
    </div>
  </section>`;
}

function renderBpTracker() {
  const { state } = current;
  const t = state.teams[0];
  const batter = currentBatter(state);
  const pending = !!state.pending;
  const asking = state.awaitingBatter || picking;
  if (!pending) tree = { category: null, result: null };
  const abs = bpAtBats().get(batter.name) || 0;
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
    <div class="batter-bar bp">
      <div class="batter-name"><span class="label">Live BP${t.name ? ` · ${esc(t.name)}` : ''}</span>
        <strong>${state.awaitingBatter ? '<span class="muted">Pick the batter</span>' : playerLabel(batter)}</strong><span class="muted"> · PA ${state.paNumber}</span></div>
      <div class="last ${current.last?.paEnd ? 'pa-end' : ''}">${current.last?.html || '&nbsp;'}</div>
      <div class="muted small deck">${t.pitcher ? `P: ${esc(t.pitcher)} (${t.pitcherPitches})` : 'P: not entered'} · ${state.pitchNumber} pitches${!state.awaitingBatter && abs ? ` · ${esc(batter.name)} ${abs} PA today` : ''}</div>
    </div>
    <main class="tracker ${pending ? 'tree' : ''} ${asking && !pending ? 'whoup-mode' : ''}">
      ${pending ? treeHTML() : asking ? whoUpHTML() : `
      ${padGroup('Pitch', 'pitchType', { FB: 'Fastball', CB: 'Curveball' }, 2)}
      ${padGroup('Zone', 'zone', { IN: 'In', OUT: 'Out' }, 2)}
      ${padGroup('Batter', 'action', { TAKE: 'Take', SWING: 'Swing', FOUL: 'Foul', IN_PLAY: 'In play' }, 4)}`}
    </main>
    <footer class="actions bp">
      <button data-act="undo" ${activeEvents(current.events).length ? '' : 'disabled'}>↶ Undo</button>
      <button data-act="next" ${pending || state.awaitingBatter ? 'disabled' : ''}>End AB</button>
      <button data-act="bp-batter" ${pending || asking ? 'disabled' : ''}>Batter</button>
      <button data-act="bp-pitcher">Pitcher</button>
      <button data-act="log">Log</button>
    </footer>`;
  app.onclick = (e) => { queue = queue.then(() => handleTrackerClick(e)).catch((err) => toast(`Error: ${esc(err.message)}`, 'error')); };
  const input = document.getElementById('bp-name');
  if (input) input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); document.querySelector('[data-act=bp-other]')?.click(); } };
}

async function pickBatter(p) {
  if (!p?.name) { toast('Type the batter\'s name', 'error'); return; }
  const wasMid = picking;
  await addEvent('batterUp', { name: p.name, number: p.number || '' });
  picking = false;
  current.last = { html: `${wasMid ? 'Batter changed: ' : 'Up: '}<b>${playerLabel(p)}</b>`, paEnd: false };
  renderTracker();
}

function showBpPitcherDialog() {
  const t = current.state.teams[0];
  const players = bpRoster();
  const dlg = openDialog(`
    <form method="dialog">
      <h2>Pitcher</h2>
      <p class="muted small">Now: ${t.pitcher ? `<b>${esc(t.pitcher)}</b> · ${t.pitcherPitches} pitches` : 'not entered'}. A new pitcher starts a new pitch count.</p>
      ${players.length ? `<div class="bench">${players.map((p, i) => `<button type="button" data-act="bp-p" data-i="${i}" ${p.name === t.pitcher ? 'disabled' : ''}>${rosterPlayerLabel(p)}</button>`).join('')}</div>` : ''}
      <label>Or type a name<input name="pitcher" autocapitalize="words" autocomplete="off"></label>
      <div class="row-buttons">
        <button type="button" data-act="close">Cancel</button>
        <button type="button" class="primary" data-act="bp-p-save">Save</button>
      </div>
    </form>`, (act, btn, d) => {
    let name = null;
    if (act === 'bp-p') name = players[Number(btn.dataset.i)]?.name;
    else if (act === 'bp-p-save') {
      const typed = d.querySelector('[name=pitcher]').value.trim();
      name = findByName(players, typed)?.name || typed;
    } else return;
    if (!name || name === t.pitcher) { d.close(); return; }
    d.close();
    queue = queue.then(async () => {
      await addEvent('pitcher', { team: 0, name });
      current.last = { html: `New pitcher: <b>${esc(name)}</b>`, paEnd: false };
      renderTracker();
    }).catch((err) => toast(`Error: ${esc(err.message)}`, 'error'));
  });
  dlg.querySelector('form').onsubmit = (e) => e.preventDefault();
}

function renderTracker() {
  if (current.state.bp) { renderBpTracker(); return; }
  const { state } = current;
  const bi = battingIndex(state);
  const bt = battingTeam(state);
  const two = state.teams.length > 1;
  const batter = currentBatter(state);
  const onDeck = bt.lineup[(bt.slot + 1) % bt.lineup.length];
  const pitcher = fieldingTeam(state).pitcher;
  const pending = !!state.pending;
  if (!pending) tree = { category: null, result: null };
  app.classList.add('tracker-mode');
  app.innerHTML = `
    <header class="scorebar">
      <button class="icon" data-act="menu" aria-label="Menu">☰</button>
      <div class="count" aria-label="Count ${state.balls} balls ${state.strikes} strikes, ${state.outs} out">
        <div class="count-num">${state.balls}<span>-</span>${state.strikes}</div>
        <div class="count-dots"><span>B ${dots(state.balls, 3, 'ball')}</span><span>S ${dots(state.strikes, 2, 'strike')}</span><span>O ${dots(state.outs, 2, 'out')}</span></div>
      </div>
      ${badgeHTML(getSyncStatus(), true)}
    </header>
    <div class="batter-bar">
      <div class="batter-name"><span class="label">${two ? `${halfLabel(state)} ${teamLabel(state, bi)} · ` : ''}Batting ${bt.slot + 1}</span>
        <strong>${playerLabel(batter)}</strong><span class="muted"> · PA ${state.paNumber}</span></div>
      <div class="stepper inning" aria-label="Inning ${two ? halfLabel(state) : state.inning}">
        <button data-act="half" data-delta="-1" aria-label="Previous ${two ? 'half-inning' : 'inning'}" ${pending ? 'disabled' : ''}>−</button>
        <span><small>INN</small>${two ? halfLabel(state) : state.inning}</span>
        <button data-act="half" data-delta="1" aria-label="Next ${two ? 'half-inning' : 'inning'}" ${pending ? 'disabled' : ''}>+</button>
      </div>
      <div class="last ${current.last?.paEnd ? 'pa-end' : ''}">${current.last?.html || '&nbsp;'}</div>
      <div class="muted small deck">On deck: ${playerLabel(onDeck)}${pitcher ? ` · P: ${esc(pitcher)} (${fieldingTeam(state).pitcherPitches})` : ` · ${state.pitchNumber} pitches`}</div>
      <div class="stepper outs" aria-label="${state.outs} out">
        <button data-act="outs" data-delta="-1" aria-label="One out fewer" ${pending || !state.outs ? 'disabled' : ''}>−</button>
        <span><small>OUTS</small>${state.outs}</span>
        <button data-act="outs" data-delta="1" aria-label="One more out" ${pending ? 'disabled' : ''}>+</button>
      </div>
    </div>
    <main class="tracker ${pending ? 'tree' : ''}">
      ${pending ? treeHTML() : `
      ${padGroup('Pitch', 'pitchType', { FB: 'Fastball', CB: 'Curveball' }, 2)}
      ${padGroup('Zone', 'zone', { IN: 'In', OUT: 'Out' }, 2)}
      ${padGroup('Batter', 'action', { TAKE: 'Take', SWING: 'Swing', FOUL: 'Foul', IN_PLAY: 'In play' }, 4)}`}
    </main>
    <footer class="actions">
      <button data-act="undo" ${activeEvents(current.events).length ? '' : 'disabled'}>↶ Undo</button>
      <button data-act="next" ${pending ? 'disabled' : ''}>Next batter ›</button>
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
      // Show all three lit for a moment so the last tap is visibly confirmed. The
      // pitch is saved during the flash, not after it.
      renderTracker();
      await Promise.all([recordPitch(input), new Promise((r) => setTimeout(r, 140))]);
      sel = { pitchType: null, zone: null, action: null };
    }
    renderTracker();
  } else if (act === 'tree-cat') {
    if (!current.state.pending) return; // a stale double-tap
    tree = { category: btn.dataset.value, result: null };
    const opts = Object.keys(OUTCOME_TREE[tree.category].options);
    if (opts.length === 1) tree.result = opts[0]; // fielder's choice: nothing more to ask
    renderTracker();
  } else if (act === 'tree-result') {
    if (!current.state.pending || !tree.category) return;
    tree.result = btn.dataset.value;
    renderTracker();
  } else if (act === 'tree-fielder') {
    if (!current.state.pending || !tree.result) return;
    await recordOutcome({ ...tree, fielder: btn.dataset.value });
    renderTracker();
  } else if (act === 'tree-back') {
    if (tree.result && Object.keys(OUTCOME_TREE[tree.category].options).length > 1) tree.result = null;
    else tree = { category: null, result: null };
    renderTracker();
  } else if (act === 'undo') {
    await undo();
  } else if (act === 'next') {
    showNextBatterDialog();
  } else if (act === 'half') {
    await addEvent('half', { delta: Number(btn.dataset.delta) });
    current.last = { html: `Now ${describeHalf()}`, paEnd: false };
    renderTracker();
  } else if (act === 'outs') {
    const delta = Number(btn.dataset.delta);
    await addEvent('outs', { delta });
    current.last = { html: `${delta > 0 ? 'Added' : 'Removed'} an out${halfEndNote()}`, paEnd: false };
    renderTracker();
  } else if (act === 'bp-same') {
    if (current.state.awaitingBatter && current.state.batter) await pickBatter(current.state.batter);
  } else if (act === 'bp-pick') {
    const p = bpRoster()[Number(btn.dataset.i)];
    if (p) await pickBatter(p);
  } else if (act === 'bp-other') {
    const typed = document.getElementById('bp-name')?.value.trim() || '';
    const roster = bpRoster();
    const p = findByName(roster, typed) || findByNumber(roster, typed.replace(/^#/, ''))
      || (typed ? { name: typed, number: '' } : null);
    await pickBatter(p);
  } else if (act === 'bp-batter') {
    picking = true;
    renderTracker();
  } else if (act === 'bp-cancel') {
    picking = false;
    renderTracker();
  } else if (act === 'bp-pitcher') {
    showBpPitcherDialog();
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

function describeHalf(state = current.state) {
  if (state.teams.length < 2) return `inning ${state.inning}`;
  return `${state.half === 'bottom' ? 'bottom' : 'top'} ${state.inning}, ${teamLabel(state, battingIndex(state))} batting`;
}

// After an event: if it made the third out, say so (and pop a toast: the batting team changed).
function halfEndNote() {
  if (!current.state.lastHalfEnd) return '';
  toast(`3 outs · ${describeHalf()}`, 'pa-end');
  return ` · <b>3 outs</b> → ${describeHalf()}`;
}

async function recordPitch(input) {
  const ev = await addEvent('pitch', input);
  const r = ev.row;
  let msg = `Last: ${PITCH_TYPES[input.pitchType]} · ${input.zone === 'IN' ? 'In' : 'Out'} · ${ACTIONS[input.action]} → <b>${RESULT_LABELS[r.result]}</b>`;
  if (r.pa_end && r.pa_end !== 'in_play') {
    msg += ` · <b>${PA_END_LABELS[r.pa_end]}</b>${halfEndNote()}`;
  }
  current.last = { html: msg, paEnd: !!r.pa_end };
  await refreshPending();
  syncSoon();
}

async function recordOutcome({ category, result, fielder }) {
  const ev = await addEvent('outcome', { pitchId: current.state.pending.pitchId, category, result, fielder });
  const p = ev.paRow;
  current.last = {
    html: `<b>${esc(p.batter)}: ${PA_RESULTS[result].label}${fielder ? ` (${esc(fielder)})` : ''}</b>${halfEndNote()}`,
    paEnd: true,
  };
  tree = { category: null, result: null };
  await refreshPending();
  syncSoon();
}

function showNextBatterDialog() {
  const batter = playerLabel(currentBatter(current.state));
  const bp = !!current.state.bp;
  const reasons = Object.entries(NEXT_BATTER_REASONS).filter(([k]) => !bp || BP_NEXT_REASONS.includes(k));
  openDialog(`
    <h2>${bp ? 'End the at-bat: why?' : 'Next batter: why?'}</h2>
    <p class="muted small">${batter}'s plate appearance ends without a pitch result.</p>
    <div class="menu reasons">
      ${reasons.map(([k, r]) => `<button data-act="reason" data-reason="${k}" class="${k === 'other' ? '' : 'primary'}">${r.label}${r.outs ? ' <span class="muted-on">· 1 out</span>' : ''}</button>`).join('')}
      <button data-act="close">Cancel</button>
    </div>
    <p class="muted small">“Other / correction” only ${bp ? 'ends the at-bat' : 'moves to the next batter'} and records no result.</p>`, (act, btn, dlg) => {
    if (act !== 'reason') return;
    dlg.close();
    queue = queue.then(async () => {
      const reason = btn.dataset.reason;
      const ev = await addEvent('nextBatter', { reason });
      current.last = ev.paRow
        ? { html: `<b>${esc(ev.paRow.batter)}: ${PA_RESULTS[reason].label}</b>${halfEndNote()}`, paEnd: true }
        : { html: bp ? 'At-bat ended' : 'Moved to next batter', paEnd: false };
      renderTracker();
      if (ev.paRow) { await refreshPending(); syncSoon(); }
    }).catch((err) => toast(`Error: ${esc(err.message)}`, 'error'));
  });
}

function describeEvent(ev) {
  switch (ev.type) {
    case 'pitch': return `pitch (${PITCH_TYPES[ev.data.pitchType]}, ${ACTIONS[ev.data.action]})`;
    case 'outcome': return `result (${PA_RESULTS[ev.data.result]?.label || ev.data.result})`;
    case 'nextBatter': return ev.data.reason && ev.data.reason !== 'other'
      ? `next batter (${NEXT_BATTER_REASONS[ev.data.reason].label})` : 'next batter';
    case 'setBatter': return 'batter change';
    case 'batterUp': return `batter pick (${esc(ev.data.name)})`;
    case 'sub': return `substitution (${esc(ev.data.name)})`;
    case 'pitcher': return `pitcher change (${esc(ev.data.name)})`;
    case 'inning': case 'half': return 'inning change';
    case 'outs': return 'out change';
    default: return ev.type;
  }
}

async function undo() {
  const last = activeEvents(current.events).at(-1);
  if (!last) return;
  if (last.row || last.paRow) {
    // Keep a tombstone so the rows are marked deleted in the sheet too.
    const t = { ...last, deleted: 1, dirty: 1, rev: last.rev + 1 };
    if (t.row) t.row = { ...t.row, deleted: true };
    if (t.paRow) t.paRow = { ...t.paRow, deleted: true };
    const writes = [t];
    if (last.type === 'outcome') {
      const pitch = current.events.find((e) => e.id === last.data.pitchId);
      if (pitch?.row) writes.push(withRow(pitch, { pa_result: '' }));
    }
    await db.putEvents(writes);
    replaceEvents(writes);
  } else {
    await db.deleteEvent(last.id);
    current.events = current.events.filter((e) => e !== last);
  }
  current.state = replay(current.game, current.events);
  sel = { pitchType: null, zone: null, action: null };
  tree = { category: null, result: null };
  picking = false;
  current.last = { html: `Undid ${describeEvent(last)}`, paEnd: false };
  renderTracker();
  await refreshPending();
  syncSoon();
}

// Who has already played for a team in this game (starters, subs and pitchers),
// so the bench can mark players who were taken out.
function playedFor(ti) {
  const start = gameTeams(current.game)[ti];
  const batted = new Set(start.lineup.map((p) => p.name));
  const pitched = new Set(start.pitcher ? [start.pitcher] : []);
  for (const e of activeEvents(current.events)) {
    if ((e.data?.team ?? 0) !== ti) continue;
    if (e.type === 'sub') batted.add(e.data.name);
    else if (e.type === 'pitcher' && e.data.name) pitched.add(e.data.name);
  }
  return { batted, pitched };
}

function showLineupDialog() {
  const { state } = current;
  const bi = battingIndex(state);
  const fi = fieldingIndex(state);
  const two = state.teams.length > 1;
  // Batting team first: that's where substitutions usually happen.
  const order = two ? [bi, 1 - bi] : [0];
  const rosterOf = (ti) => gameTeams(current.game)[ti]?.roster?.players;
  const subBtn = (ti, slot, what) => `<button type="button" class="sub-btn" data-act="sub-target" data-team="${ti}" data-slot="${slot}" aria-label="Sub ${what} from the bench">⇄</button>`;
  const sections = order.map((ti) => {
    const t = state.teams[ti];
    const players = rosterOf(ti);
    const has = !!players?.length;
    const list = has ? ` list="sub-list-${ti}" autocomplete="off"` : '';
    const rows = t.lineup.map((p, i) => `
      <div class="lineup-row${has ? ' with-sub' : ''}" data-row="${ti}-${i}">
        ${ti === bi
          ? `<label class="slot-radio"><input type="radio" name="current" value="${i}" ${i === t.slot ? 'checked' : ''}><span>${i + 1}</span></label>`
          : `<span class="slot">${i + 1}</span>`}
        <input name="t${ti}_num${i}" class="num" inputmode="numeric" value="${esc(p.number)}" placeholder="#">
        <input name="t${ti}_name${i}" value="${esc(p.name)}" autocapitalize="words"${list}>
        ${has ? subBtn(ti, i, `batter ${i + 1}`) : ''}
      </div>`).join('');
    return `<fieldset class="team">
      ${two ? `<legend>${teamLabel(state, ti)} <span class="muted">· ${ti === bi ? 'batting' : 'in the field'}</span></legend>` : ''}
      ${rows}
      <label>${two ? `${teamLabel(state, ti)} pitcher${ti === fi ? ' <span class="muted">(pitching now)</span>' : ''}` : 'Pitcher'}</label>
      <div class="pitcher-row${has ? ' with-sub' : ''}" data-row="${ti}-p">
        <input name="t${ti}_pitcher" value="${esc(t.pitcher)}" autocapitalize="words" aria-label="Pitcher"${list}>
        ${has ? subBtn(ti, 'p', 'the pitcher') : ''}
      </div>
      ${has ? `<div class="sub-bench" id="sub-bench-${ti}"></div>` : ''}
      ${rosterDatalist(`sub-list-${ti}`, players)}
    </fieldset>`;
  }).join('');
  const dlg = openDialog(`
    <form method="dialog" id="lineup-form">
      <h2>Lineup &amp; substitutions</h2>
      <p class="muted small">${order.some((ti) => rosterOf(ti)?.length) ? 'Tap ⇄ on a spot, then a player from the bench, or edit a name.' : 'Edit a name to substitute that spot.'} The selected circle is the current batter.</p>
      ${sections}
      <div class="row-buttons sticky-actions">
        <button type="button" data-act="close">Cancel</button>
        <button type="button" class="primary" data-act="save">Save</button>
      </div>
    </form>`, async (act, btn, d) => {
    if (act === 'sub-target') {
      const t = { team: Number(btn.dataset.team), slot: btn.dataset.slot };
      target = target && target.team === t.team && target.slot === t.slot ? null : t;
      drawBenches();
      if (target) d.querySelector(`#sub-bench-${target.team}`)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (act === 'sub-in') {
      const ti = Number(btn.dataset.team);
      const p = rosterOf(ti)[Number(btn.dataset.i)];
      if (!target || target.team !== ti) { toast('Tap ⇄ next to the spot to fill first'); return; }
      if (!p) return;
      if (target.slot === 'p') input(ti, 'pitcher').value = p.name;
      else {
        input(ti, `name${target.slot}`).value = p.name;
        input(ti, `num${target.slot}`).value = p.number;
      }
      target = null;
      drawBenches();
      return;
    }
    if (act !== 'save') return;
    const f = new FormData(d.querySelector('form'));
    let changes = 0;
    for (const ti of order) {
      for (let i = 0; i < state.teams[ti].lineup.length; i++) {
        const name = String(f.get(`t${ti}_name${i}`)).trim();
        const number = String(f.get(`t${ti}_num${i}`)).trim();
        const p = current.state.teams[ti].lineup[i];
        if (name && (name !== p.name || number !== p.number)) {
          await addEvent('sub', { team: ti, slot: i, name, number, replaced: p.name });
          changes++;
        }
      }
      const pitcher = String(f.get(`t${ti}_pitcher`)).trim();
      if (pitcher !== current.state.teams[ti].pitcher) { await addEvent('pitcher', { team: ti, name: pitcher }); changes++; }
    }
    const slot = Number(f.get('current'));
    if (slot !== battingTeam(current.state).slot) { await addEvent('setBatter', { slot }); changes++; }
    d.close();
    if (changes) toast(`Saved ${changes} change${changes > 1 ? 's' : ''}`);
    renderTracker();
  });

  // The bench: roster players not in the lineup as edited so far. Batting spots
  // take anyone who isn't batting; the pitcher can be anyone but the current one.
  let target = null; // { team, slot: index | 'p' } waiting for a player
  const input = (ti, kind) => dlg.querySelector(`[name="t${ti}_${kind}"]`);
  const played = Object.fromEntries(order.map((ti) => [ti, playedFor(ti)]));
  const drawBenches = () => {
    dlg.querySelectorAll('[data-row]').forEach((r) => r.classList.toggle('targeted', !!target && r.dataset.row === `${target.team}-${target.slot}`));
    for (const ti of order) {
      const box = dlg.querySelector(`#sub-bench-${ti}`);
      if (!box) continue;
      // Show the bench right under the spot being filled, or at the end of the team.
      const row = target?.team === ti && dlg.querySelector(`[data-row="${ti}-${target.slot}"]`);
      if (row) row.after(box); else box.closest('fieldset').querySelector(`#sub-list-${ti}`).before(box);
      const players = rosterOf(ti);
      const n = state.teams[ti].lineup.length;
      const batting = new Set(Array.from({ length: n }, (_, i) => findByName(players, input(ti, `name${i}`).value)).filter(Boolean));
      const pitcher = findByName(players, input(ti, 'pitcher').value);
      const mine = target?.team === ti ? target : null;
      const forPitcher = mine?.slot === 'p';
      const out = forPitcher ? played[ti].pitched : played[ti].batted;
      const options = players.map((p, i) => ({ p, i }))
        .filter(({ p }) => (forPitcher ? p !== pitcher : !batting.has(p)))
        .map((o) => ({ ...o, out: out.has(o.p.name) }))
        .sort((a, b) => a.out - b.out); // fresh legs first
      const heading = !mine ? `Bench <span class="muted">(${players.length - batting.size})</span>`
        : forPitcher ? 'New pitcher: tap a player'
        : `Sub in at ${Number(mine.slot) + 1}: tap a player`;
      box.innerHTML = `<h3 class="sub">${heading}</h3>
        <div class="bench">
          ${options.map(({ p, i, out: o }) => `<button type="button" data-act="sub-in" data-team="${ti}" data-i="${i}"
            class="${o ? 'played' : ''}"><span>${rosterPlayerLabel(p)}</span>${o ? `<span class="note">${forPitcher ? 'pitched' : 'out'}</span>` : ''}${forPitcher && batting.has(p) && !o ? '<span class="note">batting</span>' : ''}</button>`).join('')
            || '<p class="muted small">Nobody left on the bench.</p>'}
        </div>`;
    }
  };
  dlg.querySelector('form').onsubmit = (e) => e.preventDefault();
  wireRosterInputs(dlg, rosterOf);
  dlg.addEventListener('change', drawBenches); // after the roster fix-ups above
  drawBenches();
}

function showLogDialog() {
  const active = activeEvents(current.events);
  const pitches = active.filter((e) => e.type === 'pitch').map((e) => e.row);
  // One entry per plate appearance: its pitches and, once it's over, its result.
  const byPa = new Map();
  const entry = (r) => {
    if (!byPa.has(r.pa_number)) byPa.set(r.pa_number, { head: r, rows: [], pa: null });
    return byPa.get(r.pa_number);
  };
  for (const e of active) {
    if (e.row) entry(e.row).rows.push(e.row);
    if (e.paRow) entry(e.paRow).pa = e.paRow;
  }
  const where = (r) => (r.session_type === 'bp' ? `P: ${esc(r.pitcher || '?')}`
    : r.half ? `${r.half === 'bottom' ? '▼' : '▲'}${r.inning} ${esc(r.batting_team)}` : `Inn ${r.inning}`);
  const items = [...byPa.entries()].reverse().map(([pa, { head, rows, pa: p }]) => {
    const end = rows.at(-1)?.pa_end;
    const tag = p ? `${p.result_label}${p.fielder ? ` (${esc(p.fielder)})` : ''}` : (end ? PA_END_LABELS[end] : '');
    return `<li><div class="log-head"><strong>PA ${pa}</strong> · ${where(head)} · ${head.batter_number ? `#${esc(head.batter_number)} ` : ''}${esc(head.batter)}
        ${tag ? `<span class="tag">${tag}</span>` : ''}</div>
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
    <p>${s.pending ? `<strong>${s.pending} change${s.pending > 1 ? 's' : ''} not uploaded yet.</strong> Back up if you have no signal.` : 'Everything is uploaded.'}</p>
    <div class="menu">
      <button data-act="backup" class="primary">Back up game (file)</button>
      <button data-act="csv">Export pitches (CSV)</button>
      <button data-act="pa-csv">Export plate appearances (CSV)</button>
      <button data-act="sync">Sync now</button>
      <button data-act="exit">Exit to games list</button>
      <button data-act="close">Close</button>
    </div>`, async (act, btn, dlg) => {
    if (act === 'backup') {
      const r = await backupJSON(current.game, current.events);
      if (r !== 'cancelled') toast('Backup created');
    } else if (act === 'csv') {
      await exportCSV(current.game, current.events);
    } else if (act === 'pa-csv') {
      await exportPaCSV(current.game, current.events);
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
        <label>Token <span class="muted">(hidden)</span><input name="token" class="secret" value="${esc(settings.token)}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        ${settings.url ? '<p class="small">Sheet code: <strong class="sheet-code inline" id="my-sheet-code">…</strong></p>' : ''}
        <label>Your name <span class="muted">(saved on each pitch as recorded_by)</span><input name="recorder" value="${esc(settings.recorder)}" autocapitalize="words" placeholder="optional"></label>
        <div class="row-buttons">
          <button type="button" data-act="test">Test connection</button>
          <button type="submit" class="primary">Save</button>
        </div>
      </form>
      <h2>Share with other recorders</h2>
      ${settings.url && settings.token ? `
        <p class="muted small">Anyone with this link or QR code can add pitches to this sheet. Share it only with people who
        record for you. To let people <em>view</em> the data, share the Google Sheet itself instead.</p>
        <p class="link-preview">${esc(appBaseUrl())}#c=•••••••• <span class="muted">(${buildSetupLink(appBaseUrl(), settings).length} characters)</span></p>
        <div class="row-buttons">
          <button data-act="share-link" class="primary">Share setup link</button>
          <button data-act="show-qr">Show QR code</button>
        </div>`
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
  if (settings.url) sheetCode(settings.url).then((c) => { const el = document.getElementById('my-sheet-code'); if (el) el.textContent = c; });
  const form = document.getElementById('settings');
  app.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'back') showHome();
    if (btn.dataset.act === 'test') {
      const url = form.url.value.trim();
      const token = form.token.value.trim();
      if (!isValidScriptUrl(url)) { toast('Enter the Apps Script web app address first', 'error'); return; }
      if (!token) { toast('Enter the token first', 'error'); return; }
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = 'Testing…';
      try { await testConnection(url, token); toast('Connection works ✓'); }
      catch (err) { toast(`Connection failed: ${esc(err.message)}`, 'error'); }
      finally { btn.disabled = false; btn.textContent = 'Test connection'; }
    }
    if (btn.dataset.act === 'share-link') shareSetupLink(buildSetupLink(appBaseUrl(), settingsCache));
    if (btn.dataset.act === 'show-qr') showQrDialog();
    if (btn.dataset.act === 'paste-link') pasteInto(document.getElementById('connect-input'));
    if (btn.dataset.act === 'connect') {
      if (await connectFromLink(document.getElementById('connect-input').value)) {
        if (await keepLinkInAddress()) location.reload(); else showSettings();
      }
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const url = form.url.value.trim();
    const token = form.token.value.trim();
    if (url && !isValidScriptUrl(url)) {
      toast('That isn\'t an Apps Script web app address (https://script.google.com/macros/s/…/exec)', 'error');
      return;
    }
    if (token && !/^[A-Za-z0-9_-]{8,200}$/.test(token)) {
      toast('The token should be the code from the script\'s execution log', 'error');
      return;
    }
    await updateSettings({ url, token, recorder: form.recorder.value.trim() });
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

// Asks before connecting to a sheet from a link or QR code. Resolves true to connect.
async function confirmConnect(c) {
  const code = await sheetCode(c.url);
  const replacing = settingsCache.url ? await sheetCode(settingsCache.url) : null;
  return new Promise((resolve) => {
    let answer = false;
    const dlg = openDialog(`
      <h2>Connect to this sheet?</h2>
      <p>Sheet code</p>
      <p class="sheet-code">${code}</p>
      <p class="small">Pitches recorded on this phone will be sent to this sheet. Only connect if you got the link or
        QR code from the sheet's owner, and check this code matches the one in their <em>Settings</em>.</p>
      ${replacing ? `<p class="small"><strong>This replaces the current connection</strong> (sheet ${replacing}).</p>` : ''}
      <div class="row-buttons">
        <button data-act="close">Cancel</button>
        <button data-act="yes" class="primary">Connect</button>
      </div>`, (act, btn, d) => {
      if (act === 'yes') { answer = true; d.close(); }
    });
    dlg.addEventListener('close', () => resolve(answer));
  });
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
  // Never connect silently: a link or QR code from someone else could point this
  // phone at their sheet. Show the sheet code so it can be compared with the owner's.
  if (!same && !(await confirmConnect(c))) {
    if (fromUrl) await updateSettings({ appliedLink: c.code }); // don't ask again at every launch
    toast('Not connected');
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
  const decoded = decodeConnect(link);
  if (!decoded || location.href === link) return false; // nothing valid to carry over
  await updateSettings({ appliedLink: decoded.code });
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
    toast('Could not share or copy the link on this device', 'error');
  }
}

// The setup link as a QR code, drawn on this phone (no outside service), shown only
// on request and only briefly: it closes after 60 s, when tapped closed, and as soon
// as the app leaves the screen (switching apps, locking the phone).
const QR_SECONDS = 60;

function qrSvg(text) {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const border = 4;
  const size = qr.size + border * 2;
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) d += `M${x + border},${y + border}h1v1h-1z`;
    }
  }
  return `<svg class="qr" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR code with the setup link"
    shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

async function showQrDialog() {
  if (!settingsCache.url || !settingsCache.token) return;
  const code = await sheetCode(settingsCache.url);
  let left = QR_SECONDS;
  const dlg = openDialog(`
    <h2>Scan to connect</h2>
    <div class="qr-box">${qrSvg(buildSetupLink(appBaseUrl(), settingsCache))}</div>
    <p class="center">Sheet code <strong class="sheet-code inline">${code}</strong> · closes in <span id="qr-left">${left}</span> s</p>
    <ul class="small qr-rules">
      <li>Lets a phone <strong>add pitches to your sheet</strong>: show it only to your recorders.</li>
      <li>Scan with the phone's own <strong>Camera</strong> app, not a scanner app.</li>
      <li>Don't screenshot or post it. The other phone must show the same sheet code.</li>
    </ul>
    <div class="row-buttons"><button data-act="close" class="primary">Close</button></div>`);
  dlg.scrollTop = 0; // the browser focuses Close on open, which can scroll the code out of view
  // Wipe the code from the page first, then close: removal is instant, not after the
  // dialog's (asynchronous) close event.
  const shut = () => { dlg.querySelector('.qr-box')?.replaceChildren(); if (dlg.open) dlg.close(); };
  const timer = setInterval(() => {
    left -= 1;
    const el = dlg.querySelector('#qr-left');
    if (el) el.textContent = left;
    if (left <= 0) shut();
  }, 1000);
  const hide = () => { if (document.visibilityState === 'hidden') shut(); };
  document.addEventListener('visibilitychange', hide);
  window.addEventListener('pagehide', shut);
  dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-act="close"]')) shut(); }, true);
  dlg.addEventListener('close', () => {
    shut();
    clearInterval(timer);
    document.removeEventListener('visibilitychange', hide);
    window.removeEventListener('pagehide', shut);
  });
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
  if (isSetupLinkHash(location.hash)) await connectFromLink(location.hash, { fromUrl: true });
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
