// The team dashboard's numbers (dashboard/model.js), from data shaped like the script sends it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, line, outcomeOf, arsenal, players, gameTitle, filterSession, outcomeCounts } from '../dashboard/model.js';

const tab = (cols, rows) => ({ cols, rows: rows.map((r) => cols.map((c) => r[c] ?? '')) });
const PBP_COLS = ['game_id', 'date', 'event_seq', 'inning', 'half', 'batting_team', 'fielding_team', 'batter', 'pitcher',
  'event_code', 'event_desc', 'is_pa', 'is_ab', 'is_hit', 'bases', 'rbi', 'runs_on_play', 'away_score_before', 'home_score_before'];
const PITCH_COLS = ['game_id', 'inning', 'half', 'pa_number', 'pitch_number', 'pitch_in_pa', 'batter', 'pitcher',
  'balls_before', 'strikes_before', 'pitch_type', 'zone', 'action', 'result', 'session_type'];
const PA_COLS = ['game_id', 'inning', 'half', 'batting_team', 'pitching_team', 'pa_number', 'batter', 'pitcher', 'result',
  'result_label', 'category', 'session_type'];

const G = '2026-04-11- @ FLAMINGOS GAME 2';
const ev = (seq, half, batter, code, extra = {}) => ({
  game_id: G, date: '2026-04-11', event_seq: seq, inning: 1, half,
  batting_team: half === 'top' ? 'Skylarks' : 'Flamingos', fielding_team: half === 'top' ? 'Flamingos' : 'Skylarks',
  batter, pitcher: half === 'top' ? 'Ace' : 'Our P', event_code: code, event_desc: code, is_pa: 1,
  is_ab: ['BB', 'HBP', 'SF'].includes(code) ? 0 : 1, is_hit: ['1B', '2B', 'HR'].includes(code) ? 1 : 0,
  bases: { '1B': 1, '2B': 2, HR: 4 }[code] ?? 0, rbi: 0, runs_on_play: 0, away_score_before: 0, home_score_before: 0, ...extra,
});
const pitch = (game, pa, n, type, zone, action, result, extra = {}) => ({
  game_id: game, inning: 1, half: 'top', pa_number: pa, pitch_in_pa: n, pitch_number: n, pitch_type: type, zone, action, result,
  balls_before: 0, strikes_before: 0, session_type: 'game', ...extra,
});

function sample() {
  return {
    pbp: tab(PBP_COLS, [
      ev(2, 'top', 'Leidinger Max', '1B'),
      ev(1, 'top', 'Tournoux Syan', 'K'),
      ev(3, 'top', 'Leidinger Max', 'SB', { is_pa: 0, is_ab: 0, event_desc: 'Leidinger M steals 2B' }),
      ev(4, 'top', 'Mannel Julius', 'HR', { rbi: 2, runs_on_play: 2 }),
      ev(5, 'bottom', 'Speck', 'BB', { away_score_before: 2 }),
      ev(6, 'bottom', 'Gimon', 'GO', { away_score_before: 2, runs_on_play: 1 }),
    ]),
    // The app recorded the first two top-half plate appearances of that game (and a BP session).
    pas: tab(PA_COLS, [
      { game_id: G, inning: 1, half: 'top', pa_number: 1, batter: 'Syan', result: 'K' },
      { game_id: G, inning: 1, half: 'top', pa_number: 2, batter: 'Max', result: '1B' },
      { game_id: '2026-05-01 BP', inning: '', half: '', batting_team: 'Skylarks', pitching_team: 'Skylarks', pa_number: 1, batter: 'Max', pitcher: 'Our P', result: 'BB', session_type: 'bp' },
    ]),
    pitches: tab(PITCH_COLS, [
      pitch(G, 1, 2, 'CB', 'OUT', 'SWING', 'swinging_strike', { strikes_before: 1 }),
      pitch(G, 1, 1, 'FB', 'IN', 'TAKE', 'called_strike'),
      pitch(G, 1, 3, 'FB', 'IN', 'TAKE', 'called_strike', { strikes_before: 2 }),
      pitch(G, 2, 1, 'FB', 'IN', 'IN_PLAY', 'in_play'),
      pitch('2026-05-01 BP', 1, 1, 'FB', 'OUT', 'TAKE', 'ball', { session_type: 'bp' }),
      pitch('2026-05-01 BP', 2, 1, 'CB', 'IN', 'FOUL', 'foul', { session_type: 'bp' }), // PA still going: no PA row
    ]),
    videoTimes: tab(['game_id', 'event_seq', 'event_code', 'batter', 'seconds'], [
      { game_id: G, event_seq: 1, event_code: 'K', batter: 'Tournoux Syan', seconds: 1292 },
      // Stamped on a play that has changed since: not linked
      { game_id: G, event_seq: 2, event_code: 'WP', batter: 'Leidinger Max', seconds: 1400 },
      { game_id: G, event_seq: 4, event_code: 'HR', batter: 'Mannel Julius', seconds: 0 },
    ]),
    videos: { [G]: 'https://www.youtube.com/watch?v=VAInWKzHcfA' },
  };
}

