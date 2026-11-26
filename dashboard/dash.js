// Team dashboard: a read-only view of the sheet, for the whole team.
//
// It opens from a dashboard link (made in the app: Settings → Team dashboard), which carries the
// sheet script's address and its read-only viewer key in the #fragment. Browsers never send the
// fragment to GitHub Pages; the page keeps the two on this device and takes them out of the
// address bar. Every visit reads the sheet fresh: no data is kept on the device.

import { decodeViewerLink, isSetupLinkHash, isValidScriptUrl, isViewerLinkHash, sheetCode } from '../js/connect.js';
import { PITCH_TYPES } from '../js/game.js';
import {
  buildModel, outcomeCounts, arsenal, players, filterSession, line, byGame, countGrid, matchups, OUTCOME_LABELS, NO_TEAM,
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
  hitCmp: 'qab', pitCmp: 'strike', hitSort: null, pitSort: null,
  ...readPrefs(),
};
// Charts are drawn once the page is on screen (they need its width), and again when the width changes.
let drawQueue = [];
const later = (fn) => { drawQueue.push(fn); };
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
  for (const k of ['hitTeam', 'pitTeam', 'lbTeam', 'hitCmp', 'pitCmp']) if (typeof p[k] === 'string') out[k] = p[k];
  return out;
}
function savePrefs() {
  writeJson(PREFS, { tab: ui.tab, session: ui.session, follow: ui.follow, hitTeam: ui.hitTeam, pitTeam: ui.pitTeam, lbTeam: ui.lbTeam,
    hitCmp: ui.hitCmp, pitCmp: ui.pitCmp });
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
  drawQueue = [];
  const tabs = [['games', 'Games'], ['hitters', 'Hitters'], ['pitchers', 'Pitchers'], ['leaders', 'Leaders']];
  const session = h('select', { 'aria-label': 'Sessions: games, live BP or both', onchange: (e) => { ui.session = e.target.value; ui.game = null; savePrefs(); render(); } },
    ...[['game', 'Games'], ['bp', 'Live BP'], ['all', 'Both']].map(([v, t]) => h('option', { value: v, selected: ui.session === v, text: t })));
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
  watchHeader();
  if (ui.tab === 'games') { later(drawWpChart); startPlayer(); }
  redraw();
}

function redraw() {
  for (const fn of drawQueue) fn();
}

// The header's height, for whatever sticks under it (the video, the list of plays).
let headerObserver = null;
function watchHeader() {
  const bar = document.querySelector('header.bar');
  if (!bar) return;
  const set = () => document.documentElement.style.setProperty('--head-h', `${bar.offsetHeight}px`);
  set();
  headerObserver?.disconnect();
  if (window.ResizeObserver) { headerObserver = new ResizeObserver(set); headerObserver.observe(bar); }
}

let resizeFrame = 0;
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastWidth) return; // phones fire resize when the toolbar hides
  lastWidth = window.innerWidth;
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => { if (model) redraw(); });
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
    // Oldest first, in date order (doubleheaders by game number).
    ...games.slice().reverse().map((g) => h('option', { value: g.id, selected: g.id === ui.game, text: gameLabel(g) })));
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
      p.video !== null ? h('div', { class: 'tip-v', text: '▶ Tap to play it' }) : null,
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
        h('th', { class: 'wrap' }, p.video !== null ? h('button', { class: 'link', title: 'Play it in the video', onclick: () => seek(p.video, true), text: `▶ ${p.desc}` }) : p.desc),
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
    title: timed ? 'Play it in the video' : null,
    onclick: timed ? () => seek(p.video, true) : null,
  },
  h('span', { class: 't', 'aria-hidden': 'true', text: timed ? '▶' : '' }),
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
    if (list.scrollHeight > list.clientHeight + 4) {
      // Wide screens: the list scrolls on its own, beside the video.
      list.scrollTo({ top: cur.offsetTop - list.offsetTop - list.clientHeight / 3, behavior: 'smooth' });
    } else {
      // Phones: the page scrolls, under the header and the video that stick at the top. Keep the
      // play just below the video when it would be hidden under it or off the bottom of the screen.
      const covered = (document.querySelector('.video-wrap')?.getBoundingClientRect().bottom ?? 0) + 8;
      const r = cur.getBoundingClientRect();
      if (r.top < covered || r.bottom > window.innerHeight) window.scrollBy({ top: r.top - covered, behavior: 'smooth' });
    }
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

