import test from 'node:test';
import assert from 'node:assert/strict';
import { gameDate, gameNumber, localDate } from '../js/game.js';

test('gameDate reads the leading date', () => {
  assert.equal(gameDate('2026-05-09 - WOLFSBURG GAME 2'), '2026-05-09');
  assert.equal(gameDate('2026-05-30- @BRAUNSCHWEIG GAME 1'), '2026-05-30');
  assert.equal(gameDate('2026-11-20-BP'), '2026-11-20');
  assert.equal(gameDate('2026-11-17-'), '2026-11-17');
  assert.equal(gameDate('  2026-11-17 x'), '2026-11-17');
});

test('gameDate refuses missing or impossible dates', () => {
  for (const id of ['', null, undefined, 'WOLFSBURG GAME 2', 'TEST-1', '2026-5-9-X', '2026-02-30-X', '2026-13-01', '20261109-X', '2026-11-099', 'x2026-11-09']) {
    assert.equal(gameDate(id), null, String(id));
  }
  assert.equal(gameDate('2028-02-29-LEAP'), '2028-02-29');
});

test('gameNumber finds which game of a doubleheader', () => {
  const cases = {
    '2026-05-09 - WOLFSBURG GAME 2': 2,
    '2026-05-30- @BRAUNSCHWEIG GAME 1': 1,
    '2026-05-30-BRAUNSCHWEIG GM1': 1,
    '2026-05-30-braunschweig gm 2': 2,
    '2026-05-30-Braunschweig Gm.2': 2,
    '2026-05-30-Braunschweig G2': 2,
    '2026-05-30-Braunschweig game #2': 2,
    '2026-05-30-Braunschweig game-2': 2,
    '2026-05-30-Braunschweig_Game_1': 1,
    '2026-05-30-Braunschweig Spiel 2': 2,
    '2026-05-30-Braunschweig DH2': 2,
    '2026-05-30-Braunschweig 2nd game': 2,
    '2026-05-30-Braunschweig 1. Spiel': 1,
    '2026-05-30-Braunschweig game two': 2,
    '2026-05-30-Braunschweig first game': 1,
    '2026-11-20-BP 2': 2,
    '2026-11-20-BP2': 2,
  };
  for (const [id, n] of Object.entries(cases)) assert.equal(gameNumber(id), n, id);
});

test('gameNumber ignores dates, team names and other numbers', () => {
  for (const id of ['2026-05-09-WOLFSBURG', '2026-11-20-BP', '2026-11-18-ROSTERTEST', '2026-11-17-TESTV9',
    '2026-05-09-Braunschweig 89ers', '2026-05-09-Hamburg Stealers', '2026-05-09-GAMES', '2026-05-12-X', '']) {
    assert.equal(gameNumber(id), null, id);
  }
});

test('localDate uses the device time zone', () => {
  assert.equal(localDate(new Date(2026, 0, 2, 0, 30)), '2026-01-02');
  assert.match(localDate(), /^\d{4}-\d{2}-\d{2}$/);
});
