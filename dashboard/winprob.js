// Run expectancy, win probability and leverage for games with a transcribed scoresheet
// (the PlayByPlay tab). Ported from the claude.ai dashboard so both give the same numbers.
//
// The model plays out a half-inning one event at a time: a plate appearance, or with runners on, a
// base-running play (wild pitch, passed ball or balk; a steal; a runner caught stealing or picked
// off). Rates come from this league's own games (play-by-play, plus the app's plate appearances from
// games without play-by-play), pulled toward typical rates while the sample is small. On a single a
// runner from 2nd scores and one from 1st stops at 2nd; on a double a runner from 1st stops at 3rd.
// Some outs with a runner on 1st and fewer than two outs are double plays. Games follow the league's
// rules: 7 innings, the run rule, and extra innings starting with runners on 1st and 2nd.
// No DOM, no network.

export const OUTCOMES = [
  { outcome: 'out', label: 'Out (K, ground out, fly out, fielder’s choice)', prior: 0.655 },
  { outcome: 'walk', label: 'Walk or hit by pitch', prior: 0.11 },
  { outcome: 'single', label: 'Single or reached on error', prior: 0.165 },
  { outcome: 'double', label: 'Double', prior: 0.045 },
  { outcome: 'triple', label: 'Triple', prior: 0.01 },
  { outcome: 'hr', label: 'Home run', prior: 0.015 },
];
// Base-running and double plays: rough starting guesses, each worth PRIOR_RUN chances.
export const RUNNING = [
  { outcome: 'dp', label: 'Double play', per: 'outs with a runner on 1st and fewer than 2 outs', prior: 0.12 },
  { outcome: 'adv', label: 'Wild pitch, passed ball or balk', per: 'plays with runners on', prior: 0.04 },
  { outcome: 'steal', label: 'Stolen base', per: 'plays with a base open to steal', prior: 0.06 },
  { outcome: 'caught', label: 'Caught stealing or picked off', per: 'plays with a base open to steal', prior: 0.02 },
];
const PRIOR_PA = 50;
const PRIOR_RUN = 50;
export const INNINGS = 7; // every game in the league is scheduled for 7 innings
const RUN_RULE = { 3: 20, 4: 15, 5: 10, 6: 10 }; // game over when a team leads by this many after that inning
const TIEBREAK_FROM = 8; // extra innings start with runners on 1st and 2nd
const CODE = { K: 'out', GO: 'out', FO: 'out', LO: 'out', PO: 'out', FC: 'out', DP: 'out', SF: 'out', SH: 'out', SAC: 'out',
  BB: 'walk', IBB: 'walk', HBP: 'walk', CI: 'walk', '1B': 'single', ROE: 'single', 'K-PB': 'single', 'K-WP': 'single', E: 'single',
  '2B': 'double', '3B': 'triple', HR: 'hr' };
// The app's PlateAppearances result codes.
const APP_CODE = { K: 'out', GO: 'out', LO: 'out', FO: 'out', DP: 'out', FC: 'out', SAC_BUNT: 'out', SAC_FLY: 'out', OUT_RULE: 'out',
  BB: 'walk', IBB: 'walk', HBP: 'walk', CI: 'walk', '1B': 'single', E_GROUND: 'single', E_LINE: 'single', E_FLY: 'single',
  '2B': 'double', '3B': 'triple', HR: 'hr' };
// Play-by-play codes of plays between plate appearances.
const RUN_CODE = { WP: 'adv', PB: 'adv', BK: 'adv', SB: 'steal', 'CS-E': 'steal', CS: 'caught', PK: 'caught', PO: 'caught' };
export const BASE_ORDER = [0, 1, 2, 4, 3, 5, 6, 7];