// Every number the two tabs can show or compare. get(line) gives the value; num/den the counts it
// rests on (a value on fewer than 5 is shown faded); type(line, t) the same for one pitch type.
const pt = (s, t) => s.pitch.byType[t];
const METRICS = {
  batter: [
    { id: 'qab', label: 'QAB %', long: 'Quality at-bats', get: (s) => s.qabPct, num: (s) => s.qab, den: (s) => s.tracked, noun: 'plate appearances with pitches', trend: true },
    { id: 'avg', label: 'AVG', long: 'Batting average', fmt: 'avg', get: (s) => s.avg, num: (s) => s.h, den: (s) => s.ab, noun: 'at-bats' },
    { id: 'obp', label: 'OBP', long: 'On-base percentage', fmt: 'avg', get: (s) => s.obp, num: (s) => s.h + s.bb + s.hbp, den: (s) => s.ab + s.bb + s.hbp + s.sf, noun: 'plate appearances' },
    { id: 'slg', label: 'SLG', long: 'Slugging', fmt: 'avg', get: (s) => s.slg, num: (s) => s.tb, den: (s) => s.ab, noun: 'at-bats (total bases)' },
    { id: 'swing', label: 'Swing %', long: 'Swing rate', get: (s) => s.pitch.swingPct, num: (s) => s.pitch.swings, den: (s) => s.pitch.pitches, noun: 'pitches', type: (s, t) => [pt(s, t).swingPct, pt(s, t).pitches] },
    { id: 'whiff', label: 'Whiff %', long: 'Whiff rate', get: (s) => s.pitch.whiffPct, num: (s) => s.pitch.whiffs, den: (s) => s.pitch.swings, noun: 'swings', trend: true, type: (s, t) => [pt(s, t).whiffPct, pt(s, t).swings] },
    { id: 'chase', label: 'Chase %', long: 'Chase rate', get: (s) => s.pitch.chasePct, num: (s) => s.pitch.chases, den: (s) => s.pitch.outZone, noun: 'pitches out of the zone', trend: true, type: (s, t) => [pt(s, t).chasePct, pt(s, t).outZone] },
    { id: 'zswing', label: 'Zone swing %', long: 'Swings at pitches in the zone', get: (s) => s.pitch.zSwingPct, num: (s) => s.pitch.zSwings, den: (s) => s.pitch.inZone, noun: 'pitches in the zone' },
    { id: 'fpswing', label: '1st-pitch swing %', long: 'First-pitch swing rate', get: (s) => s.pitch.firstSwingPct, num: (s) => s.pitch.firstSwings, den: (s) => s.pitch.first, noun: 'first pitches' },
    { id: 'twok', label: '2-strike whiff %', long: 'Whiff rate with two strikes', get: (s) => s.pitch.twokWhiffPct, num: (s) => s.pitch.twokWhiffs, den: (s) => s.pitch.twokSwings, noun: '2-strike swings' },
    { id: 'freeze', label: 'Freeze %', long: 'Freeze rate', get: (s) => s.pitch.freezePct, num: (s) => s.pitch.freezes, den: (s) => s.pitch.twok, noun: '2-strike pitches in the zone', trend: true, type: (s, t) => [pt(s, t).freezePct, pt(s, t).twok] },
    { id: 'k', label: 'K %', long: 'Strikeout rate', get: (s) => s.kPct, num: (s) => s.k, den: (s) => s.pa, noun: 'plate appearances' },
    { id: 'bb', label: 'BB %', long: 'Walk rate', get: (s) => s.bbPct, num: (s) => s.bb, den: (s) => s.pa, noun: 'plate appearances' },
  ],
  pitcher: [
    { id: 'strike', label: 'Strike %', long: 'Strike rate', get: (s) => s.pitch.strikePct, num: (s) => s.pitch.strikes, den: (s) => s.pitch.pitches, noun: 'pitches', trend: true, type: (s, t) => [pt(s, t).strikePct, pt(s, t).pitches] },
    { id: 'fps', label: '1st-pitch strike %', long: 'First-pitch strikes', get: (s) => s.pitch.firstStrikePct, num: (s) => s.pitch.firstStrikes, den: (s) => s.pitch.first, noun: 'batters', trend: true },
    { id: 'oo', label: '1-1 strike %', long: '1-1 strikes', get: (s) => s.ooPct, num: (s) => s.ooStrikes, den: (s) => s.ooPitches, noun: 'pitches at 1-1', trend: true },
    { id: 'putaway', label: 'Putaway %', long: 'Putaway rate', get: (s) => s.putawayPct, num: (s) => s.putaways, den: (s) => s.twokPas, noun: 'batters with 2 strikes', trend: true },
    { id: 'quick', label: 'Quick out %', long: 'Quick outs', get: (s) => s.quickPct, num: (s) => s.quickOuts, den: (s) => s.tracked, noun: 'batters (out in 3 pitches or fewer)' },
    { id: 'leadoff', label: 'Leadoff retired %', long: 'Leadoff batters retired', get: (s) => s.leadoffPct, num: (s) => s.leadoffOuts, den: (s) => s.leadoffs, noun: 'leadoff batters' },
    { id: 'zone', label: 'Zone %', long: 'In the zone', get: (s) => s.pitch.zonePct, num: (s) => s.pitch.inZone, den: (s) => s.pitch.pitches, noun: 'pitches', type: (s, t) => [pt(s, t).zonePct, pt(s, t).pitches] },
    { id: 'three', label: '3-ball count %', long: 'Batters who got to three balls', lowGood: true, get: (s) => s.threeBallPct, num: (s) => s.threeBall, den: (s) => s.batters, noun: 'batters' },
    { id: 'whiff', label: 'Whiff %', long: 'Whiff rate', get: (s) => s.pitch.whiffPct, num: (s) => s.pitch.whiffs, den: (s) => s.pitch.swings, noun: 'swings', type: (s, t) => [pt(s, t).whiffPct, pt(s, t).swings] },
    { id: 'chase', label: 'Chase %', long: 'Chase rate', get: (s) => s.pitch.chasePct, num: (s) => s.pitch.chases, den: (s) => s.pitch.outZone, noun: 'pitches out of the zone', type: (s, t) => [pt(s, t).chasePct, pt(s, t).outZone] },
    { id: 'csw', label: 'CSW %', long: 'Called + swinging strikes', get: (s) => s.pitch.cswPct, num: (s) => s.pitch.csw, den: (s) => s.pitch.pitches, noun: 'pitches' },
    { id: 'freeze', label: 'Freeze %', long: 'Freeze rate', get: (s) => s.pitch.freezePct, num: (s) => s.pitch.freezes, den: (s) => s.pitch.twok, noun: '2-strike pitches in the zone', type: (s, t) => [pt(s, t).freezePct, pt(s, t).twok] },
    { id: 'k', label: 'K %', long: 'Strikeout rate', get: (s) => s.kPct, num: (s) => s.k, den: (s) => s.pa, noun: 'batters faced' },
    { id: 'bb', label: 'BB %', long: 'Walk rate', lowGood: true, get: (s) => s.bbPct, num: (s) => s.bb, den: (s) => s.pa, noun: 'batters faced' },
    { id: 'avg', label: 'AVG against', long: 'Batting average against', lowGood: true, fmt: 'avg', get: (s) => s.avg, num: (s) => s.h, den: (s) => s.ab, noun: 'at-bats' },
  ],
};
const fmtMetric = (m, v) => (m.fmt === 'avg' ? avg(v) : pct(v));
const metricOf = (role, id) => METRICS[role].find((m) => m.id === id) || METRICS[role][0];
const TEAM = '__team__';

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
  const team = ui[teamKey];
  const roster = all.filter((p) => p.team === team);
  const teamPlays = plays.filter((p) => (batter ? p.team : p.opp) === team);
  const teamLine = line(teamPlays);
  if (ui[personKey] !== TEAM && !roster.some((p) => p.key === ui[personKey])) ui[personKey] = TEAM;
  const person = roster.find((p) => p.key === ui[personKey]) || null;
  const subject = person ? person.plays : teamPlays;
  const s = person ? person.line : teamLine;
  const word = batter ? 'hitters' : 'pitchers';

  main.append(h('div', { class: 'controls' },
    h('select', { 'aria-label': 'Team', onchange: (e) => { ui[teamKey] = e.target.value; ui[personKey] = TEAM; savePrefs(); render(); } },
      ...teams.map((t) => h('option', { value: t, selected: t === team, text: t }))),
    h('select', { class: 'grow', 'aria-label': batter ? 'Hitter' : 'Pitcher', onchange: (e) => { ui[personKey] = e.target.value; render(); } },
      h('option', { value: TEAM, selected: !person, text: `Whole team: all ${roster.length} ${word}` }),
      ...roster.map((p) => h('option', { value: p.key, selected: p === person, text: `${p.name} (${p.line.pa} ${batter ? 'PA' : 'BF'})` })))));

  main.append(h('section', { class: 'person' },
    h('h1', { text: person ? person.name : `${team} ${word}` }),
    h('p', { class: 'muted', text: `${person ? `${team} · ` : ''}${plural(s.games, 'game')} · ${plural(s.pa, batter ? 'plate appearance' : 'batter faced', batter ? 'plate appearances' : 'batters faced')} · ${plural(s.pitch.pitches, 'pitch', 'pitches')} recorded` }),
    kpis(role, s, person ? teamLine : null)));

  // Game by game
  const trendMetrics = METRICS[role].filter((m) => m.trend);
  main.append(h('section', { id: batter ? 'hit-trend' : 'pit-trend' }, h('h2', { text: 'Game by game' }),
    h('p', { class: 'muted small', text: `Each game in date order${person ? `, for ${person.name}; the grey line is the whole team` : ' for the whole team'}. Hollow dots rest on fewer than 5 chances. The dashed line is the rate over all the games.` }),
    trends(trendMetrics, byGame(subject, model.games), person ? byGame(teamPlays, model.games) : null, s)));

  // Within the team
  main.append(compareSection(role, roster, teamLine, person));
  main.append(peopleTable(role, roster, teamLine, person));

  if (person) {
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
  }
  const pitches = subject.flatMap((p) => p.pitches);
  if (pitches.length) {
    main.append(arsenalTable(role, person ? null : roster, pitches));
    if (!batter) main.append(countSection(pitches));
  }
  if (!batter) main.append(matchupTable(person ? person.plays : teamPlays));
  if (person) main.append(paList(person.plays, role));
}

