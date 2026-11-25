// Team dashboard: a read-only view of the sheet, for the whole team.
//
// It opens from a dashboard link (made in the app: Settings → Team dashboard), which carries the
// sheet script's address and its read-only viewer key in the #fragment. Browsers never send the
// fragment to GitHub Pages; the page keeps the two on this device and takes them out of the
// address bar. Every visit reads the sheet fresh: no data is kept on the device.

import { decodeViewerLink, isSetupLinkHash, isValidScriptUrl, isViewerLinkHash, sheetCode } from '../js/connect.js';
import { PITCH_TYPES } from '../js/game.js';
import {
  buildModel, outcomeCounts, arsenal, players, filterSession, OUTCOME_LABELS, NO_TEAM,
} from './model.js';
import { gamePlayers, gameTeams, OUTCOMES, RUNNING } from './winprob.js';
import { BOARDS, leaderboards } from './leaders.js';

const STORE = 'pt-dashboard';
const PREFS = 'pt-dashboard-prefs';
const TIMEOUT_MS = 60000;
const STALE_MS = 5 * 60 * 1000; // read again when the page comes back after this long

const root = document.getElementById('root');

let conn = null; // { url, key }
let model = null;
let loadedAt = 0;
let loading = false;
const ui = {
  tab: 'games', session: 'game', game: null, hitter: null, pitcher: null, hitTeam: null, pitTeam: null, lbTeam: null, follow: true,
  ...readPrefs(),
};
let pendingSeek = null; // { game, sec } from a "Watch" button on another tab
let player = null; // YouTube player of the open game
let followTimer = null;

// ---------- small helpers ----------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function writeJson(key, value) {
  try {
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* private mode: works for this visit only */ }
}
function readPrefs() {
  const p = readJson(PREFS) || {};
  const out = {};
  if (['games', 'hitters', 'pitchers', 'leaders'].includes(p.tab)) out.tab = p.tab;
  if (['game', 'bp', 'all'].includes(p.session)) out.session = p.session;
  if (typeof p.follow === 'boolean') out.follow = p.follow;
  for (const k of ['hitTeam', 'pitTeam', 'lbTeam']) if (typeof p[k] === 'string') out[k] = p[k];
  return out;
}
function savePrefs() {
  writeJson(PREFS, { tab: ui.tab, session: ui.session, follow: ui.follow, hitTeam: ui.hitTeam, pitTeam: ui.pitTeam, lbTeam: ui.lbTeam });
}

const pct = (v) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`);
const avg = (v) => (v === null || v === undefined ? '–' : v.toFixed(3).replace(/^0/, ''));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const int = (v) => (v === null || v === undefined ? '–' : String(v));
// Signed, with a real minus sign: +12.3, −4.0.
const sgn = (v, n = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '–'
  : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(n)}`);
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th');
const SVG = 'http://www.w3.org/2000/svg';
function s(tag, attrs) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

// The team in the most games is most likely "us" (opponents change from game to game).
function ourTeam(teams) {
  const inGames = (t) => model.games.filter((g) => g.teams.includes(t)).length;
  return teams.slice().sort((a, b) => inGames(b) - inGames(a))[0];
}

function fmtTime(sec) {
  const s = Math.floor(sec);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
}

function gameLabel(g) {
  const score = g.score ? ` · ${g.score.away}–${g.score.home}` : '';
  const bp = g.session === 'bp' ? ' · live BP' : '';
  return `${fmtDate(g.date) || 'No date'} · ${g.title}${bp}${score}${g.video ? ' · video' : ''}`;
}

const halfName = (p) => (p.half === 'top' ? `Top ${p.inning}` : p.half === 'bottom' ? `Bottom ${p.inning}` : p.inning ? `Inning ${p.inning}` : '');

const ago = (ms) => {
  const min = Math.round((Date.now() - ms) / 60000);
  return min < 1 ? 'just now' : min === 1 ? '1 min ago' : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
};

// ---------- connecting ----------

const validConn = (c) => !!c && isValidScriptUrl(c.url) && typeof c.key === 'string' && /^[A-Za-z0-9_-]{8,200}$/.test(c.key);

async function boot() {
  const stored = readJson(STORE);
  const saved = validConn(stored) ? { url: stored.url, key: stored.key } : null;
  if (isViewerLinkHash(location.hash)) {
    const fromLink = decodeViewerLink(location.hash);
    clearHash();
    if (!fromLink) {
      showMessage('This dashboard link is not valid', 'Ask whoever runs PitchTracker for the link again (in the app: Settings → Team dashboard).', true);
      return;
    }
    const same = saved && saved.url === fromLink.url && saved.key === fromLink.key;
    if (!same && !(await confirmSheet(fromLink, saved))) {
      if (saved) { conn = saved; load(); } else showMessage('Not opened', 'Open the dashboard link again when you want to see it.');
      return;
    }
    conn = fromLink;
    writeJson(STORE, conn);
  } else if (isSetupLinkHash(location.hash)) {
    // The app's setup link (it can add pitches) opened here by mistake: take it out of the
    // address bar and never use it.
    clearHash();
    showMessage("That's the app's setup link", 'It connects a phone that records pitches; it is not a dashboard link. Use the team dashboard link instead.', true);
    return;
  } else {
    conn = saved;
  }
  if (!conn) { showNoLink(); return; }
  load();
}

function clearHash() {
  history.replaceState(null, '', location.pathname + location.search);
}

// Like the app, never connect to a sheet from a link without showing which one: a link from
// someone else could show made-up data. The owner's app shows the same code in Settings.
async function confirmSheet(c, saved) {
  const code = await sheetCode(c.url);
  const old = saved ? await sheetCode(saved.url) : null;
  return new Promise((resolve) => {
    root.replaceChildren(h('main', { class: 'state card narrow' },
      h('h1', { text: 'Open the team dashboard?' }),
      h('p', { text: 'Sheet code' }),
      h('p', { class: 'sheet-code', text: code }),
      h('p', { class: 'muted small', text: 'A read-only view of the PitchTracker sheet. Open it if you got this link from your team; the code matches the one in the app (Settings → Sheet code).' }),
      old && old !== code ? h('p', { class: 'small', text: `This replaces the dashboard this device had open before (sheet ${old}).` }) : null,
      h('div', { class: 'buttons' },
        h('button', { onclick: () => resolve(false), text: 'Cancel' }),
        h('button', { class: 'primary', onclick: () => resolve(true), text: 'Open' }))));
  });
}

