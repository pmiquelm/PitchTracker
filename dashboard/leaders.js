// Leaderboards: the top 5 on each board, as in the claude.ai dashboard. Streaks carry over from one
// game to the next in date order (GAME 1 before GAME 2 on the same day); "active" means the person's
// latest chance kept it going. Ties share a rank. Rate boards need a minimum sample.
// Works on plays from model.js, so names are the scoresheet's where a game has one. No DOM.

import { compareGames } from './model.js';

// Each board: id, title, note, column heading, number format, and the good or bad list.
export const BOARDS = {
  hit: [
    { id: 'h_contact_streak', good: true, title: 'Swings in a row without a miss', note: 'Streak of fouls and balls in play.', unit: 'Swings', fmt: 'int' },
    { id: 'h_take_streak', good: true, title: 'Pitches out of the zone taken in a row', note: 'Streak of not chasing.', unit: 'Pitches', fmt: 'int' },
    { id: 'h_onbase_streak', good: true, title: 'On base in a row', note: 'Hits, walks and hit by pitch, plate appearance after plate appearance.', unit: 'PA', fmt: 'int' },
    { id: 'h_contact_rate', good: true, title: 'Best contact rate', note: 'Swings that made contact. At least 10 swings.', unit: 'Contact', fmt: 'pct' },
    { id: 'h_chase_low', good: true, title: 'Lowest chase rate', note: 'At least 10 pitches out of the zone.', unit: 'Chase', fmt: 'pct' },
    { id: 'h_walks', good: true, title: 'Most walks', note: '', unit: 'BB', fmt: 'int' },
    { id: 'h_hits', good: true, title: 'Most hits', note: 'From games with recorded results.', unit: 'H', fmt: 'int' },
    { id: 'h_ppa', good: true, title: 'Most pitches per plate appearance', note: 'Works the count. At least 5 PA.', unit: 'P/PA', fmt: 'dec' },
    { id: 'h_freeze_low', good: true, title: 'Lowest freeze rate', note: 'Rarely caught looking at strike three. At least 10 two-strike pitches in the zone.', unit: 'Freeze', fmt: 'pct' },
    { id: 'h_whiff_streak', good: false, title: 'Misses in a row', note: 'Consecutive swings and misses.', unit: 'Swings', fmt: 'int' },
    { id: 'h_chase_streak', good: false, title: 'Chases in a row', note: 'Consecutive swings at pitches out of the zone.', unit: 'Pitches', fmt: 'int' },
    { id: 'h_out_streak', good: false, title: 'Outs in a row', note: 'From games with recorded results.', unit: 'PA', fmt: 'int' },
    { id: 'h_whiff_rate', good: false, title: 'Highest whiff rate', note: 'At least 10 swings.', unit: 'Whiff', fmt: 'pct' },
    { id: 'h_chase_high', good: false, title: 'Highest chase rate', note: 'At least 10 pitches out of the zone.', unit: 'Chase', fmt: 'pct' },
    { id: 'h_k', good: false, title: 'Most strikeouts', note: '', unit: 'K', fmt: 'int' },
    { id: 'h_k_looking', good: false, title: 'Most freezes', note: 'Called third strikes, no swing (strikeouts looking).', unit: 'ꓘ', fmt: 'int' },
    { id: 'h_freeze_rate', good: false, title: 'Highest freeze rate', note: '2-strike pitches in the zone taken for strike three. At least 10.', unit: 'Freeze', fmt: 'pct' },
    { id: 'h_freeze_fb', good: false, title: 'Most frozen by fastballs', note: 'Freeze rate on 2-strike fastballs in the zone. At least 5.', unit: 'FB', fmt: 'pct' },
    { id: 'h_freeze_cb', good: false, title: 'Most frozen by curveballs', note: 'Freeze rate on 2-strike curveballs in the zone. At least 5.', unit: 'CB', fmt: 'pct' },
  ],
  pit: [
    { id: 'p_fps_streak', good: true, title: 'First-pitch strikes in a row', note: 'Batter after batter.', unit: 'Batters', fmt: 'int' },
    { id: 'p_strike_streak', good: true, title: 'Strikes in a row', note: 'Any pitch that was not a ball.', unit: 'Pitches', fmt: 'int' },
    { id: 'p_retired_streak', good: true, title: 'Batters retired in a row', note: 'From games with recorded results.', unit: 'Batters', fmt: 'int' },
    { id: 'p_csw', good: true, title: 'Best CSW', note: 'Called plus swinging strikes. At least 30 pitches.', unit: 'CSW', fmt: 'pct' },
    { id: 'p_whiff', good: true, title: 'Best whiff rate', note: 'Swings missed. At least 10 swings against.', unit: 'Whiff', fmt: 'pct' },
    { id: 'p_k', good: true, title: 'Most strikeouts', note: '', unit: 'K', fmt: 'int' },
    { id: 'p_fps_rate', good: true, title: 'Best first-pitch strike rate', note: 'At least 5 batters faced.', unit: 'FPS', fmt: 'pct' },
    { id: 'p_freezes', good: true, title: 'Most freezes', note: 'Called third strikes, no swing.', unit: 'ꓘ', fmt: 'int' },
    { id: 'p_freeze_rate', good: true, title: 'Best freeze rate', note: '2-strike pitches in the zone taken for strike three. At least 10.', unit: 'Freeze', fmt: 'pct' },
    { id: 'p_freeze_fb', good: true, title: 'Best fastball freeze rate', note: '2-strike fastballs in the zone taken for strike three. At least 5.', unit: 'FB', fmt: 'pct' },
    { id: 'p_freeze_cb', good: true, title: 'Best curveball freeze rate', note: '2-strike curveballs in the zone taken for strike three. At least 5.', unit: 'CB', fmt: 'pct' },
    { id: 'p_ball_streak', good: false, title: 'Balls in a row', note: '', unit: 'Pitches', fmt: 'int' },
    { id: 'p_fpb_streak', good: false, title: 'First-pitch balls in a row', note: 'Batter after batter.', unit: 'Batters', fmt: 'int' },
    { id: 'p_reached_streak', good: false, title: 'Batters reaching base in a row', note: "Hits, walks, hit by pitch, errors and fielder's choices. From games with recorded results.", unit: 'Batters', fmt: 'int' },
    { id: 'p_walks', good: false, title: 'Most walks', note: '', unit: 'BB', fmt: 'int' },
    { id: 'p_bb_rate', good: false, title: 'Highest walk rate', note: 'At least 5 batters faced.', unit: 'BB %', fmt: 'pct' },
    { id: 'p_three_ball', good: false, title: 'Most 3-ball counts', note: 'Batters who got to three balls.', unit: 'Batters', fmt: 'int' },
    { id: 'p_ball_rate', good: false, title: 'Highest ball rate', note: 'At least 30 pitches.', unit: 'Balls', fmt: 'pct' },
  ],
};