function kpis(role, s, team) {
  const batter = role === 'batter';
  const pn = s.pitch;
  const card = (m, extraHint) => {
    const v = m.get(s);
    const den = m.den(s);
    const t = team ? m.get(team) : null;
    return h('div', { class: `kpi${den && den < 5 ? ' thin' : ''}` },
      h('span', { class: 'kpi-l', text: m.long }),
      h('span', { class: 'kpi-v', text: fmtMetric(m, v) }),
      h('span', { class: 'kpi-h', text: extraHint || `${m.num(s)} of ${den} ${m.noun}` }),
      team ? h('span', { class: `kpi-t${v !== null && t !== null ? (v > t === !m.lowGood ? ' up' : v < t === !m.lowGood ? ' down' : '') : ''}`, text: `Team ${fmtMetric(m, t)}` }) : null);
  };
  const plain = (label, value, hint) => h('div', { class: 'kpi' }, h('span', { class: 'kpi-l', text: label }), h('span', { class: 'kpi-v', text: value }), h('span', { class: 'kpi-h', text: hint }));
  const M = (id) => metricOf(role, id);
  const cards = batter ? [
    card(M('qab')), card(M('avg'), `${s.h} for ${s.ab}`), card(M('obp')), card(M('slg'), `${s.tb} total bases`),
    card(M('swing')), card(M('whiff')), card(M('chase')),
    card(M('k'), `${plural(s.k, 'strikeout')}${s.lookingK ? `, ${s.lookingK} looking` : ''}`),
    card(M('bb'), `${plural(s.bb, 'walk')}${s.hbp ? `, ${s.hbp} HBP` : ''}`),
    plain('Freezes', int(pn.freezes), 'called third strikes'),
    card(M('freeze')),
    plain('Freeze rate FB / CB', `${pct(pn.byType.FB.freezePct)} / ${pct(pn.byType.CB.freezePct)}`, '2-strike fastballs / curveballs in the zone'),
    plain('Pitches / PA', s.perPa === null ? '–' : s.perPa.toFixed(1), `${plural(pn.pitches, 'pitch', 'pitches')} seen`),
  ] : [
    plain('Pitches', int(pn.pitches), `${plural(s.batters, 'batter')} with a pitch`),
    card(M('strike')), card(M('fps')), card(M('oo')), card(M('putaway')), card(M('quick')), card(M('leadoff')),
    card(M('whiff')), card(M('chase')), card(M('csw')),
    plain('K / BB', `${s.k} / ${s.bb}`, 'strikeouts / walks'), card(M('k')), card(M('bb')), card(M('avg'), `${plural(s.h, 'hit')} in ${s.ab} AB`),
    plain('Freezes', int(pn.freezes), 'called third strikes'), card(M('freeze')),
    plain('Freeze rate FB / CB', `${pct(pn.byType.FB.freezePct)} / ${pct(pn.byType.CB.freezePct)}`, '2-strike fastballs / curveballs in the zone'),
  ];
  return h('div', { class: 'kpis' }, ...cards);
}

