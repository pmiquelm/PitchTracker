// Run expectancy, win probability and leaderboards for the team dashboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rates, model, valuePlays, gamePlayers, gameTeams, baseLabel } from '../dashboard/winprob.js';
import { longestRun, top, leaderboards } from '../dashboard/leaders.js';
import { buildModel } from '../dashboard/model.js';

const typical = model(rates([], []));

test('the model with typical rates: sensible run expectancy and a fair start', () => {
  const re = (b, o) => typical.re[b * 3 + o];
  assert.ok(re(0, 0) > 0.3 && re(0, 0) < 1.5, `bases empty, no outs: ${re(0, 0)}`);
  assert.ok(re(7, 0) > re(0, 0), 'bases loaded is worth more');
  for (let b = 0; b < 8; b++) assert.ok(re(b, 0) > re(b, 1) && re(b, 1) > re(b, 2), `fewer runs with more outs (${baseLabel(b)})`);
  const start = typical.we(1, true, 0, 0, 0);
  assert.ok(start > 0.4 && start < 0.65, `home team before the first pitch: ${start}`);
  assert.equal(typical.we(7, false, 0, 3, 1), 1, 'home ahead after 7 full innings: won');
  assert.ok(typical.we(7, true, 0, 0, 5) > 0.95, 'home up 5 going into the top of the 7th');
  assert.ok(typical.we(1, true, 0, 0, -12) < 0.02);
});

test('rates blend this league with typical rates', () => {
  const pbp = Array.from({ length: 50 }, (_, i) => ({ game_id: 'g', event_seq: i + 1, is_pa: 1, event_code: 'HR' }));
  const r = Object.fromEntries(rates(pbp, []).map((x) => [x.outcome, x]));
  assert.equal(r.hr.count, 50);
  assert.equal(r.hr.rate, (50 + 50 * 0.015) / 100, 'worth 50 plate appearances of the typical rate');
  // The app's plate appearances count only for games with no scoresheet, and never live BP
  const app = [{ game_id: 'g', result: 'K' }, { game_id: 'h', result: 'K' }, { game_id: 'i', result: 'K', session_type: 'bp' }];
  assert.equal(Object.fromEntries(rates(pbp, app).map((x) => [x.outcome, x])).out.count, 1);
});

// A short game: the home team (Home) wins 1-0 on a walk-off home run in the bottom of the 7th.
function walkOff() {
  const ev = [];
  let seq = 0;
  for (let inn = 1; inn <= 7; inn++) {
    for (const half of ['top', 'bottom']) {
      const last = inn === 7 && half === 'bottom';
      for (let o = 0; o < (last ? 1 : 3); o++) {
        ev.push({ game_id: 'G', event_seq: ++seq, inning: inn, half, batting_team: half === 'top' ? 'Away' : 'Home',
          fielding_team: half === 'top' ? 'Home' : 'Away', batter: last ? 'Hero' : `B${o}`, pitcher: half === 'top' ? 'HomeP' : 'AwayP',
          event_code: last ? 'HR' : 'K', event_desc: last ? 'Home run' : 'Strikeout', is_pa: 1, outs_before: o, outs_after: last ? 0 : o + 1,
          runs_on_play: last ? 1 : 0, away_score_before: 0, home_score_before: 0 });
      }
    }
  }
  return ev;
}

test('a walk-off home run: the biggest play, and the game ends at 100%', () => {
  const v = valuePlays(walkOff(), typical);
  const last = v.get(`G|${walkOff().length}`);
  assert.equal(last.homeWeAfter, 1);
  assert.ok(last.wpa > 30, `walk-off WPA ${last.wpa}`);
  assert.ok(last.li > 1.5, 'high leverage');
  const first = v.get('G|1');
  assert.ok(first.wpa > 0 === false, 'a strikeout of the leadoff hitter is bad for the batting team');
  // WPA for the home team adds up to its final minus starting chance
  const all = [...v.values()];
  const homeWpa = walkOff().reduce((a, e, i) => a + (e.half === 'bottom' ? 1 : -1) * all[i].wpa, 0);
  assert.ok(Math.abs(homeWpa - 100 * (1 - first.homeWeBefore)) < 1e-9);
});