const pct = (a, b) => (b ? Math.round((100 * a) / b) : null);
const swing = (p) => p.action === 'SWING' || p.action === 'FOUL' || p.action === 'IN_PLAY';
const ball = (p) => p.result === 'ball';
const whiff = (p) => p.action === 'SWING';
const outZone = (p) => p.zone === 'OUT';
// A freeze: strike three called, no swing. Freeze rate divides by 2-strike pitches in the zone.
const frozen = (p) => p.result === 'called_strike' && (p.paEnd === 'strikeout' || p.strikes === 2);
const twoK = (p) => (p.strikes === 2 && p.zone === 'IN') || frozen(p);

// What a plate appearance was, in the app's categories.
const CATEGORY = { '1B': 'hit', '2B': 'hit', '3B': 'hit', HR: 'hit', BB: 'walk', HBP: 'hbp', K: 'strikeout', OUT: 'out',
  SF: 'sac', SH: 'sac', ROE: 'error', FC: 'fc', CI: 'interference' };
const onBase = (p) => ['hit', 'walk', 'hbp'].includes(p.category);
const retired = (p) => ['out', 'strikeout', 'sac'].includes(p.category);
const reached = (p) => ['hit', 'walk', 'hbp', 'error', 'fc', 'interference'].includes(p.category);

// Longest run of `good` in a list already in order: {len, from, to, active}.
export function longestRun(list, good) {
  let best = { len: 0 };
  let cur = 0;
  let start = null;
  list.forEach((e, i) => {
    if (good(e)) {
      if (!cur) start = e;
      cur += 1;
      if (cur > best.len) best = { len: cur, from: start, to: e, endIdx: i };
    } else cur = 0;
  });
  if (best.len) best.active = best.endIdx === list.length - 1;
  return best;
}