// ---------- charts ----------

// Small line charts, one per metric, one point per game. `team` (a player's team, same games) is
// drawn in grey behind.
function trends(metrics, rows, teamRows, overall) {
  const box = h('div', { class: 'trends' });
  if (!rows.length) { box.append(empty('No games in this selection.')); return box; }
  for (const m of metrics) {
    const panel = h('div', { class: 'trend' }, h('h3', { text: m.long }),
      h('p', { class: 'muted small' }, 'All games ', h('strong', { text: fmtMetric(m, m.get(overall)) }), ` (${m.num(overall)} of ${m.den(overall)} ${m.noun})`));
    const chart = h('div', { class: 'chart-box' });
    panel.append(chart);
    box.append(panel);
    later(() => drawTrend(chart, m, rows, teamRows, m.get(overall)));
  }
  return box;
}

function drawTrend(el, m, rows, teamRows, overall) {
  const W = Math.max(220, el.clientWidth);
  const H = 130;
  const L = 36;
  const R = 12;
  const T = 14;
  const B = 22;
  const max = m.fmt === 'avg' ? Math.max(0.5, ...rows.map((r) => m.get(r.line) ?? 0)) : 1;
  const x = (i) => (rows.length > 1 ? L + 8 + (i / (rows.length - 1)) * (W - L - R - 16) : (L + W - R) / 2);
  const y = (v) => T + (1 - v / max) * (H - T - B);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', 'aria-label': `${m.long} in each game` });
  for (const v of [0, max / 2, max]) {
    svg.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }));
    const t = s('text', { x: L - 6, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' });
    t.textContent = fmtMetric(m, v);
    svg.append(t);
  }
  const maxLabels = Math.max(2, Math.floor((W - L - R) / 48));
  const step = Math.ceil(rows.length / maxLabels);
  rows.forEach((r, i) => {
    if (i % step && i !== rows.length - 1) return;
    if (i !== rows.length - 1 && rows.length - 1 - i < step && i) return;
    const t = s('text', { x: x(i), y: H - 6, class: 'axis', 'text-anchor': rows.length === 1 ? 'middle' : i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle' });
    t.textContent = r.label;
    svg.append(t);
  });
  if (overall !== null) svg.append(s('line', { x1: L, x2: W - R, y1: y(overall), y2: y(overall), class: 'ref' }));
  const path = (pts, cls) => { if (pts.length > 1) svg.append(s('path', { d: pts.map((q, k) => `${k ? 'L' : 'M'}${x(q.i).toFixed(1)},${y(q.v).toFixed(1)}`).join(''), class: cls })); };
  if (teamRows) {
    const byId = new Map(teamRows.map((r) => [r.id, r]));
    path(rows.map((r, i) => ({ i, v: m.get(byId.get(r.id)?.line ?? r.line) })).filter((q) => q.v !== null), 'line team');
  }
  const pts = rows.map((r, i) => ({ i, r, v: m.get(r.line) })).filter((q) => q.v !== null);
  path(pts, 'line');
  for (const q of pts) {
    const den = m.den(q.r.line);
    const c = s('circle', { cx: x(q.i), cy: y(q.v), r: 4.5, class: den < 5 ? 'pt hollow' : 'pt' });
    const title = s('title');
    title.textContent = `${q.r.title}: ${fmtMetric(m, q.v)} (${m.num(q.r.line)} of ${den} ${m.noun})`;
    c.append(title);
    svg.append(c);
  }
  if (!pts.length) { const t = s('text', { x: W / 2, y: y(max / 2), class: 'axis', 'text-anchor': 'middle' }); t.textContent = 'Nothing to count yet'; svg.append(t); }
  el.replaceChildren(svg);
}

// The team side by side on one metric: a row per player, the dot their rate (fastball and curveball
// dots too where it applies), the dashed line the team's.
function compareSection(role, roster, teamLine, person) {
  const key = role === 'batter' ? 'hitCmp' : 'pitCmp';
  // The stat picked, or the first one anybody has numbers for (no pitches recorded: no QAB).
  const has = (x) => roster.some((p) => x.den(p.line) > 0);
  const m = [metricOf(role, ui[key]), ...METRICS[role]].find(has) || metricOf(role, ui[key]);
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Compare on' },
    ...METRICS[role].map((x) => h('button', { class: x.id === m.id ? 'chip on' : 'chip', 'aria-pressed': String(x.id === m.id),
      onclick: () => { ui[key] = x.id; savePrefs(); render(); }, text: x.label })));
  const chart = h('div', { class: 'chart-box cmp' });
  const rows = roster.map((p) => ({ p, v: m.get(p.line), den: m.den(p.line) })).filter((r) => r.den > 0)
    .sort((a, b) => (b.v ?? -1) - (a.v ?? -1) || b.den - a.den);
  later(() => drawCompare(chart, m, rows, m.get(teamLine), person, role));
  return h('section', { id: role === 'batter' ? 'hit-compare' : 'pit-compare' },
    h('h2', { text: `Compare ${role === 'batter' ? 'hitters' : 'pitchers'}` }), chips,
    h('p', { class: 'muted small', text: `${m.long}: ${m.noun === 'pitches' ? 'out of' : 'over'} ${m.noun}. ${m.type ? 'Blue and orange dots are fastballs and curveballs. ' : ''}The dashed line is the whole team. Hollow dots rest on fewer than 5. Tap a name to open that player.` }),
    rows.length ? chart : empty('Nothing to compare yet.'));
}

function drawCompare(el, m, rows, teamV, person, role) {
  const W = Math.max(280, el.clientWidth);
  const rowH = 26;
  const L = Math.min(150, Math.round(W * 0.34));
  const R = 48;
  const T = 18;
  const H = T + rows.length * rowH + 6;
  const max = m.fmt === 'avg' ? Math.max(0.5, ...rows.map((r) => r.v ?? 0)) : 1;
  const x = (v) => L + (v / max) * (W - L - R);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', 'aria-label': `${m.long} by player` });
  for (const v of [0, max / 2, max]) {
    svg.append(s('line', { x1: x(v), x2: x(v), y1: T - 4, y2: H - 4, class: 'grid' }));
    const t = s('text', { x: x(v), y: 11, class: 'axis', 'text-anchor': v === 0 ? 'start' : v === max ? 'end' : 'middle' });
    t.textContent = fmtMetric(m, v);
    svg.append(t);
  }
  if (teamV !== null) svg.append(s('line', { x1: x(teamV), x2: x(teamV), y1: T - 4, y2: H - 4, class: 'ref' }));
  rows.forEach((r, i) => {
    const cy = T + i * rowH + rowH / 2;
    const sel = person && r.p.key === person.key;
    if (sel) svg.append(s('rect', { x: 0, y: cy - rowH / 2, width: W, height: rowH, class: 'sel-row' }));
    const name = s('text', { x: L - 8, y: cy + 4, 'text-anchor': 'end', class: `name${sel ? ' on' : ''}` });
    const nm = r.p.name;
    name.textContent = nm.length > L / 7 ? `${nm.slice(0, Math.floor(L / 7) - 1)}…` : nm;
    const t1 = s('title'); t1.textContent = nm; name.append(t1);
    name.addEventListener('click', () => openPerson(role, r.p));
    svg.append(name);
    svg.append(s('line', { x1: L, x2: W - R, y1: cy, y2: cy, class: 'track' }));
    if (m.type) {
      for (const t of ['FB', 'CB']) {
        const [v, den] = m.type(r.p.line, t);
        if (v === null) continue;
        const c = s('circle', { cx: x(v), cy, r: 4, class: `pt-${t}${den < 5 ? ' hollow' : ''}` });
        const tt = s('title'); tt.textContent = `${nm}, ${t === 'FB' ? 'fastballs' : 'curveballs'}: ${fmtMetric(m, v)} (of ${den})`; c.append(tt);
        svg.append(c);
      }
    }
    if (r.v !== null) {
      const c = s('circle', { cx: x(r.v), cy, r: 6, class: `pt${r.den < 5 ? ' hollow' : ''}` });
      const tt = s('title'); tt.textContent = `${nm}: ${fmtMetric(m, r.v)} (${m.num(r.p.line)} of ${r.den} ${m.noun})`; c.append(tt);
      svg.append(c);
    }
    const val = s('text', { x: W - 4, y: cy + 4, 'text-anchor': 'end', class: `val${r.den < 5 ? ' faint' : ''}` });
    val.textContent = fmtMetric(m, r.v);
    svg.append(val);
  });
  el.replaceChildren(svg);
}

// Every player in the team, every number, sortable. Faded rates rest on fewer than 5.
function peopleTable(role, roster, teamLine, person) {
  const batter = role === 'batter';
  const M = (id) => metricOf(role, id);
  const rate = (m) => ({ label: m.label, get: m.get, fmt: (v) => fmtMetric(m, v), thin: (s) => m.den(s) < 5 });
  const type = (m, t) => ({ label: `${m.label.replace(' %', '')} % ${t}`, get: (s) => m.type(s, t)[0], fmt: pct, thin: (s) => m.type(s, t)[1] < 5 });
  const n = (label, get) => ({ label, get, fmt: int });
  const cols = batter ? [
    n('G', (s) => s.games), n('PA', (s) => s.pa), n('Pitches', (s) => s.pitch.pitches), rate(M('qab')),
    rate(M('avg')), rate(M('obp')), rate(M('slg')), n('H', (s) => s.h), n('XBH', (s) => s.xbh), n('BB', (s) => s.bb), n('HBP', (s) => s.hbp), n('K', (s) => s.k),
    rate(M('swing')), rate(M('whiff')), type(M('whiff'), 'FB'), type(M('whiff'), 'CB'), rate(M('chase')), type(M('chase'), 'FB'), type(M('chase'), 'CB'),
    rate(M('zswing')), rate(M('fpswing')), rate(M('twok')), n('Freezes', (s) => s.pitch.freezes), rate(M('freeze')), type(M('freeze'), 'FB'), type(M('freeze'), 'CB'),
  ] : [
    n('G', (s) => s.games), n('BF', (s) => s.pa), n('Pitches', (s) => s.pitch.pitches),
    { label: 'Pitches / BF', get: (s) => s.perPa, fmt: (v) => (v === null ? '–' : v.toFixed(1)) },
    rate(M('strike')), rate(M('fps')), rate(M('oo')), rate(M('putaway')), rate(M('quick')), rate(M('leadoff')), rate(M('zone')), rate(M('three')),
    rate(M('whiff')), rate(M('chase')), rate(M('csw')),
    { label: 'FB %', get: (s) => s.pitch.byType.FB.usage, fmt: pct }, { label: 'CB %', get: (s) => s.pitch.byType.CB.usage, fmt: pct },
    n('Freezes', (s) => s.pitch.freezes), rate(M('freeze')), type(M('freeze'), 'FB'), type(M('freeze'), 'CB'),
    rate(M('k')), rate(M('bb')), n('K', (s) => s.k), n('BB', (s) => s.bb), n('H', (s) => s.h), rate(M('avg')),
  ];
  const key = batter ? 'hitSort' : 'pitSort';
  const sort = ui[key] && cols.some((c) => c.label === ui[key].col) ? ui[key] : { col: 'PA', dir: -1 };
  const col = cols.find((c) => c.label === sort.col) || cols.find((c) => c.label === (batter ? 'PA' : 'BF'));
  const rows = roster.slice().sort((a, b) => {
    if (sort.col === 'name') return sort.dir * a.name.localeCompare(b.name);
    const va = col.get(a.line);
    const vb = col.get(b.line);
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    return sort.dir * (va - vb) || a.name.localeCompare(b.name);
  });
  const head = (label, id) => h('th', {
    class: `sort${sort.col === id ? (sort.dir > 0 ? ' asc' : ' desc') : ''}`, tabindex: 0, role: 'button',
    'aria-sort': sort.col === id ? (sort.dir > 0 ? 'ascending' : 'descending') : null,
    onclick: () => { ui[key] = { col: id, dir: sort.col === id ? -sort.dir : id === 'name' ? 1 : -1 }; render(); },
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } },
    text: label,
  });
  const cell = (c, l) => { const v = c.get(l); return h('td', { class: c.thin && c.thin(l) ? 'faint' : '', text: c.fmt(v ?? null) }); };
  return h('section', { id: batter ? 'batters' : 'pitchers-table' }, h('h2', { text: batter ? 'Hitters' : 'Pitchers' }),
    h('p', { class: 'muted small', text: 'Tap a column to sort, or a name to open that player. Faded rates rest on fewer than 5 chances.' }),
    h('div', { class: 'scroll' }, h('table', { class: 'stats' },
      h('thead', {}, h('tr', {}, head(batter ? 'Hitter' : 'Pitcher', 'name'), ...cols.map((c) => head(c.label, c.label)))),
      h('tbody', {}, ...rows.map((p) => h('tr', { class: person && p.key === person.key ? 'sel' : '' },
        h('th', {}, h('button', { class: 'link', onclick: () => openPerson(role, p), text: p.name })),
        ...cols.map((c) => cell(c, p.line))))),
      h('tfoot', {}, h('tr', {}, h('th', { text: 'Whole team' }), ...cols.map((c) => (c.label === 'G' ? h('td', { text: int(teamLine.games) }) : cell(c, teamLine))))))));
}