function showNoLink() {
  const input = h('input', { placeholder: 'Paste the dashboard link', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const go = async () => {
    const c = decodeViewerLink(input.value);
    if (!c) { input.setCustomValidity('Not a dashboard link'); input.reportValidity(); return; }
    if (!(await confirmSheet(c, null))) { showNoLink(); return; }
    conn = c;
    writeJson(STORE, conn);
    load();
  };
  input.addEventListener('input', () => input.setCustomValidity(''));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  root.replaceChildren(h('main', { class: 'state card narrow' },
    h('h1', { text: 'PitchTracker team dashboard' }),
    h('p', { text: 'Open the dashboard link you were sent, or paste it here.' }),
    h('p', { class: 'muted small', text: 'The link comes from whoever runs PitchTracker for your team (in the app: Settings → Team dashboard).' }),
    input,
    h('div', { class: 'buttons' }, h('button', { class: 'primary', onclick: go, text: 'Open' }))));
}

function showMessage(title, text, withPaste = false) {
  root.replaceChildren(h('main', { class: 'state card narrow' },
    h('h1', { text: title }), h('p', { text }),
    withPaste ? h('div', { class: 'buttons' }, h('button', { onclick: showNoLink, text: 'Paste a link' })) : null));
}

// ---------- reading the sheet ----------

async function fetchData() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // A text/plain "simple" request: Apps Script answers it without a CORS preflight.
    const res = await fetch(conn.url, { method: 'POST', body: JSON.stringify({ action: 'dashboard', key: conn.key }), signal: ctrl.signal });
    if (!res.ok) throw new Error(`The sheet answered HTTP ${res.status}`);
    let body;
    try { body = await res.json(); } catch { throw new Error('The sheet sent back a page instead of data. The script may need deploying again'); }
    if (!body.ok) {
      const err = new Error(body.error === 'No rows' || body.error === 'Wrong token'
        ? "The sheet's script is older than this dashboard: it needs the new Code.gs deployed" : body.error || 'The sheet refused');
      err.code = body.code;
      throw err;
    }
    return body;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The sheet took too long to answer. Try again');
    if (err instanceof TypeError) throw new Error(navigator.onLine === false ? 'No connection' : "Couldn't reach the sheet. Check your connection and try again");
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function load() {
  if (loading) return;
  loading = true;
  if (!model) root.replaceChildren(h('p', { class: 'state', text: 'Reading the sheet…' }));
  else document.getElementById('refresh')?.setAttribute('disabled', '');
  try {
    const data = await fetchData();
    model = buildModel(data);
    loadedAt = Date.now();
    render();
  } catch (err) {
    if (err.code === 'bad_key') {
      writeJson(STORE, null);
      conn = null;
      model = null;
      destroyPlayer();
      showMessage('This dashboard link no longer works', 'It has been replaced by a new one. Ask whoever runs PitchTracker for the new link.', true);
    } else if (!model) {
      root.replaceChildren(h('main', { class: 'state card narrow' },
        h('h1', { text: "Couldn't read the sheet" }), h('p', { text: err.message }),
        h('div', { class: 'buttons' }, h('button', { class: 'primary', onclick: () => load(), text: 'Try again' }))));
    } else {
      setStatus(`Not updated: ${err.message}`, true);
    }
  } finally {
    loading = false;
    document.getElementById('refresh')?.removeAttribute('disabled');
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && conn && model && Date.now() - loadedAt > STALE_MS) load();
});

function setStatus(text, err = false) {
  const el = document.getElementById('status');
  if (el) { el.textContent = text; el.classList.toggle('err', err); }
}

// ---------- layout ----------

function render() {
  destroyPlayer();
  const tabs = [['games', 'Games'], ['hitters', 'Hitters'], ['pitchers', 'Pitchers'], ['leaders', 'Leaders']];
  const session = h('select', { 'aria-label': 'Sessions', onchange: (e) => { ui.session = e.target.value; ui.game = null; savePrefs(); render(); } },
    ...[['game', 'Games'], ['bp', 'Live BP'], ['all', 'Games and live BP']].map(([v, t]) => h('option', { value: v, selected: ui.session === v, text: t })));
  const header = h('header', { class: 'bar' },
    h('div', { class: 'brand' }, h('img', { src: '../icons/icon.svg', alt: '', width: 28, height: 28 }), h('span', { text: 'PitchTracker' })),
    h('nav', { class: 'tabs', role: 'tablist' }, ...tabs.map(([id, label]) => h('button', {
      role: 'tab', 'aria-selected': String(ui.tab === id), class: ui.tab === id ? 'on' : '',
      onclick: () => { ui.tab = id; savePrefs(); render(); window.scrollTo(0, 0); }, text: label,
    }))),
    h('div', { class: 'tools' }, session,
      h('button', { id: 'refresh', class: 'icon', title: 'Read the sheet again', 'aria-label': 'Refresh', onclick: () => load(), text: '↻' })));
  const main = h('main', { class: 'page' });
  const plays = filterSession(model.plays, ui.session);
  if (ui.tab === 'games') renderGames(main);
  else if (ui.tab === 'hitters') renderPeople(main, plays, 'batter');
  else if (ui.tab === 'pitchers') renderPeople(main, plays, 'pitcher');
  else renderLeaders(main, plays);
  const footer = h('footer', { class: 'foot' },
    h('span', { id: 'status', text: `Read from the sheet ${ago(loadedAt)}` }),
    h('span', { id: 'sheet', class: 'muted' }));
  root.replaceChildren(header, main, footer);
  sheetCode(conn.url).then((c) => { const el = document.getElementById('sheet'); if (el) el.textContent = `Sheet ${c}`; });
  if (ui.tab === 'games') { drawWpChart(); startPlayer(); }
}

let resizeFrame = 0;
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastWidth) return; // phones fire resize when the toolbar hides
  lastWidth = window.innerWidth;
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => { if (model && ui.tab === 'games') drawWpChart(); });
});

setInterval(() => { if (model && !loading && !document.getElementById('status')?.classList.contains('err')) setStatus(`Read from the sheet ${ago(loadedAt)}`); }, 30000);

