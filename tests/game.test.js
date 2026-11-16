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
  assert.deepEqual([s.balls, s.strikes, s.slot, s.pitchInPa], [1, 2, 0, 5]);
});

test('strikeout advances to next batter', () => {
  const s = replay(game, [p('FB', 'IN', 'TAKE'), p('FB', 'OUT', 'SWING'), p('CB', 'IN', 'SWING')]);
  assert.deepEqual([s.balls, s.strikes, s.slot, s.paNumber, s.lastPaEnd], [0, 0, 1, 2, 'strikeout']);
});

test('walk advances to next batter', () => {
  const s = replay(game, Array.from({ length: 4 }, () => p('FB', 'OUT', 'TAKE')));
  assert.deepEqual([s.slot, s.paNumber, s.lastPaEnd], [1, 2, 'walk']);
});

test('ball in play advances and lineup wraps around', () => {
  const s = replay(game, [p('FB', 'IN', 'IN_PLAY'), p('FB', 'IN', 'IN_PLAY'), p('FB', 'IN', 'IN_PLAY')]);
  assert.deepEqual([s.slot, s.paNumber, s.pitchNumber], [0, 4, 3]);
});

test('deleted (undone) events are ignored', () => {
  const s = replay(game, [p('FB', 'IN', 'TAKE'), { ...p('FB', 'IN', 'IN_PLAY'), deleted: 1 }]);
  assert.deepEqual([s.strikes, s.slot], [1, 0]);
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
  assert.equal(s.lineup[1].name, 'B2');
  assert.equal(s.pitcher, 'Reliever');
  assert.equal(s.pitcherPitches, 0);
  assert.deepEqual([s.slot, s.strikes, s.paNumber, s.inning], [2, 0, 2, 1]);
});

test('manual next batter', () => {
  const s = replay(game, [p('FB', 'OUT', 'TAKE'), ev('nextBatter')]);
  assert.deepEqual([s.slot, s.balls, s.paNumber, s.lastPaEnd], [1, 0, 2, 'manual']);
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
  assert.equal(initialState(game).pitcher, 'Ace');
});
