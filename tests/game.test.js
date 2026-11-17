import test from 'node:test';
import assert from 'node:assert/strict';
import { replay, buildPitchRow, pitchResult, initialState } from '../js/game.js';

const game = {
  key: 'g1', gameId: 'TEST-1', pitcher: 'Ace',
  lineup: [{ number: '1', name: 'A' }, { number: '2', name: 'B' }, { number: '3', name: 'C' }],
};

let seq = 0;
const ev = (type, data = {}, extra = {}) => ({ id: `e${++seq}`, seq, type, data, deleted: 0, ...extra });
const p = (pitchType, zone, action) => ev('pitch', { pitchType, zone, action });

test('pitch results', () => {
  assert.equal(pitchResult('IN', 'TAKE'), 'called_strike');
  assert.equal(pitchResult('OUT', 'TAKE'), 'ball');
  assert.equal(pitchResult('OUT', 'SWING'), 'swinging_strike');
  assert.equal(pitchResult('IN', 'FOUL'), 'foul');
  assert.equal(pitchResult('OUT', 'IN_PLAY'), 'in_play');
});

test('count builds up and fouls do not make strike three', () => {
  const s = replay(game, [p('FB', 'OUT', 'TAKE'), p('CB', 'IN', 'TAKE'), p('FB', 'IN', 'FOUL'), p('FB', 'IN', 'FOUL'), p('FB', 'IN', 'FOUL')]);
  assert.deepEqual([s.balls, s.strikes, s.teams[0].slot, s.pitchInPa], [1, 2, 0, 5]);
});

test('strikeout advances to next batter', () => {
  const s = replay(game, [p('FB', 'IN', 'TAKE'), p('FB', 'OUT', 'SWING'), p('CB', 'IN', 'SWING')]);
  assert.deepEqual([s.balls, s.strikes, s.teams[0].slot, s.paNumber, s.lastPaEnd], [0, 0, 1, 2, 'strikeout']);
});

test('walk advances to next batter', () => {
  const s = replay(game, Array.from({ length: 4 }, () => p('FB', 'OUT', 'TAKE')));
  assert.deepEqual([s.teams[0].slot, s.paNumber, s.lastPaEnd], [1, 2, 'walk']);
});

test('ball in play advances and lineup wraps around', () => {
  const bip = () => [p('FB', 'IN', 'IN_PLAY'), ev('outcome', { category: 'hit', result: '1B' })];
  const s = replay(game, [...bip(), ...bip(), ...bip()]);
  assert.deepEqual([s.teams[0].slot, s.paNumber, s.pitchNumber], [0, 4, 3]);
});

test('deleted (undone) events are ignored', () => {
  const s = replay(game, [p('FB', 'IN', 'TAKE'), { ...p('FB', 'IN', 'IN_PLAY'), deleted: 1 }]);
  assert.deepEqual([s.strikes, s.teams[0].slot], [1, 0]);
});

test('substitution, pitcher change, set batter, inning', () => {
  const s = replay(game, [
    p('FB', 'IN', 'TAKE'),
    ev('sub', { slot: 1, name: 'B2', number: '22' }),
    ev('pitcher', { name: 'Reliever' }),
    ev('setBatter', { slot: 2 }),
    ev('inning', { delta: 1 }),
    ev('inning', { delta: -5 }),
  ]);
  assert.equal(s.teams[0].lineup[1].name, 'B2');
  assert.equal(s.teams[0].pitcher, 'Reliever');
  assert.equal(s.teams[0].pitcherPitches, 0);
  assert.deepEqual([s.teams[0].slot, s.strikes, s.paNumber, s.inning], [2, 0, 2, 1]);
});

test('manual next batter', () => {
  const s = replay(game, [p('FB', 'OUT', 'TAKE'), ev('nextBatter')]);
  assert.deepEqual([s.teams[0].slot, s.balls, s.paNumber, s.lastPaEnd], [1, 0, 2, 'manual']);
});

test('pitch row captures state before the pitch', () => {
  const before = replay(game, [p('FB', 'OUT', 'TAKE'), p('FB', 'IN', 'TAKE')]);
  const row = buildPitchRow(game, before, { pitchType: 'CB', zone: 'OUT', action: 'SWING' }, { id: 'x', createdAt: 0 });
  assert.equal(row.balls_before, 1);
  assert.equal(row.strikes_before, 1);
  assert.equal(row.pitch_in_pa, 3);
  assert.equal(row.pitch_number, 3);
  assert.equal(row.batter, 'A');
  assert.equal(row.result, 'swinging_strike');
  assert.equal(row.pa_end, '');
  assert.equal(row.game_id, 'TEST-1');
  assert.equal(initialState(game).teams[0].pitcher, 'Ace');
});