function empty(text) {
  return h('p', { class: 'empty', text });
}

// ---------- games ----------

function renderGames(main) {
  const games = model.games.filter((g) => ui.session === 'all' || g.session === ui.session);
  if (!games.length) { main.append(empty(ui.session === 'bp' ? 'No live BP sessions in the sheet yet.' : 'No games in the sheet yet.')); return; }
  if (!games.some((g) => g.id === ui.game)) ui.game = (games.find((g) => g.video) || games[0]).id;
  const game = games.find((g) => g.id === ui.game);

  const pick = h('select', { class: 'grow', 'aria-label': 'Game', onchange: (e) => { ui.game = e.target.value; render(); } },
    ...games.map((g) => h('option', { value: g.id, selected: g.id === ui.game, text: gameLabel(g) })));
  main.append(h('div', { class: 'controls' }, pick));

  const head = h('section', { class: 'game-head' },
    h('h1', { text: game.title }),
    h('p', { class: 'muted' }, [fmtDate(game.date), game.session === 'bp' ? 'Live BP' : null,
      game.source === 'pbp' ? 'from the scoresheet' : 'recorded in the app'].filter(Boolean).join(' · ')),
    game.score && game.away && game.home ? h('p', { class: 'score' },
      h('span', { text: game.away }), h('strong', { text: ` ${game.score.away} – ${game.score.home} ` }), h('span', { text: game.home })) : null);

  const video = game.video ? h('div', { class: 'video-wrap' },
    h('div', { class: 'video' }, h('div', { id: 'player' }), h('div', { id: 'video-msg', class: 'video-msg', text: 'Loading the video…' })),
    h('label', { class: 'follow' },
      h('input', { type: 'checkbox', checked: ui.follow, onchange: (e) => { ui.follow = e.target.checked; savePrefs(); } }),
      ` Follow the video (${game.timed} of ${game.plays.length} plays have a time)`))
    : h('p', { class: 'muted small no-video', text: 'No video for this game.' });

  const list = h('div', { class: 'plays', id: 'plays' });
  let last = null;
  game.plays.forEach((p, i) => {
    const group = halfName(p) + (p.team !== NO_TEAM ? ` · ${p.team} batting` : '');
    if (group !== last) {
      const score = p.awayBefore !== null && p.homeBefore !== null ? `${p.awayBefore}–${p.homeBefore}` : '';
      list.append(h('div', { class: 'half' }, h('span', { text: group || 'Plate appearances' }), score ? h('span', { class: 'muted', text: score }) : null));
      last = group;
    }
    list.append(playRow(p, i));
  });

  const valued = game.plays.some((p) => p.wp);
  main.append(h('div', { class: 'game-grid' }, head, video, valued ? wpSection(game) : null,
    h('section', { class: 'game-right' }, h('h2', { text: 'Every play' }), pitchKey(), list), boxScore(game)));
  if (valued) main.append(bigPlays(game), whoMoved(game), modelDetails());
}

// ---------- win probability ----------

// Whose chances the chart and sentence follow: our team if it played, else the home team.
function wpSide(game) {
  const us = ourTeam(model.games.flatMap((g) => g.teams));
  return us && us === game.away && us !== game.home ? 'away' : 'home';
}

function wpSection(game) {
  const plays = game.plays.filter((p) => p.wp);
  const lede = h('p', { class: 'lede' });
  if (game.score) {
    const { away, home } = game.score;
    if (away === home) lede.append(`It ended level at ${home}. `);
    else lede.append(`${home > away ? game.home : game.away} won ${Math.max(home, away)}–${Math.min(home, away)}. `);
  }
  const big = plays.slice().sort((a, b) => Math.abs(b.wp.wpa) - Math.abs(a.wp.wpa))[0];
  if (big) {
    lede.append(`The biggest swing was ${big.batter || 'a play'} in the ${big.half === 'top' ? 'top' : 'bottom'} of the ${ordinal(big.inning)}: `,
      big.video !== null ? h('button', { class: 'link', onclick: () => seek(big.video, true), text: big.desc }) : big.desc,
      `, worth ${sgn(big.wp.wpa)} points to ${big.team}`);
    const err = big.wp.wpa - big.wp.wpaClean;
    if (big.wp.errorFielder && Math.abs(err) >= 0.05) {
      lede.append(`. Made cleanly, it would have been worth ${sgn(big.wp.wpaClean)}, so the error by ${big.wp.errorFielder} alone was worth ${sgn(err)} to them.`);
    } else lede.append('.');
  }
  const team = wpSide(game) === 'home' ? game.home : game.away;
  return h('section', { class: 'wp' },
    h('h2', { text: `Win probability${team ? `: ${team}` : ''}` }),
    lede,
    h('div', { class: 'chart', id: 'wp-chart' }),
    h('p', { class: 'muted small', text: 'The chance of winning before and after every play, from the run model below. Point at the line to see the play; tap it to jump the video there.' }));
}

