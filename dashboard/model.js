// The team dashboard's numbers: no DOM, no network, so tests can run it on sample data.
//
// Everything is built from "plays". A game with a transcribed scoresheet (the PlayByPlay tab)
// takes its plays from there, base-running plays included, and each plate appearance gets its
// pitches from the app (same game ID, then the n-th plate appearance of each half-inning, as the
// claude.ai dashboard matches them). A game only the app recorded (and every live BP session)
// takes its plate appearances from the PlateAppearances tab and its pitches from Pitches.

import { gameDate, gameNumber, PA_RESULTS } from '../js/game.js';
import { rates as wpRates, model as wpModel, valuePlays, reTable } from './winprob.js';

export const NO_TEAM = 'No team entered';

const text = (v) => String(v ?? '').trim();
const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const yes = (v) => v === true || v === 1 || text(v) === '1' || text(v).toUpperCase() === 'TRUE';
const team = (v) => text(v) || NO_TEAM;

// {cols, rows} from the script → objects by column name.
export function objects(tab) {
  const cols = tab?.cols || [];
  return (tab?.rows || []).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

function groupBy(list, keyOf) {
  const m = new Map();
  for (const x of list) {
    const k = keyOf(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

// What a play's code means for the batting line. Scoresheet codes (K-PB, ROE, SF…) and the
// app's (SAC_FLY, E_GROUND…) both land here.
export function outcomeOf(code) {
  const c = text(code).toUpperCase();
  if (!c) return '';
  if (/^K(\b|-|$)/.test(c)) return 'K';
  if (c === 'BB' || c === 'IBB') return 'BB';
  if (c === 'HBP') return 'HBP';
  if (['1B', '2B', '3B', 'HR'].includes(c)) return c;
  if (c === 'SF' || c === 'SAC_FLY') return 'SF';
  if (c === 'SH' || c === 'SAC_BUNT') return 'SH';
  if (c === 'CI') return 'CI';
  if (c === 'ROE' || c === 'E' || /^E_/.test(c)) return 'ROE';
  if (c === 'FC') return 'FC';
  return 'OUT';
}

const BASES = { '1B': 1, '2B': 2, '3B': 3, HR: 4 };
const NOT_AB = ['BB', 'HBP', 'SF', 'SH', 'CI'];

export const OUTCOME_LABELS = {
  '1B': 'Single', '2B': 'Double', '3B': 'Triple', HR: 'Home run', BB: 'Walk', HBP: 'Hit by pitch',
  K: 'Strikeout', OUT: 'Out', ROE: 'Reached on error', FC: "Fielder's choice", SF: 'Sac fly', SH: 'Sac bunt',
  CI: "Catcher's interference",
};

function pitchOf(p) {
  return {
    type: text(p.pitch_type),
    zone: text(p.zone),
    action: text(p.action),
    result: text(p.result),
    balls: num(p.balls_before),
    strikes: num(p.strikes_before),
    inPa: num(p.pitch_in_pa),
    paEnd: text(p.pa_end), // 'strikeout' or 'walk' on the pitch that ended the plate appearance
  };
}

const halfKey = (inning, half) => `${text(inning)}|${text(half).toLowerCase()}`;

export function buildModel(data) {
  const pbp = objects(data.pbp);
  const appPas = objects(data.pas);
  const appPitches = objects(data.pitches);
  const videoLinks = data.videos || {};

  // A time counts only if the play at that number is still the one that was stamped.
  const videoAt = new Map();
  for (const v of objects(data.videoTimes)) {
    const sec = num(v.seconds);
    if (sec !== null && sec >= 0) {
      videoAt.set(`${text(v.game_id)}|${text(v.event_seq)}`, { sec, check: `${text(v.event_code)}|${text(v.batter)}` });
    }
  }

  const pitchesByPa = groupBy(appPitches, (p) => `${text(p.game_id)}|${text(p.pa_number)}`);
  for (const list of pitchesByPa.values()) {
    list.sort((a, b) => (num(a.pitch_in_pa) ?? 0) - (num(b.pitch_in_pa) ?? 0) || (num(a.pitch_number) ?? 0) - (num(b.pitch_number) ?? 0));
  }
  const pitchesFor = (game, pa) => (pitchesByPa.get(`${game}|${text(pa)}`) || []).map(pitchOf);
  // The pitch that ended a strikeout or walk carries pa_end; rows that lack it get it from the result.
  const finish = (pitches, out) => {
    const last = pitches[pitches.length - 1];
    if (last && !pitches.some((q) => q.paEnd)) {
      if (out === 'K' && ['called_strike', 'swinging_strike'].includes(last.result)) last.paEnd = 'strikeout';
      if (out === 'BB' && last.result === 'ball') last.paEnd = 'walk';
    }
    return pitches;
  };

  // Run and win values for every scoresheet play (winprob.js).
  const rateRows = wpRates(pbp, appPas);
  const runModel = wpModel(rateRows);
  const values = valuePlays(pbp, runModel);

  const plays = [];
  const pbpByGame = groupBy(pbp.filter((e) => text(e.game_id)), (e) => text(e.game_id));
  const appPasByGame = groupBy(appPas.filter((p) => text(p.game_id)), (p) => text(p.game_id));

  // ---- games with a scoresheet ----
  for (const [game, events] of pbpByGame) {
    events.sort((a, b) => (num(a.event_seq) ?? 0) - (num(b.event_seq) ?? 0));
    const app = (appPasByGame.get(game) || []).filter((p) => text(p.result))
      .sort((a, b) => (num(a.pa_number) ?? 0) - (num(b.pa_number) ?? 0));
    const appByHalf = groupBy(app, (p) => halfKey(p.inning, p.half));
    const seen = new Map();
    for (const e of events) {
      const isPa = yes(e.is_pa);
      let pitches = [];
      if (isPa) {
        const k = halfKey(e.inning, e.half);
        const i = seen.get(k) || 0;
        seen.set(k, i + 1);
        const a = (appByHalf.get(k) || [])[i];
        if (a) pitches = pitchesFor(game, a.pa_number);
      }
      const code = text(e.event_code);
      const t = videoAt.get(`${game}|${text(e.event_seq)}`);
      const out = isPa ? outcomeOf(code) : '';
      finish(pitches, out);
      plays.push({
        game,
        seq: num(e.event_seq),
        inning: num(e.inning),
        half: text(e.half).toLowerCase(),
        team: team(e.batting_team),
        opp: team(e.fielding_team),
        batter: text(e.batter),
        pitcher: text(e.pitcher),
        code,
        desc: text(e.event_desc) || OUTCOME_LABELS[out] || code,
        isPa,
        outcome: out,
        ab: isPa && (e.is_ab === '' || e.is_ab === undefined ? !NOT_AB.includes(out) : yes(e.is_ab)),
        hit: isPa && (e.is_hit === '' || e.is_hit === undefined ? out in BASES : yes(e.is_hit)),
        bases: isPa ? (num(e.bases) ?? BASES[out] ?? 0) : 0,
        rbi: num(e.rbi) ?? 0,
        runs: num(e.runs_on_play) ?? 0,
        outsBefore: num(e.outs_before),
        basesBefore: text(e.base_state_before),
        awayBefore: num(e.away_score_before),
        homeBefore: num(e.home_score_before),
        pitches,
        video: t && t.check === `${code}|${text(e.batter)}` ? t.sec : null,
        session: 'game',
        source: 'pbp',
        wp: values.get(`${game}|${text(e.event_seq)}`) || null,
      });
    }
  }

  // ---- games and live BP only the app recorded ----
  for (const [game, pas] of appPasByGame) {
    if (pbpByGame.has(game)) continue;
    pas.sort((a, b) => (num(a.pa_number) ?? 0) - (num(b.pa_number) ?? 0));
    for (const p of pas) {
      const code = text(p.result);
      const out = outcomeOf(code);
      plays.push(appPlay(game, p, code, out, finish(pitchesFor(game, p.pa_number), out)));
    }
  }
  // Pitches whose plate appearance has no row (still going, or never finished): they count
  // for the pitch numbers, not for results.
  const hasPa = new Set(appPas.map((p) => `${text(p.game_id)}|${text(p.pa_number)}`));
  for (const [k, list] of pitchesByPa) {
    const game = text(list[0].game_id);
    if (!game || hasPa.has(k) || pbpByGame.has(game)) continue;
    plays.push(appPlay(game, list[0], '', '', list.map(pitchOf)));
  }

  return {
    plays,
    games: buildGames(plays, videoLinks),
    runModel: { rates: rateRows, re: reTable(runModel, values) },
  };
}

function appPlay(game, row, code, out, pitches) {
  return {
    game,
    seq: num(row.pa_number),
    inning: num(row.inning),
    half: text(row.half).toLowerCase(),
    team: team(row.batting_team),
    opp: team(row.pitching_team),
    batter: text(row.batter),
    pitcher: text(row.pitcher),
    code,
    desc: text(row.result_label) || PA_RESULTS[code]?.label || OUTCOME_LABELS[out] || (code ? code : 'Not finished'),
    isPa: !!out,
    outcome: out,
    ab: !!out && !NOT_AB.includes(out),
    hit: out in BASES,
    bases: BASES[out] || 0,
    rbi: 0,
    runs: 0,
    outsBefore: null,
    basesBefore: '',
    awayBefore: null,
    homeBefore: null,
    pitches,
    video: null,
    session: text(row.session_type) === 'bp' ? 'bp' : 'game',
    source: 'app',
    wp: null,
  };
}

// Newest first; doubleheaders by game number.
export function compareGames(a, b) {
  return (b.date || '').localeCompare(a.date || '') || (b.number ?? 0) - (a.number ?? 0) || b.id.localeCompare(a.id);
}

function buildGames(plays, videoLinks) {
  const byGame = groupBy(plays, (p) => p.game);
  const games = [];
  for (const [id, list] of byGame) {
    const pbp = list[0].source === 'pbp';
    const teams = [];
    for (const p of list) for (const t of [p.team, p.opp]) if (t !== NO_TEAM && !teams.includes(t)) teams.push(t);
    let away = null;
    let home = null;
    let score = null;
    if (pbp) {
      const top = list.find((p) => p.half === 'top');
      const bottom = list.find((p) => p.half === 'bottom');
      away = top?.team ?? bottom?.opp ?? null;
      home = top?.opp ?? bottom?.team ?? null;
      const last = list[list.length - 1];
      if (last.awayBefore !== null && last.homeBefore !== null) {
        score = {
          away: last.awayBefore + (last.half === 'top' ? last.runs : 0),
          home: last.homeBefore + (last.half === 'bottom' ? last.runs : 0),
        };
      }
    }
    games.push({
      id,
      date: gameDate(id),
      number: gameNumber(id),
      title: gameTitle(id),
      session: list[0].session,
      teams,
      away,
      home,
      score,
      video: videoLinks[id] || null,
      timed: list.filter((p) => p.video !== null).length,
      source: list[0].source,
      plays: list,
    });
  }
  return games.sort(compareGames);
}

// "2026-04-11- @ FLAMINGOS GAME 2" → "@ FLAMINGOS GAME 2".
export function gameTitle(id) {
  const rest = String(id).replace(/^\s*\d{4}-\d{2}-\d{2}[\s\-_.:]*/, '').trim();
  return rest || String(id);
}

// ---- stats ----

const SWINGS = ['SWING', 'FOUL', 'IN_PLAY'];
const ratio = (a, b) => (b > 0 ? a / b : null);

export function pitchNumbers(pitches) {
  const n = { pitches: 0, balls: 0, inZone: 0, outZone: 0, swings: 0, whiffs: 0, called: 0, chases: 0, first: 0, firstStrikes: 0 };
  for (const p of pitches) {
    n.pitches++;
    const ball = p.result === 'ball';
    if (ball) n.balls++;
    if (p.zone === 'IN') n.inZone++;
    if (p.zone === 'OUT') n.outZone++;
    const swing = SWINGS.includes(p.action);
    if (swing) n.swings++;
    if (p.action === 'SWING') n.whiffs++;
    if (p.result === 'called_strike') n.called++;
    if (swing && p.zone === 'OUT') n.chases++;
    if (p.inPa === 1 || (p.inPa === null && p.balls === 0 && p.strikes === 0)) {
      n.first++;
      if (!ball) n.firstStrikes++;
    }
  }
  return {
    ...n,
    strikePct: ratio(n.pitches - n.balls, n.pitches),
    zonePct: ratio(n.inZone, n.pitches),
    swingPct: ratio(n.swings, n.pitches),
    whiffPct: ratio(n.whiffs, n.swings),
    chasePct: ratio(n.chases, n.outZone),
    cswPct: ratio(n.called + n.whiffs, n.pitches),
    firstStrikePct: ratio(n.firstStrikes, n.first),
  };
}

// A batting line from plays (the batter's, or those a pitcher faced). Only finished plate
// appearances count; their pitches go into the pitch numbers.
export function line(plays) {
  const pas = plays.filter((p) => p.isPa);
  const c = (o) => pas.filter((p) => p.outcome === o).length;
  const s = {
    games: new Set(plays.map((p) => p.game)).size,
    pa: pas.length,
    ab: pas.filter((p) => p.ab).length,
    h: pas.filter((p) => p.hit).length,
    d: c('2B'),
    t: c('3B'),
    hr: c('HR'),
    bb: c('BB'),
    hbp: c('HBP'),
    k: c('K'),
    sf: c('SF'),
    rbi: pas.reduce((x, p) => x + p.rbi, 0),
    tb: pas.reduce((x, p) => x + (p.hit ? p.bases : 0), 0),
  };
  s.avg = ratio(s.h, s.ab);
  s.obp = ratio(s.h + s.bb + s.hbp, s.ab + s.bb + s.hbp + s.sf);
  s.slg = ratio(s.tb, s.ab);
  s.kPct = ratio(s.k, s.pa);
  s.bbPct = ratio(s.bb, s.pa);
  s.lookingK = pas.filter((p) => p.outcome === 'K' && p.pitches.length
    && p.pitches[p.pitches.length - 1].result === 'called_strike').length;
  s.pitch = pitchNumbers(plays.flatMap((p) => p.pitches));
  s.perPa = ratio(pas.reduce((x, p) => x + p.pitches.length, 0), pas.filter((p) => p.pitches.length).length);
  return s;
}

export function outcomeCounts(plays) {
  const counts = new Map();
  for (const p of plays) if (p.isPa) counts.set(p.outcome, (counts.get(p.outcome) || 0) + 1);
  return Object.keys(OUTCOME_LABELS).filter((o) => counts.get(o))
    .map((o) => ({ outcome: o, label: OUTCOME_LABELS[o], count: counts.get(o) }));
}

// Each pitch type a pitcher (or the pitches a hitter saw) has, most used first.
export function arsenal(pitches) {
  const total = pitches.length;
  return [...groupBy(pitches.filter((p) => p.type), (p) => p.type)]
    .map(([type, list]) => ({ type, usage: ratio(list.length, total), ...pitchNumbers(list) }))
    .sort((a, b) => b.pitches - a.pitches);
}

// Everyone who batted (role 'batter', grouped by the batting team) or pitched (role 'pitcher',
// by the fielding team), with their line, most plate appearances first.
export function players(plays, role) {
  const nameOf = (p) => (role === 'batter' ? p.batter : p.pitcher);
  const teamOf = (p) => (role === 'batter' ? p.team : p.opp);
  const groups = groupBy(plays.filter((p) => nameOf(p)), (p) => `${teamOf(p)}\u0000${nameOf(p)}`);
  return [...groups].map(([key, list]) => ({ key, team: teamOf(list[0]), name: nameOf(list[0]), plays: list, line: line(list) }))
    .sort((a, b) => a.team.localeCompare(b.team) || b.line.pa - a.line.pa || a.name.localeCompare(b.name));
}

export function filterSession(plays, session) {
  return session === 'all' ? plays : plays.filter((p) => p.session === session);
}