function arsenalTable(role, roster, pitches) {
  const batter = role === 'batter';
  const head = ['Pitch', batter ? 'Seen' : 'Thrown', 'Usage', 'Zone %', 'Strike %', 'Swing %', 'Whiff %', 'Chase %', 'CSW %', 'Freezes', 'Freeze %'];
  const cells = (r) => [int(r.pitches), pct(r.usage), pct(r.zonePct), pct(r.strikePct), pct(r.swingPct), pct(r.whiffPct), pct(r.chasePct), pct(r.cswPct), int(r.freezes), pct(r.freezePct)];
  const groups = roster && !batter ? roster.filter((p) => p.line.pitch.pitches).map((p) => ({ who: p.name, list: arsenal(p.plays.flatMap((q) => q.pitches)) }))
    : [{ who: null, list: arsenal(pitches) }];
  return h('section', { id: 'arsenal' }, h('h2', { text: batter ? 'By pitch type seen' : 'Arsenal' }),
    !batter ? h('p', { class: 'muted small', text: 'Each pitch type: how often, how many in the zone, and how batters handled them.' }) : null,
    h('div', { class: 'scroll' }, h('table', { class: 'stats' },
      h('thead', {}, h('tr', {}, ...(groups[0].who !== null ? [h('th', { text: 'Pitcher' })] : []), ...head.map((x) => h('th', { text: x })))),
      h('tbody', {}, ...groups.flatMap((g) => g.list.map((r, i) => h('tr', {},
        ...(g.who !== null ? [h('th', { text: i ? '' : g.who })] : []),
        h(g.who !== null ? 'td' : 'th', { class: 'left', text: PITCH_TYPES[r.type] || r.type }),
        ...cells(r).map((v) => h('td', { text: v })))))))));
}