export const baseLabel = (b) => [(b & 1) ? '1' : '_', (b & 2) ? '2' : '_', (b & 4) ? '3' : '_'].join(' ');
const text = (v) => String(v ?? '').trim();
const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const bits = (r1, r2, r3) => (text(r1) ? 1 : 0) | (text(r2) ? 2 : 0) | (text(r3) ? 4 : 0);
const pop = (b) => (b & 1) + ((b >> 1) & 1) + ((b >> 2) & 1);
const isPa = (e) => num(e.is_pa) === 1 || text(e.is_pa).toUpperCase() === 'TRUE';
// Bases after a steal, or null when no runner has an open base ahead (a runner on 2nd takes 3rd,
// with a runner on 1st taking 2nd behind him; else a runner on 1st takes 2nd).
const stealTo = (b) => ((b & 2) && !(b & 4) ? (b << 1) & 7 : (b & 1) && !(b & 2) ? (b & ~1) | 2 : null);
// Bases after the runner who would steal is thrown out.
const caughtTo = (b) => ((b & 2) && !(b & 4) ? b & ~2 : (b & 1) && !(b & 2) ? b & ~1 : null);
export const round = (v, n) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** n) / 10 ** n);

// Where one plate-appearance outcome takes the bases (b) and how many runs score.
function step(o, b) {
  if (o === 'out') return { b, outs: 1, runs: 0 };
  if (o === 'walk') {
    if (!(b & 1)) return { b: b | 1, outs: 0, runs: 0 };
    if (!(b & 2)) return { b: b | 3, outs: 0, runs: 0 };
    if (!(b & 4)) return { b: 7, outs: 0, runs: 0 };
    return { b: 7, outs: 0, runs: 1 };
  }
  const r23 = ((b & 2) ? 1 : 0) + ((b & 4) ? 1 : 0);
  if (o === 'single') return { b: 1 | ((b & 1) ? 2 : 0), outs: 0, runs: r23 };
  if (o === 'double') return { b: 2 | ((b & 1) ? 4 : 0), outs: 0, runs: r23 };
  if (o === 'triple') return { b: 4, outs: 0, runs: pop(b) };
  return { b: 0, outs: 0, runs: pop(b) + 1 };
}

// Every next event from bases b and o outs: {pr, b, outs, runs}.
function moves(p, run, b, o) {
  const qa = b ? run.adv || 0 : 0;
  const st = stealTo(b);
  const qs = st != null ? run.steal || 0 : 0;
  const qc = st != null ? run.caught || 0 : 0;
  const pa = 1 - qa - qs - qc;
  const list = [];
  if (qa) list.push({ pr: qa, b: (b << 1) & 7, outs: 0, runs: (b & 4) ? 1 : 0 });
  if (qs) list.push({ pr: qs, b: st, outs: 0, runs: 0 });
  if (qc) list.push({ pr: qc, b: caughtTo(b), outs: 1, runs: 0 });
  for (const oc of Object.keys(p)) {
    if (!(p[oc] > 0)) continue;
    const s = step(oc, b);
    if (oc === 'out' && (b & 1) && o < 2 && run.dp) {
      // Double play: batter and runner from 1st out; runners on 2nd and 3rd move up (a run counts only if the inning goes on).
      const scores = o === 0 && (b & 4) ? 1 : 0;
      list.push({ pr: pa * p[oc] * run.dp, b: (b & 2) ? 4 : 0, outs: 2, runs: scores });
      list.push({ pr: pa * p[oc] * (1 - run.dp), b: s.b, outs: s.outs, runs: s.runs });
    } else list.push({ pr: pa * p[oc], b: s.b, outs: s.outs, runs: s.runs });
  }
  return list;
}