test('who moved the game and team totals', () => {
  const data = (rows) => ({ cols: Object.keys(rows[0]), rows: rows.map((r) => Object.values(r)) });
  const m = buildModel({ pbp: data(walkOff()), pas: { cols: [], rows: [] }, pitches: { cols: [], rows: [] }, videoTimes: { cols: [], rows: [] }, videos: {} });
  const plays = m.plays.filter((p) => p.game === 'G');
  const ps = gamePlayers(plays);
  assert.equal(ps[0].who, 'Hero', 'the walk-off hitter tops the list');
  assert.equal(ps[ps.length - 1].who, 'AwayP', 'the pitcher who gave it up is last');
  const t = Object.fromEntries(gameTeams(plays).map((r) => [r.team, r]));
  assert.ok(Math.abs(t.Home.bat + t.Away.fld) < 1e-9, "a team's fielding is the other's batting, flipped");
  assert.ok(Math.abs(t.Home.hit + t.Home.run + t.Home.given - t.Home.bat) < 1e-9, 'batting adds up');
  assert.equal(m.games[0].score.home, 1);
});

test('streaks: longest run, and whether it is still going', () => {
  const r = longestRun([1, 1, 0, 1, 1, 1], (x) => x === 1);
  assert.deepEqual([r.len, r.active], [3, true]);
  assert.deepEqual([longestRun([1, 1, 0], (x) => x === 1).active, longestRun([], () => true).len], [false, 0]);
  const t = top([{ who: 'A', value: 3 }, { who: 'B', value: 5 }, { who: 'C', value: 3 }, { who: 'D', value: 0 }]);
  assert.deepEqual(t.map((x) => [x.rank, x.who]), [[1, 'B'], [2, 'A'], [2, 'C']], 'ties share a rank; zero is left off');
  assert.deepEqual(top([{ who: 'A', value: 0 }, { who: 'B', value: 10 }], true).map((x) => x.who), ['A', 'B'], 'low boards keep zero');
});

test('leaderboards from plays: streaks across games in date order, rates with a minimum', () => {
  const pitch = (action, zone, result, extra = {}) => ({ type: 'FB', zone, action, result, balls: 0, strikes: 0, inPa: 1, paEnd: '', ...extra });
  const play = (game, seq, batter, outcome, pitches) => ({ game, seq, batter, pitcher: 'P', team: 'Us', opp: 'Them', isPa: true, outcome,
    hit: ['1B', '2B'].includes(outcome), pitches, session: 'game' });
  const games = [{ id: '2026-04-02 G', date: '2026-04-02', number: null }, { id: '2026-04-01 G', date: '2026-04-01', number: null }];
  // Listed newest game first: streaks must still run in date order.
  const plays = [
    play('2026-04-02 G', 1, 'Ann', '1B', [pitch('FOUL', 'IN', 'foul'), pitch('IN_PLAY', 'IN', 'in_play')]),
    play('2026-04-01 G', 1, 'Ann', 'BB', [pitch('SWING', 'OUT', 'swinging_strike'), pitch('FOUL', 'IN', 'foul')]),
    play('2026-04-01 G', 2, 'Bob', 'K', [pitch('TAKE', 'IN', 'called_strike', { strikes: 2, paEnd: 'strikeout' })]),
  ];
  const b = leaderboards(plays, games, 'hit', 'Us');
  assert.deepEqual(b.h_contact_streak.map((r) => [r.who, r.value, r.active, r.detail]), [['Ann', 3, true, '04/01 → 04/02']]);
  assert.deepEqual(b.h_onbase_streak.map((r) => [r.who, r.value]), [['Ann', 2]]);
  assert.deepEqual(b.h_k_looking.map((r) => [r.who, r.value]), [['Bob', 1]]);
  assert.deepEqual(b.h_k.map((r) => [r.who, r.value]), [['Bob', 1]]);
  assert.deepEqual(b.h_whiff_rate, [], 'fewer than 10 swings: not ranked');
  const p = leaderboards(plays, games, 'pit', 'Them');
  assert.deepEqual(p.p_strike_streak.map((r) => [r.who, r.value]), [['P', 5]]);
  assert.deepEqual(leaderboards(plays, games, 'pit', 'Us').p_k, [], 'Us did not pitch');
});