function countSection(pitches) {
  const cells = countGrid(pitches);
  return h('section', { id: 'counts' }, h('h2', { text: 'Swing rate and pitch mix by count' }),
    h('p', { class: 'muted small', text: 'Each box is a ball-strike count. The big number is how often batters swung; the bar is the mix of pitches thrown in that count.' }),
    h('div', { class: 'count-grid' }, ...cells.map((c) => {
      const bar = h('span', { class: 'mix' }, ...c.mix.filter((x) => x.share).map((x) => { const seg = h('span', { class: `seg t-${x.type}`, title: `${PITCH_TYPES[x.type]} ${pct(x.share)}` }); seg.style.width = `${x.share * 100}%`; return seg; }));
      return h('div', { class: `count${c.pitches ? '' : ' none'}` },
        h('span', { class: 'count-l', text: `${c.balls}-${c.strikes}` }),
        h('span', { class: 'count-v', text: c.pitches ? pct(c.swingPct) : '–' }),
        h('span', { class: 'muted small', text: c.pitches ? `swung · ${plural(c.pitches, 'pitch', 'pitches')}` : 'no pitches' }), bar);
    })),
    h('div', { class: 'key' }, h('span', { class: 'key-i' }, h('span', { class: 'tile t-FB' }), 'fastball'), h('span', { class: 'key-i' }, h('span', { class: 'tile t-CB' }), 'curveball')));
}