// How often each kind of plate appearance and base-running play happened in this league, blended
// with a typical rate worth 50 plate appearances (or 50 chances) so a small sample doesn't swing it.
// `pbp`: PlayByPlay rows (objects); `appPas`: PlateAppearances rows.
export function rates(pbp, appPas) {
  const pbpGames = new Set(pbp.map((e) => text(e.game_id)));
  const all = [
    ...pbp.filter((e) => isPa(e) && CODE[text(e.event_code)]).map((e) => CODE[text(e.event_code)]),
    ...appPas.filter((p) => text(p.game_id) && text(p.session_type) !== 'bp' && !pbpGames.has(text(p.game_id)) && APP_CODE[text(p.result)])
      .map((p) => APP_CODE[text(p.result)]),
  ];
  const n = all.length;
  const rows = OUTCOMES.map((o) => {
    const count = all.filter((x) => x === o.outcome).length;
    const rate = (count + PRIOR_PA * o.prior) / (n + PRIOR_PA);
    return { outcome: o.outcome, label: o.label, count, chances: n, per: 'plate appearances', observed: n ? count / n : null, prior: o.prior, rate };
  });
  // Double plays and base-running, from the play-by-play's bases and outs before each play.
  const c = { dp: 0, adv: 0, steal: 0, caught: 0 };
  const ch = { dp: 0, adv: 0, steal: 0, caught: 0 };
  for (const e of pbp) {
    const b = bits(e.runner_1b_before, e.runner_2b_before, e.runner_3b_before);
    const o = num(e.outs_before) ?? 0;
    const pa = isPa(e) && CODE[text(e.event_code)];
    const rc = isPa(e) ? null : RUN_CODE[text(e.event_code)];
    if (!pa && !rc) continue;
    if (b) { ch.adv += 1; if (rc === 'adv') c.adv += 1; }
    if (stealTo(b) != null) { ch.steal += 1; ch.caught += 1; if (rc === 'steal') c.steal += 1; if (rc === 'caught') c.caught += 1; }
    if (pa === 'out' && (b & 1) && o < 2) { ch.dp += 1; if (text(e.event_code) === 'DP' || (num(e.outs_on_play) ?? 0) >= 2) c.dp += 1; }
  }
  for (const r of RUNNING) {
    const rate = (c[r.outcome] + PRIOR_RUN * r.prior) / (ch[r.outcome] + PRIOR_RUN);
    rows.push({ outcome: r.outcome, label: r.label, count: c[r.outcome], chances: ch[r.outcome], per: r.per,
      observed: ch[r.outcome] ? c[r.outcome] / ch[r.outcome] : null, prior: r.prior, rate });
  }
  return rows;
}

// The model from the rates: run expectancy (re), the home team's chance of winning (we) and the
// expected swing in it on the next play (swing, for leverage).
export function model(rateRows, innings = INNINGS) {
  const p = {};
  const run = {};
  const isRun = new Set(RUNNING.map((r) => r.outcome));
  for (const r of rateRows || []) (isRun.has(r.outcome) ? run : p)[r.outcome] = r.rate;
  const K = 25;
  const mv = [];
  for (let b = 0; b < 8; b++) for (let o = 0; o < 3; o++) mv[b * 3 + o] = moves(p, run, b, o);
  // dist[b*3+o][k] = chance of scoring exactly k more runs this half-inning from bases b with o outs.
  let dist = Array.from({ length: 24 }, () => new Array(K).fill(0));
  for (let it = 0; it < 300; it++) {
    const next = Array.from({ length: 24 }, () => new Array(K).fill(0));
    for (let b = 0; b < 8; b++) for (let o = 0; o < 3; o++) {
      const row = next[b * 3 + o];
      for (const s of mv[b * 3 + o]) {
        const no = o + s.outs;
        if (no >= 3) { row[Math.min(s.runs, K - 1)] += s.pr; continue; }
        const from = dist[s.b * 3 + no];
        for (let k = 0; k < K; k++) if (from[k]) row[Math.min(k + s.runs, K - 1)] += s.pr * from[k];
      }
    }
    dist = next;
  }
  const re = dist.map((d) => d.reduce((a, v, k) => a + v * k, 0));
  // Home team's chance of winning. d = home runs minus away runs.
  const N = innings;
  const MAXI = innings + 8;
  const memo = new Map();
  const clamp = (d) => Math.max(-30, Math.min(30, d));
  const startState = (i) => (i >= TIEBREAK_FROM ? 3 * 3 : 0); // runners on 1st and 2nd, no outs
  let top;
  let bot;
  const after = (i, d) => { // after the bottom of inning i
    if (i >= N && d !== 0) return d > 0 ? 1 : 0;
    if (RUN_RULE[i] && Math.abs(d) >= RUN_RULE[i]) return d > 0 ? 1 : 0;
    if (i >= MAXI) return 0.5;
    return top(i + 1, d);
  };
  const half = (i, isTop, s, d) => {
    const k0 = `${i}${isTop ? 't' : 'b'}${s}:${d}`;
    if (memo.has(k0)) return memo.get(k0);
    let v;
    if (Math.abs(d) > 25) v = d > 0 ? 1 : 0;
    // The home team doesn't need to finish (or start) the bottom half once it has won.
    else if (!isTop && ((i >= N && d > 0) || (RUN_RULE[i] && d >= RUN_RULE[i]))) v = 1;
    else {
      v = 0;
      const dd = dist[s];
      for (let k = 0; k < K; k++) if (dd[k]) v += dd[k] * (isTop ? bot(i, clamp(d - k)) : after(i, clamp(d + k)));
    }
    memo.set(k0, v);
    return v;
  };
  top = (i, d) => half(i, true, startState(i), d);
  bot = (i, d) => half(i, false, startState(i), d);
  const we = (i, isTop, b, o, d) => {
    if (o >= 3) return isTop ? bot(i, clamp(d)) : after(i, clamp(d));
    return half(i, isTop, b * 3 + o, clamp(d));
  };
  const swing = (i, isTop, b, o, d) => {
    const now = we(i, isTop, b, o, d);
    let s = 0;
    for (const m of mv[b * 3 + Math.min(o, 2)]) {
      const nd = d + (isTop ? -m.runs : m.runs);
      s += m.pr * Math.abs(we(i, isTop, m.b, o + m.outs, nd) - now);
    }
    return s;
  };
  return { re, we, swing, innings: N };
}

