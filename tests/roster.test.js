import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRosters, findByName, findByNumber } from '../js/roster.js';

test('normalizeRosters keeps clean strings and drops junk', () => {
  assert.deepEqual(normalizeRosters(null), []);
  assert.deepEqual(normalizeRosters([
    { name: '  Tigers\n', players: [{ number: 7, name: ' Lopez ', pos: 'SS' }, { name: '' }, null, { name: 'Kim' }] },
    { name: 'Empty', players: [] },
    'nope',
    { players: [{ name: 'Ann' }] },
  ]), [
    { name: 'Tigers', players: [{ number: '7', name: 'Lopez', pos: 'SS' }, { number: '', name: 'Kim', pos: '' }] },
    { name: 'Roster 2', players: [{ number: '', name: 'Ann', pos: '' }] },
  ]);
  const long = normalizeRosters([{ name: 'x', players: Array.from({ length: 99 }, (_, i) => ({ name: 'P'.repeat(200) + i })) }]);
  assert.equal(long[0].players.length, 40);
  assert.equal(long[0].players[0].name.length, 60);
});

test('findByName ignores case and spacing; findByNumber refuses to guess', () => {
  const players = [{ number: '7', name: 'Ana Lopez' }, { number: '12', name: 'Kim' }, { number: '12', name: 'Park' }];
  assert.equal(findByName(players, '  ana   LOPEZ ')?.name, 'Ana Lopez');
  assert.equal(findByName(players, 'Ana'), null);
  assert.equal(findByName(players, ''), null);
  assert.equal(findByNumber(players, ' 7')?.name, 'Ana Lopez');
  assert.equal(findByNumber(players, '12'), null, 'two players wear 12');
  assert.equal(findByNumber(players, ''), null);
});