function drawWpChart() {
  const el = document.getElementById('wp-chart');
  const game = model.games.find((g) => g.id === ui.game);
  if (!el || !game) return;
  const plays = game.plays.filter((p) => p.wp);
  const home = wpSide(game) === 'home';
  const team = home ? game.home : game.away;
  const val = (w) => 100 * (home ? w : 1 - w);
  const pts = [{ i: 0, v: val(plays[0].wp.homeWeBefore), p: null }, ...plays.map((p, i) => ({ i: i + 1, v: val(p.wp.homeWeAfter), p }))];
  const W = Math.max(280, el.clientWidth);
  const H = 220;
  const m = { t: 14, r: 12, b: 24, l: 40 };
  const x = (i) => m.l + (i / plays.length) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - v / 100) * (H - m.t - m.b);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img',
    'aria-label': `Chance that ${team} win, after each of the ${plays.length} plays` });
  // Inning starts
  const starts = [];
  plays.forEach((p, i) => { if (p.half === 'top' && (i === 0 || plays[i - 1].inning !== p.inning)) starts.push({ i, inning: p.inning }); });
  starts.forEach((st, k) => {
    svg.append(s('line', { x1: x(st.i), x2: x(st.i), y1: m.t, y2: H - m.b, class: 'grid' }));
    if (W >= 420 || k % 2 === 0) { const t = s('text', { x: x(st.i) + 3, y: H - 7, class: 'axis' }); t.textContent = `Inn ${st.inning}`; svg.append(t); }
  });
  for (const v of [0, 25, 50, 75, 100]) {
    const t = s('text', { x: m.l - 6, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' });
    t.textContent = `${v}%`;
    svg.append(t);
  }
  svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y(50), y2: y(50), class: 'ref' }));
  svg.append(s('path', { d: pts.map((q, k) => `${k ? 'L' : 'M'}${x(q.i).toFixed(1)},${y(q.v).toFixed(1)}`).join(''), class: 'line' }));
  const lastPt = pts[pts.length - 1];
  const end = s('text', { x: W - m.r - 8, y: lastPt.v > 50 ? y(lastPt.v) + 18 : y(lastPt.v) - 10, 'text-anchor': 'end', class: 'end' });
  end.textContent = `${team} ${Math.round(lastPt.v)}%`;
  svg.append(end);
  const dot = s('circle', { r: 4, class: 'dot', visibility: 'hidden' });
  svg.append(dot);
  const hit = s('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' });
  svg.append(hit);
  const tip = h('div', { class: 'tip', hidden: true });
  const at = (ev) => {
    const r = svg.getBoundingClientRect();
    const mx = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(1, Math.min(plays.length, Math.round(((mx - m.l) / (W - m.l - m.r)) * plays.length)));
    return { q: pts[i], scale: r.width / W };
  };
  const show = (ev) => {
    const { q, scale } = at(ev);
    const p = q.p;
    dot.setAttribute('cx', x(q.i));
    dot.setAttribute('cy', y(q.v));
    dot.setAttribute('visibility', 'visible');
    tip.replaceChildren(...[
      h('div', { class: 'tip-h', text: `${halfName(p)} · ${p.batter || ''}` }),
      h('div', { text: p.desc }),
      p.pitches.length ? h('div', {}, pitchTiles(p.pitches)) : null,
      h('div', { class: 'muted', text: `${team} ${Math.round(q.v)}% · WPA ${sgn(p.wp.wpa)} for ${p.team} · leverage ${(p.wp.li ?? 0).toFixed(1)}` }),
      p.video !== null ? h('div', { class: 'tip-v', text: `▶ Tap to play from ${fmtTime(p.video)}` }) : null,
    ].filter(Boolean));
    tip.hidden = false;
    const left = Math.min(x(q.i) * scale + 12, el.clientWidth - 250);
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${Math.max(0, y(q.v) * scale - 90)}px`;
  };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', () => { tip.hidden = true; dot.setAttribute('visibility', 'hidden'); });
  hit.addEventListener('click', (ev) => { const { q } = at(ev); if (q.p.video !== null) seek(q.p.video, true); });
  if (plays.some((p) => p.video !== null)) hit.style.cursor = 'pointer';
  el.replaceChildren(svg, tip);
}

function wpaCell(v) {
  return h('td', { class: v > 0.05 ? 'pos' : v < -0.05 ? 'neg' : '', text: sgn(v) });
}

function bigPlays(game) {
  const rows = game.plays.filter((p) => p.wp).sort((a, b) => Math.abs(b.wp.wpa) - Math.abs(a.wp.wpa)).slice(0, 8);
  return h('section', { id: 'big-plays' }, h('h2', { text: 'Biggest plays' }),
    h('p', { class: 'muted small', text: 'The eight plays that moved the chance of winning the most. WPA is win probability added for the batting team, in percentage points. Leverage 1 is an average plate appearance; 2 is twice as tense.' }),
    h('div', { class: 'scroll' }, h('table', { class: 'stats' },
      h('thead', {}, h('tr', {}, ...['Play', 'Inning', 'Batter', 'Score before', 'Pitches', 'Leverage', 'WPA', 'Error by'].map((t) => h('th', { text: t })))),
      h('tbody', {}, ...rows.map((p) => h('tr', {},
        h('th', { class: 'wrap' }, p.video !== null ? h('button', { class: 'link', title: `Play from ${fmtTime(p.video)}`, onclick: () => seek(p.video, true), text: `▶ ${p.desc}` }) : p.desc),
        h('td', { text: halfName(p) }), h('td', { class: 'left', text: p.batter }),
        h('td', { text: p.awayBefore !== null ? `${p.awayBefore}–${p.homeBefore}` : '' }),
        h('td', {}, pitchTiles(p.pitches)), h('td', { text: (p.wp.li ?? 0).toFixed(1) }), wpaCell(p.wp.wpa),
        h('td', { class: 'left', text: p.wp.errorFielder })))))));
}

function whoMoved(game) {
  const ps = gamePlayers(game.plays);
  const teams = gameTeams(game.plays);
  const opt = (v, n = 1) => (v === null ? '' : sgn(v, n));
  return h('section', { id: 'game-players' }, h('h2', { text: 'Who moved the game' }),
    h('p', { class: 'muted small', text: 'Win probability added in percentage points, signed so that good for the player is positive, with the net in runs (RE24) too. A plate appearance is shared by hitter and pitcher as if any error had not happened, and a dropped third strike counts as a strikeout. The error, passed ball or wild pitch is charged to whoever made it. Steals, caught stealing and pickoffs go to the runner, and on defense half to the pitcher and half to the catcher (or the fielder who made the pickoff).' }),
    h('div', { class: 'scroll' }, h('table', { class: 'stats' },
      h('thead', {}, h('tr', {}, ...['Player', 'Team', 'Roles', 'PA', 'Avg leverage', 'Hitting', 'Running', 'Pitching', 'Fielding', 'Errors', 'Net WPA', 'Net runs'].map((t) => h('th', { text: t })))),
      h('tbody', {}, ...ps.map((r) => h('tr', {},
        h('th', { text: r.who }), h('td', { class: 'left', text: r.team }), h('td', { class: 'left', text: r.roles }),
        h('td', { text: r.pa ?? '' }), h('td', { text: r.avgLi === null ? '' : r.avgLi.toFixed(1) }),
        h('td', { text: opt(r.hit) }), h('td', { text: opt(r.run) }), h('td', { text: opt(r.pit) }), h('td', { text: opt(r.fld) }),
        h('td', { text: r.e ?? '' }), wpaCell(r.wpa), h('td', { text: sgn(r.re24, 2) })))))),
    h('h3', { id: 'team-totals', text: 'Team totals' }),
    h('p', { class: 'muted small', text: "Every play's value, in percentage points of win probability, split by who it went to. Batting adds up to hitters, runners and what the other team gave away; fielding to pitchers and fielders, and equals the other team's batting with the sign flipped." }),
    h('div', { class: 'scroll' }, h('table', { class: 'stats' },
      h('thead', {}, h('tr', {}, ...['Team', 'Hitters', 'Runners', 'Given away', 'Batting', 'Batting, runs', 'Pitchers', 'Fielders', 'Fielding', 'Fielding, runs'].map((t) => h('th', { text: t })))),
      h('tbody', {}, ...teams.map((r) => h('tr', {},
        h('th', { text: r.team }), ...[r.hit, r.run, r.given, r.bat].map((v) => h('td', { text: sgn(v) })), h('td', { text: sgn(r.batRuns, 2) }),
        ...[r.pit, r.fielders, r.fld].map((v) => h('td', { text: sgn(v) })), h('td', { text: sgn(r.fldRuns, 2) })))))));
}

function modelDetails() {
  const { rates, re } = model.runModel;
  const short = { out: 'Out', walk: 'BB/HBP', single: '1B', double: '2B', triple: '3B', hr: 'HR', dp: 'DP', adv: 'WP/PB/BK', steal: 'SB', caught: 'CS/PO' };
  const p1 = (v) => (v === null ? '–' : `${(100 * v).toFixed(1)}%`);
  const d2 = (v) => (v === null ? '–' : v.toFixed(2));
  return h('details', { class: 'model', id: 'run-model' }, h('summary', { text: 'How the win probability is worked out' }),
    h('p', { class: 'small', text: 'The model plays out a half-inning one event at a time: a plate appearance, or with runners on, a wild pitch, passed ball or balk (every runner moves up), a steal, or a runner caught stealing or picked off. On a single a runner from 2nd scores and one from 1st stops at 2nd; on a double a runner from 1st stops at 3rd. Some outs with a runner on 1st and fewer than two outs are double plays. Games are 7 innings, with the run rule (20 after 3, 15 after 4, 10 after 5 and 6) and extra innings starting with runners on 1st and 2nd. The rates come from this league\'s games, blended with typical rates worth 50 plate appearances (or 50 chances) so a small sample doesn\'t swing the model.' }),
    h('h3', { text: 'Run expectancy' }),
    h('p', { class: 'muted small', text: 'Runs expected from each base and out state to the end of the half-inning. Observed is what actually followed in the play-by-play, which stays noisy until many more games are in.' }),
    h('div', { class: 'scroll' }, h('table', { class: 'stats' },
      h('thead', {}, h('tr', {}, ...['Bases', '0 outs', '1 out', '2 outs', 'Observed, 0 outs', 'Times', 'Observed, 1 out', 'Times', 'Observed, 2 outs', 'Times'].map((t) => h('th', { text: t })))),
      h('tbody', {}, ...re.map((r) => h('tr', {}, h('th', { class: 'mono', text: r.bases }), ...r.re.map((v) => h('td', { text: d2(v) })),
        ...[0, 1, 2].flatMap((o) => [h('td', { class: r.n[o] < 5 ? 'faint' : '', text: d2(r.obs[o]) }), h('td', { class: r.n[o] < 5 ? 'faint' : '', text: String(r.n[o]) })])))))),
    h('h3', { text: 'Outcome and base-running rates' }),
    h('div', { class: 'scroll' }, h('table', { class: 'stats' },
      h('thead', {}, h('tr', {}, ...['Outcome', 'Times', 'Out of', 'Counted over', 'Observed', 'Typical', 'Used by the model'].map((t) => h('th', { text: t })))),
      h('tbody', {}, ...rates.map((r) => h('tr', {}, h('th', { title: r.label, text: short[r.outcome] || r.outcome }),
        h('td', { text: String(r.count) }), h('td', { text: String(r.chances) }), h('td', { class: 'left', text: r.per }),
        h('td', { text: p1(r.observed) }), h('td', { text: p1(r.prior) }), h('td', { text: p1(r.rate) })))))),
    h('p', { class: 'muted small', text: `Outcomes: ${OUTCOMES.map((o) => `${short[o.outcome]} = ${o.label}`).join('; ')}; ${RUNNING.map((o) => `${short[o.outcome]} = ${o.label}`).join('; ')}.` }));
}

// ---------- leaderboards ----------

function renderLeaders(main, plays) {
  const teams = [...new Set(plays.flatMap((p) => [p.team, p.opp]))].filter((t) => t !== NO_TEAM);
  if (!plays.length || !teams.length) { main.append(empty('Nothing to rank in this selection yet.')); return; }
  if (!teams.includes(ui.lbTeam)) ui.lbTeam = ourTeam(teams);
  main.append(h('div', { class: 'controls' },
    h('select', { 'aria-label': 'Team', onchange: (e) => { ui.lbTeam = e.target.value; savePrefs(); render(); } },
      ...teams.map((t) => h('option', { value: t, selected: t === ui.lbTeam, text: t })))),
  h('p', { class: 'muted small', text: "Top 5 on each board. Streaks carry over from one game to the next in date order (GAME 1 before GAME 2 on the same day); active means it's still going. Ties share a rank." }));
  for (const [side, title, role] of [['hit', 'Hitters', 'batter'], ['pit', 'Pitchers', 'pitcher']]) {
    const boards = leaderboards(plays, model.games, side, ui.lbTeam);
    main.append(h('h2', { class: 'lb-side', text: `${ui.lbTeam} ${title.toLowerCase()}` }));
    for (const good of [true, false]) {
      main.append(h('h3', { class: `lb-h ${good ? 'good' : 'bad'}`, text: good ? 'The good' : 'The bad' }),
        h('div', { class: 'lb-grid' }, ...BOARDS[side].filter((b) => b.good === good).map((b) => board(b, boards[b.id] || [], role))));
    }
  }
}

function board(b, rows, role) {
  const fmt = (v) => (b.fmt === 'pct' ? `${v}%` : b.fmt === 'dec' ? Number(v).toFixed(1) : String(v));
  return h('section', { class: 'lb', id: `lb-${b.id}` }, h('h4', { text: b.title }), b.note ? h('p', { class: 'muted small', text: b.note }) : null,
    h('table', { class: 'lb-t' },
      h('thead', {}, h('tr', {}, h('th', { text: '#' }), h('th', { text: 'Name' }), h('th', { text: b.unit }))),
      h('tbody', {}, ...(rows.length ? rows.map((r) => h('tr', { class: r.rank === 1 ? 'first' : '' },
        h('td', { class: 'rank', text: String(r.rank) }),
        h('td', {}, h('button', { class: 'link', onclick: () => openPerson(role, { key: `${ui.lbTeam}\u0000${r.who}`, team: ui.lbTeam, name: r.who }), text: r.who }),
          r.active ? h('span', { class: 'active', title: 'Still going: their latest chance kept it alive', text: 'active' }) : null,
          r.detail ? h('small', { text: r.detail }) : null),
        h('td', { class: 'val', text: fmt(r.value) })))
        : [h('tr', {}, h('td', { colspan: 3, class: 'muted', text: 'Nobody yet' }))]))));
}

function playRow(p, i) {
  const timed = p.video !== null && ui.tab === 'games';
  const row = h(timed ? 'button' : 'div', {
    class: `play${p.isPa ? '' : ' between'}${timed ? ' timed' : ''}`,
    'data-i': i,
    'data-sec': timed ? p.video : null,
    title: timed ? `Play from ${fmtTime(p.video)}` : null,
    onclick: timed ? () => seek(p.video, true) : null,
  },
  h('span', { class: 't', text: timed ? `▶ ${fmtTime(p.video)}` : '' }),
  h('span', { class: 'who' },
    h('strong', { text: p.isPa ? p.batter || 'Batter' : p.desc || p.code }),
    p.isPa ? h('span', { class: 'desc', text: p.desc }) : null,
    p.pitcher && p.isPa ? h('span', { class: 'muted small', text: `vs ${p.pitcher}` }) : null,
    p.wp ? h('span', { class: 'muted small' }, 'WPA ', h('span', { class: p.wp.wpa > 0.05 ? 'pos' : p.wp.wpa < -0.05 ? 'neg' : '', text: sgn(p.wp.wpa) }),
      ` for ${p.team} · leverage ${(p.wp.li ?? 0).toFixed(1)}`) : null),
  pitchTiles(p.pitches));
  return row;
}

const LETTER = { ball: 'B', called_strike: 'C', swinging_strike: 'S', foul: 'F', in_play: 'X' };
const RESULT_NAME = { ball: 'ball', called_strike: 'called strike', swinging_strike: 'swing and miss', foul: 'foul', in_play: 'in play' };

function pitchTiles(pitches) {
  if (!pitches.length) return h('span', { class: 'tiles' });
  return h('span', { class: 'tiles', 'aria-label': `${pitches.length} pitches` },
    ...pitches.map((p) => h('span', {
      class: `tile t-${p.type || 'x'}${p.result === 'ball' ? ' ball' : ''}${p.zone === 'OUT' && ['SWING', 'FOUL', 'IN_PLAY'].includes(p.action) ? ' chase' : ''}`,
      title: [PITCH_TYPES[p.type] || p.type, p.zone === 'IN' ? 'in the zone' : p.zone === 'OUT' ? 'out of the zone' : '', RESULT_NAME[p.result]]
        .filter(Boolean).join(', ') + (p.balls !== null ? ` (${p.balls}-${p.strikes})` : ''),
      text: LETTER[p.result] || '·',
    })));
}

function pitchKey() {
  const k = (cls, letter, label) => h('span', { class: 'key-i' }, h('span', { class: `tile ${cls}`, text: letter }), label);
  return h('div', { class: 'key', 'aria-hidden': 'true' },
    k('t-x ball', 'B', 'ball'), k('t-x', 'C', 'called'), k('t-x', 'S', 'swing & miss'), k('t-x', 'F', 'foul'), k('t-x', 'X', 'in play'),
    k('t-FB', '', 'fastball'), k('t-CB', '', 'curveball'), k('t-x chase', '', 'chase'));
}

function boxScore(game) {
  const teams = [...new Set(game.plays.map((p) => p.team))];
  return h('section', { class: 'box' }, h('h2', { text: 'Box score' }),
    ...teams.map((t) => {
      const ps = players(game.plays.filter((p) => p.team === t), 'batter');
      if (!ps.length) return null;
      return h('div', { class: 'scroll' }, h('table', { class: 'stats' },
        h('caption', { text: t }),
        h('thead', {}, h('tr', {}, ...['Batter', 'PA', 'AB', 'H', 'BB', 'K', 'RBI'].map((x) => h('th', { text: x })))),
        h('tbody', {}, ...ps.map((p) => h('tr', {},
          h('th', {}, h('button', { class: 'link', onclick: () => openPerson('batter', p), text: p.name })),
          ...[p.line.pa, p.line.ab, p.line.h, p.line.bb, p.line.k, game.source === 'pbp' ? p.line.rbi : '–'].map((v) => h('td', { text: int(v) })))))));
    }));
}

// ---------- the video ----------

let apiState = 'idle'; // idle → loading → ready | failed
const apiWaiters = [];

function youtubeApi() {
  if (apiState === 'ready') return Promise.resolve();
  if (apiState === 'failed') return Promise.reject(new Error('api'));
  return new Promise((resolve, reject) => {
    apiWaiters.push({ resolve, reject });
    if (apiState === 'loading') return;
    apiState = 'loading';
    window.onYouTubeIframeAPIReady = () => { apiState = 'ready'; apiWaiters.splice(0).forEach((w) => w.resolve()); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiState = 'failed'; apiWaiters.splice(0).forEach((w) => w.reject(new Error('api'))); };
    document.head.append(s);
  });
}

function videoId(link) {
  const m = /[?&]v=([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/.exec(link || '');
  return m ? m[1] : null;
}

function videoMsg(text, link) {
  const el = document.getElementById('video-msg');
  if (!el) return;
  el.replaceChildren();
  el.hidden = !text;
  if (!text) return;
  el.append(text);
  if (link) el.append(' ', h('a', { href: link, target: '_blank', rel: 'noopener', text: 'Open it on YouTube' }));
}

function startPlayer() {
  const game = model.games.find((g) => g.id === ui.game);
  const id = videoId(game?.video);
  if (!id || !document.getElementById('player')) return;
  const seekTo = pendingSeek && pendingSeek.game === game.id ? pendingSeek.sec : null;
  pendingSeek = null;
  youtubeApi().then(() => {
    if (!document.getElementById('player') || ui.game !== game.id) return;
    const p = new window.YT.Player('player', {
      host: 'https://www.youtube-nocookie.com',
      videoId: id,
      playerVars: { rel: 0, playsinline: 1, ...(seekTo !== null ? { start: Math.floor(seekTo) } : {}) },
      events: {
        onReady: () => {
          videoMsg('');
          if (seekTo !== null) { p.seekTo(seekTo, true); p.playVideo(); }
          highlight(seekTo ?? 0, seekTo !== null);
        },
        onError: (e) => {
          videoMsg(e.data === 101 || e.data === 150 || e.data === 153
            ? "This video's owner doesn't let it play outside YouTube."
            : "YouTube couldn't play this video.", game.video);
        },
      },
    });
    player = p;
    followTimer = setInterval(() => {
      if (!ui.follow || !player?.getPlayerState || player.getPlayerState() !== 1) return;
      highlight(player.getCurrentTime(), true);
    }, 700);
  }, () => videoMsg("YouTube's player couldn't load here.", game.video));
}

function destroyPlayer() {
  clearInterval(followTimer);
  followTimer = null;
  try { player?.destroy?.(); } catch { /* already gone */ }
  player = null;
}

function seek(sec, play) {
  if (!player?.seekTo) return;
  player.seekTo(sec, true);
  if (play) player.playVideo();
  highlight(sec, false);
  document.querySelector('.video-wrap')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Marks the last play that starts at or before `sec`; scrolls the list to it when following.
function highlight(sec, scroll) {
  const rows = [...document.querySelectorAll('#plays .play[data-sec]')];
  let cur = null;
  for (const r of rows) if (Number(r.dataset.sec) <= sec + 0.5) cur = r;
  for (const r of document.querySelectorAll('#plays .play.cur')) if (r !== cur) r.classList.remove('cur');
  if (!cur || cur.classList.contains('cur')) return;
  cur.classList.add('cur');
  if (scroll) {
    const list = document.getElementById('plays');
    const top = cur.offsetTop - list.offsetTop;
    if (list.scrollHeight > list.clientHeight + 4) list.scrollTo({ top: top - list.clientHeight / 3, behavior: 'smooth' });
  }
}

function watch(p) {
  ui.tab = 'games';
  ui.game = p.game;
  pendingSeek = { game: p.game, sec: p.video };
  if (ui.session !== 'all' && p.session !== ui.session) ui.session = 'all';
  savePrefs();
  render();
  window.scrollTo(0, 0);
}

// ---------- hitters and pitchers ----------

function openPerson(role, person) {
  ui.tab = role === 'batter' ? 'hitters' : 'pitchers';
  if (role === 'batter') { ui.hitter = person.key; ui.hitTeam = person.team; } else { ui.pitcher = person.key; ui.pitTeam = person.team; }
  savePrefs();
  render();
  window.scrollTo(0, 0);
}

function renderPeople(main, plays, role) {
  const batter = role === 'batter';
  const all = players(plays, role);
  if (!all.length) { main.append(empty(batter ? 'No hitters in this selection yet.' : 'No pitchers in this selection yet.')); return; }
  const teams = [...new Set(all.map((p) => p.team))];
  const teamKey = batter ? 'hitTeam' : 'pitTeam';
  const personKey = batter ? 'hitter' : 'pitcher';
  if (!teams.includes(ui[teamKey])) ui[teamKey] = ourTeam(teams);
  const roster = all.filter((p) => p.team === ui[teamKey]);
  if (!roster.some((p) => p.key === ui[personKey])) ui[personKey] = roster[0].key;
  const person = roster.find((p) => p.key === ui[personKey]);

  main.append(h('div', { class: 'controls' },
    h('select', { 'aria-label': 'Team', onchange: (e) => { ui[teamKey] = e.target.value; ui[personKey] = null; savePrefs(); render(); } },
      ...teams.map((t) => h('option', { value: t, selected: t === ui[teamKey], text: t }))),
    h('select', { class: 'grow', 'aria-label': batter ? 'Hitter' : 'Pitcher', onchange: (e) => { ui[personKey] = e.target.value; render(); } },
      ...roster.map((p) => h('option', { value: p.key, selected: p.key === ui[personKey], text: `${p.name} (${p.line.pa} ${batter ? 'PA' : 'BF'})` })))));

  const s = person.line;
  const pn = s.pitch;
  const hasPitches = pn.pitches > 0;
  main.append(h('section', { class: 'person' },
    h('h1', { text: person.name }),
    h('p', { class: 'muted', text: `${person.team} · ${s.games} ${s.games === 1 ? 'game' : 'games'}` }),
    h('div', { class: 'kpis' }, ...(batter ? [
      kpi('PA', int(s.pa), 'plate appearances'),
      kpi('AVG', avg(s.avg), `${s.h} for ${s.ab}`),
      kpi('OBP', avg(s.obp), 'on base'),
      kpi('SLG', avg(s.slg), `${s.tb} total bases`),
      kpi('K %', pct(s.kPct), `${plural(s.k, 'strikeout')}${s.lookingK ? `, ${s.lookingK} looking` : ''}`),
      kpi('BB %', pct(s.bbPct), `${plural(s.bb, 'walk')}${s.hbp ? `, ${s.hbp} HBP` : ''}`),
      ...(hasPitches ? [
        kpi('Swing %', pct(pn.swingPct), `of ${plural(pn.pitches, 'pitch', 'pitches')} seen`),
        kpi('Whiff %', pct(pn.whiffPct), 'misses per swing'),
        kpi('Chase %', pct(pn.chasePct), 'swings out of the zone'),
        kpi('Pitches / PA', s.perPa === null ? '–' : s.perPa.toFixed(1), 'with pitches recorded'),
      ] : []),
    ] : [
      kpi('BF', int(s.pa), 'batters faced'),
      kpi('K %', pct(s.kPct), plural(s.k, 'strikeout')),
      kpi('BB %', pct(s.bbPct), `${plural(s.bb, 'walk')}${s.hbp ? `, ${s.hbp} HBP` : ''}`),
      kpi('AVG against', avg(s.avg), `${plural(s.h, 'hit')} in ${s.ab} AB`),
      ...(hasPitches ? [
        kpi('Pitches', int(pn.pitches), 'recorded'),
        kpi('Strike %', pct(pn.strikePct), 'not a ball'),
        kpi('1st-pitch strike', pct(pn.firstStrikePct), `of ${plural(pn.first, 'batter')}`),
        kpi('Whiff %', pct(pn.whiffPct), 'misses per swing'),
        kpi('CSW %', pct(pn.cswPct), 'called + swinging strikes'),
      ] : []),
    ])),
    hasPitches ? null : h('p', { class: 'muted small', text: 'No pitches recorded in the app for these plate appearances, so there are no pitch numbers.' })));

  const counts = outcomeCounts(person.plays);
  if (counts.length) {
    const max = Math.max(...counts.map((c) => c.count));
    main.append(h('section', {}, h('h2', { text: batter ? 'Results' : 'Results against' }),
      h('div', { class: 'bars' }, ...counts.map((c) => {
        const bar = h('span', { class: `meter o-${c.outcome}` });
        bar.style.width = `${Math.max(4, (c.count / max) * 100)}%`;
        return h('div', { class: 'bar-row' }, h('span', { class: 'bar-l', text: c.label }), h('span', { class: 'bar-track' }, bar), h('span', { class: 'bar-v', text: String(c.count) }));
      }))));
  }

  if (hasPitches) main.append(arsenalTable(person.plays.flatMap((p) => p.pitches), batter));

  main.append(paList(person.plays, role));
  main.append(teamTable(roster, role, person.key));
}

function kpi(label, value, hint) {
  return h('div', { class: 'kpi' }, h('span', { class: 'kpi-l', text: label }), h('span', { class: 'kpi-v', text: value }), h('span', { class: 'kpi-h', text: hint }));
}

function arsenalTable(pitches, batter) {
  const rows = arsenal(pitches);
  return h('section', {}, h('h2', { text: batter ? 'By pitch type seen' : 'Arsenal' }),
    h('div', { class: 'scroll' }, h('table', { class: 'stats' },
      h('thead', {}, h('tr', {}, ...['Pitch', batter ? 'Seen' : 'Thrown', 'Usage', 'Zone %', 'Strike %', 'Swing %', 'Whiff %', 'Chase %'].map((x) => h('th', { text: x })))),
      h('tbody', {}, ...rows.map((r) => h('tr', {},
        h('th', { text: PITCH_TYPES[r.type] || r.type }),
        ...[int(r.pitches), pct(r.usage), pct(r.zonePct), pct(r.strikePct), pct(r.swingPct), pct(r.whiffPct), pct(r.chasePct)].map((v) => h('td', { text: v }))))))));
}

function paList(plays, role) {
  const batter = role === 'batter';
  const pas = plays.filter((p) => p.isPa || p.pitches.length);
  const byGame = new Map();
  for (const p of pas) { if (!byGame.has(p.game)) byGame.set(p.game, []); byGame.get(p.game).push(p); }
  const games = model.games.filter((g) => byGame.has(g.id));
  const timed = pas.filter((p) => p.video !== null).length;
  return h('section', {}, h('h2', { text: batter ? 'Plate appearances' : 'Batters faced' }),
    timed ? h('p', { class: 'muted small', text: `${timed} of ${pas.length} have video: tap Watch to see it.` }) : null,
    h('div', { class: 'pa-list' }, ...games.map((g) => h('div', { class: 'pa-game' },
      h('div', { class: 'half' }, h('span', { text: `${fmtDate(g.date)} · ${g.title}` }), g.score ? h('span', { class: 'muted', text: `${g.score.away}–${g.score.home}` }) : null),
      ...byGame.get(g.id).map((p) => h('div', { class: 'pa' },
        h('span', { class: 'pa-inn muted small', text: halfName(p) }),
        h('span', { class: 'who' },
          h('strong', { text: p.isPa ? (OUTCOME_LABELS[p.outcome] || p.desc) : 'Not finished' }),
          h('span', { class: 'desc', text: batter ? (p.pitcher ? `vs ${p.pitcher}` : '') : p.batter }),
          p.isPa && p.desc && p.desc !== OUTCOME_LABELS[p.outcome] ? h('span', { class: 'muted small', text: p.desc }) : null),
        pitchTiles(p.pitches),
        p.video !== null ? h('button', { class: 'watch', onclick: () => watch(p), text: `▶ Watch ${fmtTime(p.video)}` }) : h('span', { class: 'watch-none' })))))));
}

function teamTable(roster, role, selected) {
  const batter = role === 'batter';
  const cols = batter
    ? [['G', (s) => s.games], ['PA', (s) => s.pa], ['AB', (s) => s.ab], ['H', (s) => s.h], ['2B', (s) => s.d], ['3B', (s) => s.t],
      ['HR', (s) => s.hr], ['BB', (s) => s.bb], ['K', (s) => s.k], ['AVG', (s) => avg(s.avg)], ['OBP', (s) => avg(s.obp)], ['SLG', (s) => avg(s.slg)]]
    : [['G', (s) => s.games], ['BF', (s) => s.pa], ['K', (s) => s.k], ['BB', (s) => s.bb], ['H', (s) => s.h], ['K %', (s) => pct(s.kPct)],
      ['BB %', (s) => pct(s.bbPct)], ['Pitches', (s) => s.pitch.pitches || '–'], ['Strike %', (s) => pct(s.pitch.strikePct)], ['CSW %', (s) => pct(s.pitch.cswPct)]];
  return h('section', {}, h('h2', { text: batter ? `${roster[0].team} hitters` : `${roster[0].team} pitchers` }),
    h('div', { class: 'scroll' }, h('table', { class: 'stats' },
      h('thead', {}, h('tr', {}, h('th', { text: batter ? 'Hitter' : 'Pitcher' }), ...cols.map(([t]) => h('th', { text: t })))),
      h('tbody', {}, ...roster.map((p) => h('tr', { class: p.key === selected ? 'sel' : '' },
        h('th', {}, h('button', { class: 'link', onclick: () => openPerson(role, p), text: p.name })),
        ...cols.map(([, f]) => h('td', { text: String(f(p.line)) }))))))));
}

boot();