// Every play's values, keyed "game|event_seq": run expectancy before and after (RE24 = the change
// plus runs scored), the home team's chance of winning before and after, win probability added for
// the batting team (percentage points), leverage (1 = an average plate appearance), and on a play
// with an error, the "clean" values as if the fielder had made it. Also the RE table's observations.
export function valuePlays(pbp, m) {
  const by = new Map();
  for (const e of pbp) {
    if (!text(e.game_id) || num(e.event_seq) === null) continue;
    if (!by.has(text(e.game_id))) by.set(text(e.game_id), []);
    by.get(text(e.game_id)).push(e);
  }
  const out = new Map();
  const all = [];
  for (const [gid, list] of by) {
    list.sort((a, b) => num(a.event_seq) - num(b.event_seq));
    const last = list[list.length - 1];
    const finalAway = (num(last.away_score_before) ?? 0) + (text(last.half) === 'top' ? num(last.runs_on_play) ?? 0 : 0);
    const finalHome = (num(last.home_score_before) ?? 0) + (text(last.half) === 'bottom' ? num(last.runs_on_play) ?? 0 : 0);
    // Runs still to come in each half-inning, for the observed run expectancy.
    const rest = new Map();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      const hk = text(e.inning) + text(e.half);
      rest.set(i, (num(e.runs_on_play) ?? 0) + (i + 1 < list.length && text(list[i + 1].inning) + text(list[i + 1].half) === hk ? rest.get(i + 1) : 0));
    }
    list.forEach((e, i) => {
      const inning = num(e.inning) ?? 1;
      const isTop = text(e.half) === 'top';
      const code = text(e.event_code);
      const b0 = bits(e.runner_1b_before, e.runner_2b_before, e.runner_3b_before);
      const b1 = bits(e.runner_1b_after, e.runner_2b_after, e.runner_3b_after);
      const o0 = num(e.outs_before) ?? 0;
      const o1 = num(e.outs_after) ?? o0 + (num(e.outs_on_play) ?? 0);
      const runs = num(e.runs_on_play) ?? 0;
      const d0 = (num(e.home_score_before) ?? 0) - (num(e.away_score_before) ?? 0);
      const d1 = d0 + (isTop ? -runs : runs);
      const reB = m.re[b0 * 3 + Math.min(o0, 2)];
      const reA = o1 >= 3 ? 0 : m.re[b1 * 3 + o1];
      const weB = m.we(inning, isTop, b0, o0, d0);
      let weA = m.we(inning, isTop, b1, o1, d1);
      if (i === list.length - 1) weA = finalHome > finalAway ? 1 : finalHome < finalAway ? 0 : 0.5;
      const sign = isTop ? -1 : 1;
      // An error play is also valued as if the fielder had made it (the "clean" play): batter and
      // pitcher get that, and the fielder charged with the error gets the rest.
      let weC = weA;
      let reC = reA;
      let runsC = runs;
      if (code === 'K-PB' || code === 'K-WP') {
        // The batter struck out: value him as out, runners holding. The rest is the passed ball or wild pitch.
        const oC = o0 + 1;
        runsC = 0;
        weC = m.we(inning, isTop, b0, oC, d0);
        reC = oC >= 3 ? 0 : m.re[b0 * 3 + oC];
      } else if (text(e.error_fielder)) {
        const bn = text(e.bases_after_no_error).split(/\s+/);
        const bC = bits(bn[0] === '1' ? 1 : '', bn[1] === '2' ? 1 : '', bn[2] === '3' ? 1 : '');
        const oC = num(e.outs_after_no_error) ?? o1;
        runsC = num(e.runs_no_error) ?? 0;
        weC = m.we(inning, isTop, bC, oC, d0 + (isTop ? -runsC : runsC));
        reC = oC >= 3 ? 0 : m.re[bC * 3 + oC];
      }
      const v = {
        state: b0 * 3 + o0,
        basesBefore: baseLabel(b0),
        runsRest: rest.get(i),
        reBefore: reB,
        reAfter: reA,
        re24: reA - reB + runs,
        re24Clean: reC - reB + runsC,
        homeWeBefore: weB,
        homeWeAfter: weA,
        wpa: 100 * sign * (weA - weB),
        wpaClean: 100 * sign * (weC - weB),
        liRaw: m.swing(inning, isTop, b0, Math.min(o0, 2), d0),
        isPa: isPa(e),
        errorFielder: text(e.error_fielder),
        fielders: text(e.fielders),
        runner: text(e.runner),
      };
      out.set(`${gid}|${text(e.event_seq)}`, v);
      all.push(v);
    });
  }
  const pa = all.filter((v) => v.isPa);
  const avg = pa.length ? pa.reduce((a, v) => a + v.liRaw, 0) / pa.length : 1;
  for (const v of all) v.li = avg ? v.liRaw / avg : null;
  return out;
}