test('scoresheet games: plays in order, app pitches matched by half-inning order, checked video times', () => {
  const m = buildModel(sample());
  const plays = m.plays.filter((p) => p.game === G);
  assert.deepEqual(plays.map((p) => [p.seq, p.code, p.isPa]), [[1, 'K', true], [2, '1B', true], [3, 'SB', false], [4, 'HR', true], [5, 'BB', true], [6, 'GO', true]]);
  // Names come from the scoresheet; pitches from the app, sorted
  assert.equal(plays[0].batter, 'Tournoux Syan');
  assert.deepEqual(plays[0].pitches.map((p) => p.result), ['called_strike', 'swinging_strike', 'called_strike']);
  assert.deepEqual(plays[1].pitches.map((p) => p.result), ['in_play']);
  assert.deepEqual(plays[3].pitches, [], 'the app had no third plate appearance');
  assert.deepEqual(plays.map((p) => p.video), [1292, null, null, 0, null, null]);
  const g = m.games.find((x) => x.id === G);
  assert.deepEqual([g.away, g.home, g.score, g.timed, g.video, g.source], ['Skylarks', 'Flamingos', { away: 2, home: 1 }, 2,
    'https://www.youtube.com/watch?v=VAInWKzHcfA', 'pbp']);
  assert.equal(g.title, '@ FLAMINGOS GAME 2');
});

test('app-only sessions: plate appearances from the app, unfinished ones count for pitches only', () => {
  const m = buildModel(sample());
  const bp = m.plays.filter((p) => p.game === '2026-05-01 BP');
  assert.deepEqual(bp.map((p) => [p.outcome, p.isPa, p.session, p.pitches.length]), [['BB', true, 'bp', 1], ['', false, 'bp', 1]]);
  assert.equal(m.games.find((g) => g.id === '2026-05-01 BP').session, 'bp');
  assert.deepEqual(m.games.map((g) => g.id), ['2026-05-01 BP', G], 'newest first');
  assert.equal(filterSession(m.plays, 'game').every((p) => p.session === 'game'), true);
  assert.equal(filterSession(m.plays, 'all').length, m.plays.length);
});

test('batting and pitching lines', () => {
  const m = buildModel(sample());
  const games = filterSession(m.plays, 'game');
  const top = line(games.filter((p) => p.half === 'top'));
  assert.deepEqual([top.pa, top.ab, top.h, top.hr, top.k, top.rbi, top.tb], [3, 3, 2, 1, 1, 2, 5]);
  assert.equal(top.avg, 2 / 3);
  assert.equal(top.slg, 5 / 3);
  assert.equal(top.lookingK, 1, 'strike three was called');
  assert.deepEqual([top.pitch.pitches, top.pitch.swings, top.pitch.whiffs, top.pitch.chases, top.pitch.first, top.pitch.firstStrikes],
    [4, 2, 1, 1, 2, 2]);
  assert.equal(top.pitch.cswPct, 3 / 4);
  const bottom = line(games.filter((p) => p.half === 'bottom'));
  assert.deepEqual([bottom.pa, bottom.ab, bottom.bb, bottom.obp], [2, 1, 1, 0.5]);

  const pitchers = players(games, 'pitcher');
  assert.deepEqual(pitchers.map((p) => [p.team, p.name, p.line.pa]), [['Flamingos', 'Ace', 3], ['Skylarks', 'Our P', 2]]);
  const hitters = players(games, 'batter');
  assert.deepEqual(hitters.filter((p) => p.name === 'Leidinger Max').map((p) => p.line.pa), [1], 'a stolen base is not a plate appearance');
  assert.deepEqual(outcomeCounts(games).map((c) => [c.outcome, c.count]), [['1B', 1], ['HR', 1], ['BB', 1], ['K', 1], ['OUT', 1]]);
});

test('arsenal by pitch type', () => {
  const m = buildModel(sample());
  const rows = arsenal(filterSession(m.plays, 'game').flatMap((p) => p.pitches));
  assert.deepEqual(rows.map((r) => [r.type, r.pitches, r.usage]), [['FB', 3, 0.75], ['CB', 1, 0.25]]);
  assert.equal(rows[1].chasePct, 1);
});

test('result codes from scoresheets and from the app mean the same thing', () => {
  const cases = { K: 'K', 'K-PB': 'K', 'K-WP': 'K', BB: 'BB', IBB: 'BB', HBP: 'HBP', '1B': '1B', HR: 'HR', SF: 'SF', SAC_FLY: 'SF',
    SH: 'SH', SAC_BUNT: 'SH', ROE: 'ROE', E_GROUND: 'ROE', FC: 'FC', GO: 'OUT', DP: 'OUT', PO: 'OUT', OUT_RULE: 'OUT', '': '' };
  for (const [code, want] of Object.entries(cases)) assert.equal(outcomeOf(code), want, code);
});

test('game titles drop the date', () => {
  assert.equal(gameTitle('2026-04-11- @ FLAMINGOS GAME 2'), '@ FLAMINGOS GAME 2');
  assert.equal(gameTitle('2026-05-30 vs Braunschweig'), 'vs Braunschweig');
  assert.equal(gameTitle('Friendly'), 'Friendly');
});

test('an empty sheet gives an empty dashboard', () => {
  const m = buildModel({ pbp: { cols: [], rows: [] }, pas: { cols: [], rows: [] }, pitches: { cols: [], rows: [] }, videoTimes: { cols: [], rows: [] }, videos: {} });
  assert.deepEqual([m.plays, m.games], [[], []]);
});
