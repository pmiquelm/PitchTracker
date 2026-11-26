// The team dashboard's numbers (dashboard/model.js), from data shaped like the script sends it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, line, outcomeOf, arsenal, players, gameTitle, filterSession, outcomeCounts, byGame, countGrid, versus, better, atBatOrder } from '../dashboard/model.js';

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
  // At-bat order: the steal (event 3) happened during the home run's at-bat (event 4), so it comes after it.
  assert.deepEqual(plays.map((p) => [p.seq, p.code, p.isPa]), [[1, 'K', true], [2, '1B', true], [4, 'HR', true], [3, 'SB', false], [5, 'BB', true], [6, 'GO', true]]);
  // Names come from the scoresheet; pitches from the app, sorted
  assert.equal(plays[0].batter, 'Tournoux Syan');
  assert.deepEqual(plays[0].pitches.map((p) => p.result), ['called_strike', 'swinging_strike', 'called_strike']);
  assert.deepEqual(plays[1].pitches.map((p) => p.result), ['in_play']);
  assert.deepEqual(plays[2].pitches, [], 'the app had no third plate appearance');
  assert.deepEqual(plays.map((p) => p.video), [1292, null, 0, null, null, null]);
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

test('plate-appearance rates: quality at-bats, 1-1 strikes, putaways, quick outs, leadoff retired', () => {
  const q = (balls, strikes, action, result, extra = {}) => ({ type: 'FB', zone: 'IN', action, result, balls, strikes, inPa: null, paEnd: '', ...extra });
  const pa = (outcome, pitches, extra = {}) => ({ game: 'g', seq: 1, isPa: true, outcome, ab: !['BB'].includes(outcome), hit: outcome === '1B',
    bases: outcome === '1B' ? 1 : 0, rbi: 0, pitches, ...extra });
  const plays = [
    // 6 pitches: a quality at-bat even though it's an out; reached 2 strikes, not a putaway
    pa('OUT', [q(0, 0, 'TAKE', 'ball'), q(1, 0, 'TAKE', 'called_strike'), q(1, 1, 'FOUL', 'foul'), q(1, 2, 'TAKE', 'ball'), q(2, 2, 'TAKE', 'ball'), q(3, 2, 'IN_PLAY', 'in_play')], { leadoff: true }),
    // two 2-strike fouls: quality; strikeout = putaway
    pa('K', [q(0, 0, 'SWING', 'swinging_strike'), q(0, 1, 'SWING', 'swinging_strike'), q(0, 2, 'FOUL', 'foul'), q(0, 2, 'FOUL', 'foul'), q(0, 2, 'SWING', 'swinging_strike', { paEnd: 'strikeout' })]),
    // a walk: quality; out in 3 or fewer it isn't
    pa('BB', [q(0, 0, 'TAKE', 'ball'), q(1, 0, 'TAKE', 'ball'), q(2, 0, 'TAKE', 'ball'), q(3, 0, 'TAKE', 'ball', { paEnd: 'walk' })], { leadoff: true }),
    // a quick out, first pitch
    pa('OUT', [q(0, 0, 'IN_PLAY', 'in_play')]),
    // a plate appearance with no pitches recorded counts for results only
    pa('1B', []),
  ];
  const s = line(plays);
  assert.deepEqual([s.pa, s.tracked, s.qab, s.qabPct], [5, 4, 3, 0.75]);
  assert.deepEqual([s.ooPitches, s.ooStrikes], [1, 1], 'one pitch thrown at 1-1, a foul');
  assert.deepEqual([s.twokPas, s.putaways], [2, 1]);
  assert.deepEqual([s.quickOuts, s.leadoffs, s.leadoffOuts], [1, 2, 1]);
  assert.deepEqual([s.threeBall, s.pitch.freezes, s.pitch.twokSwings, s.pitch.twokWhiffs], [2, 0, 4, 1]);
  assert.equal(s.pitch.byType.FB.pitches, 16);
});

test('game by game in date order, the count grid and matchups', () => {
  const m = buildModel(sample());
  const rows = byGame(m.plays, m.games);
  assert.deepEqual(rows.map((r) => [r.label, r.line.pa]), [['04/11 G2', 5], ['05/01', 1]]);
  const grid = countGrid(m.plays.flatMap((p) => p.pitches));
  assert.equal(grid.length, 12);
  const first = grid.find((c) => c.balls === 0 && c.strikes === 0);
  assert.deepEqual([first.pitches, first.swingPct], [4, 0.5], "a ball in play and a foul at 0-0");
  const game = filterSession(m.plays, 'game');
  // Ace's batters, one row each, those with pitches recorded first; the team's pitchers against them.
  const vb = versus(game.filter((p) => p.pitcher === 'Ace'), 'batter');
  assert.deepEqual(vb.map((r) => [r.name, r.team, r.line.pa]), [['Leidinger Max', 'Skylarks', 1], ['Tournoux Syan', 'Skylarks', 1], ['Mannel Julius', 'Skylarks', 1]]);
  // A hitter against each pitcher: the Flamingos' batters only saw Our P.
  const vp = versus(game.filter((p) => p.team === 'Flamingos'), 'pitcher');
  assert.deepEqual(vp.map((r) => [r.name, r.team, r.line.pa]), [['Our P', 'Skylarks', 2]]);
  assert.equal(m.plays.find((p) => p.seq === 1 && p.half === 'top').leadoff, true);
  assert.equal(m.plays.find((p) => p.seq === 5).leadoff, true, 'first of the bottom half');
});

test('at-bat order: each plate appearance, then the plays during it; a third-out pickoff stays last', () => {
  const p = (seq, code, isPa, half = 'top') => ({ seq, code, isPa, inning: 1, half });
  const list = [p(1, '1B', true), p(2, 'SB', false), p(3, 'WP', false), p(4, 'FO', true), p(5, 'PK', false), p(6, 'K', true, 'bottom')];
  assert.deepEqual(atBatOrder(list).map((x) => x.code), ['1B', 'FO', 'SB', 'WP', 'PK', 'K']);
});

test('better: high is good unless lowGood, neutral and ties are neither', () => {
  assert.equal(better({}, 0.4, 0.3), 1);
  assert.equal(better({}, 0.2, 0.3), -1);
  assert.equal(better({ lowGood: true }, 0.2, 0.3), 1, "a hitter's whiff rate under the team's is good");
  assert.equal(better({ lowGood: true }, 0.4, 0.3), -1);
  assert.equal(better({ lowGood: true }, 0.3, 0.3), 0, 'equal is neither');
  assert.equal(better({}, 0.3, 0.3), 0);
  assert.equal(better({ neutral: true }, 0.9, 0.1), 0);
  assert.equal(better({}, null, 0.1), 0);
});