// Run expectancy by base and out state: the model's figure, and what actually followed in the play-by-play.
export function reTable(m, values) {
  const list = [...values.values()];
  return BASE_ORDER.map((b) => {
    const r = { bases: baseLabel(b), re: [], obs: [], n: [] };
    for (let o = 0; o < 3; o++) {
      const seen = list.filter((v) => v.state === b * 3 + o);
      r.re.push(m.re[b * 3 + o]);
      r.n.push(seen.length);
      r.obs.push(seen.length ? seen.reduce((a, v) => a + v.runsRest, 0) / seen.length : null);
    }
    return r;
  });
}

// Who each play's value goes to. Value is from the batting team's side; the fielding side gets it
// with the sign flipped. Plate appearances: the hitter and the pitcher share the clean play (as if
// made, or as a strikeout on a dropped third strike). Steals, caught stealing and pickoffs: the
// runner, against the pitcher and the first fielder listed (the catcher on a steal) half each.
// Passed balls: the catcher. Wild pitches and balks: the pitcher. The rest of a play (an error, the
// passed ball or wild pitch on a dropped third strike) goes to whoever made it, and to no one on the
// batting side: it shows as given away in the team totals.
// `p` is a play from model.js with its values in p.wp.
export function credits(p) {
  const v = p.wp;
  const out = [];
  if (!v) return out;
  const bt = p.team;
  const ft = p.opp;
  const fl = v.fielders.split(',').map((x) => x.trim()).filter(Boolean);
  const all = { wpa: v.wpa, re24: v.re24 };
  const clean = { wpa: v.wpaClean, re24: v.re24Clean };
  const extra = { wpa: all.wpa - clean.wpa, re24: all.re24 - clean.re24 };
  const give = (side, team, role, who, val, k = 1, more = {}) => out.push({ side, team, role, who, wpa: k * val.wpa, re24: k * val.re24, ...more });
  const code = p.code;
  if (p.isPa) {
    if (p.batter) give('bat', bt, 'Hitter', p.batter, clean, 1, { pa: 1, li: v.li });
    if (p.pitcher) give('field', ft, 'Pitcher', p.pitcher, clean, -1, { pa: 1, li: v.li });
    const to = v.errorFielder || (code === 'K-PB' ? fl[0] : code === 'K-WP' ? p.pitcher : null);
    if (to && (extra.wpa || extra.re24)) {
      give('bat', bt, 'Given', null, extra);
      give('field', ft, code === 'K-WP' ? 'Pitcher' : 'Fielder', to, extra, -1, { err: v.errorFielder ? 1 : 0 });
    }
    return out;
  }
  if (code === 'PR') return out;
  if (['SB', 'CS', 'CS-E', 'PK'].includes(code)) {
    if (v.runner) give('bat', bt, 'Runner', v.runner, clean); else give('bat', bt, 'Given', null, clean);
    const f = fl[0] && fl[0] !== p.pitcher ? fl[0] : null;
    if (p.pitcher) give('field', ft, 'Pitcher', p.pitcher, clean, f ? -0.5 : -1);
    if (f) give('field', ft, 'Fielder', f, clean, -0.5);
  } else {
    give('bat', bt, 'Given', null, clean);
    if (code === 'PB' && fl[0]) give('field', ft, 'Fielder', fl[0], clean, -1);
    else if (p.pitcher) give('field', ft, 'Pitcher', p.pitcher, clean, -1);
  }
  if (v.errorFielder && (extra.wpa || extra.re24)) {
    give('bat', bt, 'Given', null, extra);
    give('field', ft, 'Fielder', v.errorFielder, extra, -1, { err: 1 });
  }
  return out;
}