// Top 5 of one board, highest first unless `low`. Zero only counts on a low board.
export function top(rows, low) {
  const ok = rows.filter((r) => r.value != null && (low || r.value > 0));
  ok.sort((a, b) => (low ? a.value - b.value : b.value - a.value) || (b.n ?? 0) - (a.n ?? 0) || String(a.who).localeCompare(String(b.who)));
  const out = [];
  let rank = 0;
  let prev;
  ok.slice(0, 5).forEach((r, i) => {
    if (r.value !== prev) rank = i + 1;
    prev = r.value;
    out.push({ rank, who: r.who, value: r.value, detail: r.detail || '', active: !!r.active });
  });
  return out;
}

function agg(ps) {
  const c = { pitches: ps.length, swings: 0, whiffs: 0, strikes: 0, csw: 0, outZone: 0, chases: 0, first: 0, firstStrikes: 0,
    twok: 0, freezes: 0, k: 0, bb: 0, twok_FB: 0, freezes_FB: 0, twok_CB: 0, freezes_CB: 0 };
  const pas = new Set();
  for (const p of ps) {
    pas.add(p.paKey);
    if (swing(p)) c.swings += 1;
    if (whiff(p)) c.whiffs += 1;
    if (!ball(p)) c.strikes += 1;
    if (p.result === 'called_strike' || p.result === 'swinging_strike') c.csw += 1;
    if (outZone(p)) { c.outZone += 1; if (swing(p)) c.chases += 1; }
    if (p.inPa === 1) { c.first += 1; if (!ball(p)) c.firstStrikes += 1; }
    if (twoK(p)) { c.twok += 1; if (p.type === 'FB' || p.type === 'CB') c[`twok_${p.type}`] += 1; }
    if (frozen(p)) { c.freezes += 1; if (p.type === 'FB' || p.type === 'CB') c[`freezes_${p.type}`] += 1; }
    if (p.paEnd === 'strikeout') c.k += 1;
    if (p.paEnd === 'walk') c.bb += 1;
  }
  c.pas = pas.size;
  c.ppa = c.pas ? Math.round((10 * c.pitches) / c.pas) / 10 : null;
  c.bbPct = pct(c.bb, c.pas);
  return c;
}