function matchupTable(plays) {
  const rows = matchups(plays).filter((r) => r.line.batters);
  if (!rows.length) return null;
  return h('section', { id: 'matchups' }, h('h2', { text: 'Batter vs pitcher' }),
    h('p', { class: 'muted small', text: 'Every pitcher and batter pair. Most useful for live BP, where the same hitters face the same arms again and again. BB includes hit by pitch.' }),
    h('div', { class: 'scroll' }, h('table', { class: 'stats' },
      h('thead', {}, h('tr', {}, ...['Pitcher', 'Batter', 'Pitches', 'PA', 'Swing %', 'Whiff %', 'H', 'K', 'BB', 'AVG'].map((x) => h('th', { text: x })))),
      h('tbody', {}, ...rows.map((r, i) => h('tr', {},
        h('th', { text: i && rows[i - 1].pitcher === r.pitcher ? '' : r.pitcher }), h('td', { class: 'left', text: r.batter }),
        ...[int(r.line.pitch.pitches), int(r.line.pa), pct(r.line.pitch.swingPct), pct(r.line.pitch.whiffPct), int(r.line.h), int(r.line.k), int(r.line.bb + r.line.hbp), avg(r.line.avg)]
          .map((v) => h('td', { text: v }))))))));
}

function paList(plays, role) {
  const batter = role === 'batter';
  const pas = plays.filter((p) => p.isPa || p.pitches.length);
  const byGameMap = new Map();
  for (const p of pas) { if (!byGameMap.has(p.game)) byGameMap.set(p.game, []); byGameMap.get(p.game).push(p); }
  const games = model.games.filter((g) => byGameMap.has(g.id));
  const timed = pas.filter((p) => p.video !== null).length;
  return h('section', {}, h('h2', { text: batter ? 'Plate appearances' : 'Batters faced' }),
    timed ? h('p', { class: 'muted small', text: `${timed} of ${pas.length} have video: tap Watch to see it.` }) : null,
    h('div', { class: 'pa-list' }, ...games.map((g) => h('div', { class: 'pa-game' },
      h('div', { class: 'half' }, h('span', { text: `${fmtDate(g.date)} · ${g.title}` }), g.score ? h('span', { class: 'muted', text: `${g.score.away}–${g.score.home}` }) : null),
      ...byGameMap.get(g.id).map((p) => h('div', { class: 'pa' },
        h('span', { class: 'pa-inn muted small', text: halfName(p) }),
        h('span', { class: 'who' },
          h('strong', { text: p.isPa ? (OUTCOME_LABELS[p.outcome] || p.desc) : 'Not finished' }),
          h('span', { class: 'desc', text: batter ? (p.pitcher ? `vs ${p.pitcher}` : '') : p.batter }),
          p.isPa && p.desc && p.desc !== OUTCOME_LABELS[p.outcome] ? h('span', { class: 'muted small', text: p.desc }) : null),
        pitchTiles(p.pitches),
        p.video !== null ? h('button', { class: 'watch', onclick: () => watch(p), text: '▶ Watch' }) : h('span', { class: 'watch-none' })))))));
}

boot();