// One row per player in a game: win probability added for hitting, running, pitching and fielding
// (good for the player is positive), and the net in points and runs.
export function gamePlayers(plays) {
  const by = new Map();
  for (const p of plays) {
    for (const c of credits(p)) {
      if (!c.who) continue;
      const k = `${c.who}|${c.team}`;
      if (!by.has(k)) by.set(k, { who: c.who, team: c.team, pa: 0, liSum: 0, e: 0, hit: 0, run: 0, pit: 0, fld: 0, wpa: 0, re24: 0, roles: new Set() });
      const r = by.get(k);
      r.roles.add(c.role);
      if (c.role === 'Hitter') { r.pa += 1; r.liSum += c.li ?? 0; }
      if (c.err) r.e += 1;
      r[{ Hitter: 'hit', Runner: 'run', Pitcher: 'pit', Fielder: 'fld' }[c.role]] += c.wpa;
      r.wpa += c.wpa;
      r.re24 += c.re24;
    }
  }
  const ORDER = ['Hitter', 'Runner', 'Pitcher', 'Fielder'];
  return [...by.values()].map((r) => ({
    who: r.who, team: r.team, roles: ORDER.filter((x) => r.roles.has(x)).join(', '),
    pa: r.pa || null, avgLi: r.pa ? r.liSum / r.pa : null, e: r.e || null,
    hit: r.roles.has('Hitter') ? r.hit : null, run: r.roles.has('Runner') ? r.run : null,
    pit: r.roles.has('Pitcher') ? r.pit : null, fld: r.roles.has('Fielder') ? r.fld : null,
    wpa: r.wpa, re24: r.re24,
  })).sort((a, b) => b.wpa - a.wpa || a.who.localeCompare(b.who));
}

// For each team in a game: the value of every play while it batted (its hitters, its runners and what
// the other team gave away) and while it fielded (its pitchers and fielders).
export function gameTeams(plays) {
  const by = new Map();
  const row = (team) => {
    if (!by.has(team)) by.set(team, { team, bat: 0, hit: 0, run: 0, given: 0, fld: 0, pit: 0, fielders: 0, batRuns: 0, fldRuns: 0 });
    return by.get(team);
  };
  for (const p of plays) {
    if (!p.wp) continue;
    row(p.team).bat += p.wp.wpa;
    row(p.team).batRuns += p.wp.re24;
    row(p.opp).fld -= p.wp.wpa;
    row(p.opp).fldRuns -= p.wp.re24;
    for (const c of credits(p)) {
      const r = row(c.team);
      if (c.role === 'Hitter') r.hit += c.wpa;
      else if (c.role === 'Runner') r.run += c.wpa;
      else if (c.role === 'Given') r.given += c.wpa;
      else if (c.role === 'Pitcher') r.pit += c.wpa;
      else r.fielders += c.wpa;
    }
  }
  return [...by.values()];
}