// Every board for one side: 'hit' (the team's hitters) or 'pit' (its pitchers). `plays` are
// already filtered to the sessions picked; `games` gives the order.
export function leaderboards(plays, games, side, team) {
  const order = games.slice().sort((a, b) => compareGames(b, a));
  const ord = new Map(order.map((g, i) => [g.id, { i, label: g.date ? g.date.slice(5).replace('-', '/') + (g.number ? ` G${g.number}` : '') : g.id }]));
  const o = (id) => (ord.get(id) || { i: 1e9 }).i;
  const lbl = (id) => (ord.get(id) || { label: id }).label;
  const span = (r) => (r.len ? (r.from.game === r.to.game ? lbl(r.from.game) : `${lbl(r.from.game)} → ${lbl(r.to.game)}`) : '');
  const hitting = side === 'hit';
  const mine = plays.filter((p) => (hitting ? p.team : p.opp) === team && (hitting ? p.batter : p.pitcher))
    .map((p, i) => ({ p, i }))
    .sort((a, b) => o(a.p.game) - o(b.p.game) || a.i - b.i)
    .map((x) => x.p);
  const who = (p) => (hitting ? p.batter : p.pitcher);

  const byP = new Map();
  const byPa = new Map();
  for (const p of mine) {
    const k = who(p);
    p.pitches.forEach((q) => {
      if (!byP.has(k)) byP.set(k, []);
      byP.get(k).push({ ...q, game: p.game, paKey: `${p.game}|${p.seq}` });
    });
    if (p.isPa) {
      if (!byPa.has(k)) byPa.set(k, []);
      byPa.get(k).push({ game: p.game, category: CATEGORY[p.outcome], hit: p.hit });
    }
  }

  const streak = (events, good) => [...byP].map(([k, list]) => {
    const r = longestRun(list.filter(events), good);
    return { who: k, value: r.len, active: r.active, detail: span(r) };
  });
  const paStreak = (good) => [...byPa].map(([k, list]) => {
    const r = longestRun(list, good);
    return { who: k, value: r.len, active: r.active, detail: span(r) };
  });
  const aggs = [...byP].map(([k, list]) => ({ who: k, ...agg(list) }));
  const rate = (num, den, min, label) => aggs.filter((a) => a[den] >= min)
    .map((a) => ({ who: a.who, value: pct(a[num], a[den]), n: a[den], detail: `${a[num]} of ${a[den]} ${label}` }));
  const count = (field) => aggs.map((a) => ({ who: a.who, value: a[field] }));
  const threeBall = [...byP].map(([k, list]) => {
    const all = new Set(list.map((p) => p.paKey));
    const three = new Set(list.filter((p) => p.balls === 3 || (p.balls === 2 && ball(p))).map((p) => p.paKey));
    return { who: k, value: three.size, n: all.size, detail: `of ${all.size} batters` };
  });
  const hits = [...byPa].map(([k, list]) => ({ who: k, value: list.filter((p) => p.hit).length, detail: `in ${list.length} PA` }));

  const out = {};
  const add = (id, rows, low) => { out[id] = top(rows, low); };
  if (hitting) {
    add('h_contact_streak', streak(swing, (p) => !whiff(p)));
    add('h_take_streak', streak(outZone, (p) => !swing(p)));
    add('h_onbase_streak', paStreak(onBase));
    add('h_contact_rate', rate('whiffs', 'swings', 10, 'swings missed').map((r) => ({ ...r, value: r.value == null ? null : 100 - r.value })));
    add('h_chase_low', rate('chases', 'outZone', 10, 'pitches out of the zone chased'), true);
    add('h_walks', count('bb'));
    add('h_hits', hits);
    add('h_ppa', aggs.filter((a) => a.pas >= 5).map((a) => ({ who: a.who, value: a.ppa, n: a.pas, detail: `${a.pitches} pitches, ${a.pas} PA` })));
    add('h_freeze_low', rate('freezes', 'twok', 10, 'two-strike pitches in the zone'), true);
    add('h_whiff_streak', streak(swing, whiff));
    add('h_chase_streak', streak(outZone, swing));
    add('h_out_streak', paStreak(retired));
    add('h_whiff_rate', rate('whiffs', 'swings', 10, 'swings missed'));
    add('h_chase_high', rate('chases', 'outZone', 10, 'pitches out of the zone chased'));
    add('h_k', count('k'));
    add('h_k_looking', count('freezes'));
    add('h_freeze_rate', rate('freezes', 'twok', 10, 'two-strike pitches in the zone'));
    add('h_freeze_fb', rate('freezes_FB', 'twok_FB', 5, 'two-strike fastballs in the zone'));
    add('h_freeze_cb', rate('freezes_CB', 'twok_CB', 5, 'two-strike curveballs in the zone'));
  } else {
    add('p_fps_streak', streak((p) => p.inPa === 1, (p) => !ball(p)));
    add('p_strike_streak', streak(() => true, (p) => !ball(p)));
    add('p_retired_streak', paStreak(retired));
    add('p_csw', rate('csw', 'pitches', 30, 'pitches'));
    add('p_whiff', rate('whiffs', 'swings', 10, 'swings missed'));
    add('p_k', count('k'));
    add('p_fps_rate', rate('firstStrikes', 'first', 5, 'first pitches'));
    add('p_freezes', count('freezes'));
    add('p_freeze_rate', rate('freezes', 'twok', 10, 'two-strike pitches in the zone'));
    add('p_freeze_fb', rate('freezes_FB', 'twok_FB', 5, 'two-strike fastballs in the zone'));
    add('p_freeze_cb', rate('freezes_CB', 'twok_CB', 5, 'two-strike curveballs in the zone'));
    add('p_ball_streak', streak(() => true, ball));
    add('p_fpb_streak', streak((p) => p.inPa === 1, ball));
    add('p_reached_streak', paStreak(reached));
    add('p_walks', count('bb'));
    add('p_bb_rate', aggs.filter((a) => a.pas >= 5).map((a) => ({ who: a.who, value: a.bbPct, n: a.pas, detail: `${a.bb} of ${a.pas} batters` })));
    add('p_three_ball', threeBall);
    add('p_ball_rate', aggs.filter((a) => a.pitches >= 30).map((a) => ({ who: a.who, value: pct(a.pitches - a.strikes, a.pitches), n: a.pitches, detail: `${a.pitches - a.strikes} of ${a.pitches} pitches` })));
  }
  return out;
}