// ---- two teams, outs and outcomes ----
import {
  OUTCOME_TREE, PA_RESULTS, PITCH_COLUMNS, PA_COLUMNS, battingIndex, battingTeam, currentBatter,
  pitchPaRow, outcomePaRow, nextBatterPaRow,
} from '../js/game.js';
import { readFileSync } from 'node:fs';

const game2 = {
  key: 'g2', gameId: 'TEST-2',
  teams: [
    { name: 'Away', pitcher: 'AwayAce', lineup: [{ number: '1', name: 'A1' }, { number: '2', name: 'A2' }, { number: '3', name: 'A3' }] },
    { name: 'Home', pitcher: 'HomeAce', lineup: [{ number: '7', name: 'H1' }, { number: '8', name: 'H2' }] },
  ],
};
const inPlay = () => p('FB', 'IN', 'IN_PLAY');
const outcome = (category, result, fielder = '') => ev('outcome', { category, result, fielder });
const k = () => [p('FB', 'IN', 'TAKE'), p('FB', 'IN', 'TAKE'), p('FB', 'IN', 'TAKE')];

test('a ball in play waits for its outcome before the next batter', () => {
  const s = replay(game2, [inPlay()]);
  assert.ok(s.pending);
  assert.equal(currentBatter(s).name, 'A1');
  assert.equal(s.pitchInPa, 1);
  const s2 = replay(game2, [inPlay(), outcome('hit', '2B', 'CF')]);
  assert.equal(s2.pending, null);
  assert.equal(currentBatter(s2).name, 'A2');
  assert.deepEqual([s2.outs, s2.paNumber, s2.lastPaEnd], [0, 2, 'in_play']);
});

test('outs from outcomes; three outs switch to the other team', () => {
  const s = replay(game2, [inPlay(), outcome('out', 'GO', 'SS'), ...k()]);
  assert.deepEqual([s.outs, s.half, battingIndex(s)], [2, 'top', 0]);
  const s2 = replay(game2, [inPlay(), outcome('out', 'GO'), ...k(), inPlay(), outcome('sac', 'SAC_FLY', 'RF')]);
  assert.deepEqual([s2.outs, s2.half, s2.inning, s2.lastHalfEnd], [0, 'bottom', 1, true]);
  assert.equal(battingTeam(s2).name, 'Home');
  assert.equal(currentBatter(s2).name, 'H1');
  // Each team keeps its own place in the order
  assert.equal(s2.teams[0].slot, 0); // A1, A2, A3 batted; wraps to A1
});

test('double play counts two outs, errors and hits none, FC one', () => {
  assert.equal(replay(game2, [inPlay(), outcome('out', 'DP')]).outs, 2);
  assert.equal(replay(game2, [inPlay(), outcome('error', 'E_GROUND', 'SS')]).outs, 0);
  assert.equal(replay(game2, [inPlay(), outcome('fc', 'FC')]).outs, 1);
  assert.equal(replay(game2, [inPlay(), outcome('hit', 'HR')]).outs, 0);
});

test('half-innings alternate and the inning goes up after the bottom', () => {
  const threeOuts = () => [ev('outs', { delta: 1 }), ev('outs', { delta: 1 }), ev('outs', { delta: 1 })];
  const s = replay(game2, [...threeOuts(), ...threeOuts()]);
  assert.deepEqual([s.inning, s.half, battingIndex(s)], [2, 'top', 0]);
  const back = replay(game2, [...threeOuts(), ev('half', { delta: -1 }), ev('half', { delta: -1 })]);
  assert.deepEqual([back.inning, back.half], [1, 'top']);
});

test('pitcher counts belong to the fielding team', () => {
  const s = replay(game2, [p('FB', 'OUT', 'TAKE'), p('FB', 'OUT', 'TAKE'), ev('half', { delta: 1 }), p('CB', 'OUT', 'TAKE')]);
  assert.equal(s.teams[1].pitcherPitches, 2); // home pitcher threw to the away team
  assert.equal(s.teams[0].pitcherPitches, 1);
  const row = buildPitchRow(game2, s, { pitchType: 'FB', zone: 'IN', action: 'SWING' }, { id: 'r', createdAt: 0 });
  assert.equal(row.pitcher, 'AwayAce');
  assert.equal(row.pitcher_pitch_count, 2);
  assert.deepEqual([row.half, row.batting_team, row.pitching_team, row.batter], ['bottom', 'Home', 'Away', 'H1']);
});

test('a manual third out mid-PA: same batter leads off next time, new PA number', () => {
  const s = replay(game2, [ev('outs', { delta: 2 }), p('FB', 'OUT', 'TAKE'), ev('outs', { delta: 1 })]);
  assert.deepEqual([s.half, s.balls, s.paNumber, s.teams[0].slot], ['bottom', 0, 2, 0]);
});

test('next batter reasons: out by rule adds an out, HBP does not', () => {
  assert.equal(replay(game2, [ev('nextBatter', { reason: 'OUT_RULE' })]).outs, 1);
  const s = replay(game2, [ev('nextBatter', { reason: 'HBP' })]);
  assert.deepEqual([s.outs, currentBatter(s).name], [0, 'A2']);
});

test('substitutions and pitcher changes by team', () => {
  const s = replay(game2, [ev('sub', { team: 1, slot: 0, name: 'H9', number: '99' }), ev('pitcher', { team: 0, name: 'Reliever' })]);
  assert.equal(s.teams[1].lineup[0].name, 'H9');
  assert.equal(s.teams[0].pitcher, 'Reliever');
  assert.equal(s.teams[1].pitcher, 'HomeAce');
});

test('undoing an outcome brings the decision tree back', () => {
  const o = outcome('hit', '1B');
  const s = replay(game2, [inPlay(), { ...o, deleted: 1 }]);
  assert.ok(s.pending);
});

test('plate appearance rows', () => {
  const before = replay(game2, [p('FB', 'OUT', 'TAKE'), p('FB', 'IN', 'TAKE'), p('FB', 'IN', 'TAKE')]);
  const kRow = pitchPaRow(game2, before, { pitchType: 'CB', zone: 'OUT', action: 'SWING' }, { id: 'k', createdAt: 0 });
  assert.deepEqual([kRow.result, kRow.category, kRow.pitches, kRow.balls, kRow.strikes, kRow.outs_on_play, kRow.pitcher],
    ['K', 'strikeout', 4, 1, 2, 1, 'HomeAce']);
  assert.equal(pitchPaRow(game2, before, { pitchType: 'CB', zone: 'OUT', action: 'TAKE' }, { id: 'b', createdAt: 0 }), null);
  const pend = replay(game2, [p('FB', 'OUT', 'TAKE'), inPlay()]);
  const hit = outcomePaRow(game2, pend, { category: 'error', result: 'E_FLY', fielder: 'LF' }, { id: 'o', createdAt: 0 });
  assert.deepEqual([hit.result, hit.result_label, hit.category, hit.batted_ball, hit.fielder, hit.pitches, hit.balls, hit.batter],
    ['E_FLY', 'Error on a fly', 'error', 'fly', 'LF', 2, 1, 'A1']);
  assert.equal(nextBatterPaRow(game2, pend, 'other', { id: 'n', createdAt: 0 }), null);
  assert.equal(nextBatterPaRow(game2, pend, 'HBP', { id: 'n', createdAt: 0 }).category, 'hbp');
  for (const row of [kRow, hit]) assert.deepEqual(Object.keys(row).sort(), PA_COLUMNS.filter((c) => c !== 'recorded_by').sort());
});

test('every outcome code has a label', () => {
  for (const c of Object.values(OUTCOME_TREE)) for (const code of Object.keys(c.options)) assert.ok(PA_RESULTS[code]?.label, code);
});

test('old one-team games still replay', () => {
  const s = replay(game, [...k(), ...k(), p('FB', 'IN', 'TAKE')]);
  assert.equal(s.teams.length, 1);
  assert.equal(s.teams[0].pitcher, 'Ace');
  assert.deepEqual([s.outs, s.half, s.inning, currentBatter(s).name], [2, 'top', 1, 'C']);
  const s3 = replay(game, [...k(), ...k(), ...k()]);
  assert.deepEqual([s3.outs, s3.half, s3.inning, currentBatter(s3).name], [0, 'top', 2, 'A']);
  const row = buildPitchRow(game, s, { pitchType: 'FB', zone: 'IN', action: 'TAKE' }, { id: 'x', createdAt: 0 });
  assert.deepEqual([row.half, row.pitching_team, row.pitcher], ['', '', 'Ace']);
});

test('sheet columns match the Apps Script headers', () => {
  const gs = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  const list = (name) => JSON.parse(gs.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`))[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  assert.deepEqual(list('HEADERS'), [...PITCH_COLUMNS, 'synced_at']);
  assert.deepEqual(list('PA_HEADERS'), [...PA_COLUMNS, 'synced_at']);
});
