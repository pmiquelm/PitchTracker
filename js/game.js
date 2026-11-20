// Pure game logic: no DOM, no storage. Everything the tracker shows is derived
// by replaying the game's event log through `reduce`, so undo is simply
// "drop the last event and replay".

export const PITCH_TYPES = { FB: 'Fastball', CB: 'Curveball' };
export const ZONES = { IN: 'In zone', OUT: 'Out of zone' };
export const ACTIONS = { TAKE: 'Take', SWING: 'Swing', FOUL: 'Foul', IN_PLAY: 'Ball in play' };

export const RESULT_LABELS = {
  ball: 'Ball',
  called_strike: 'Called strike',
  swinging_strike: 'Swinging strike',
  foul: 'Foul',
  in_play: 'In play',
};

export const PA_END_LABELS = {
  walk: 'Walk',
  strikeout: 'Strikeout',
  in_play: 'Ball in play',
  manual: 'Next batter',
};

// ---- Plate-appearance outcomes ----
// The decision tree shown after a ball in play: category, then detail, then fielder.
// `outs` is how many outs the play adds (anything unusual is fixed with Outs −/+).
export const OUTCOME_TREE = {
  hit: {
    label: 'Hit',
    options: {
      '1B': { label: 'Single', outs: 0 },
      '2B': { label: 'Double', outs: 0 },
      '3B': { label: 'Triple', outs: 0 },
      HR: { label: 'Home run', outs: 0 },
    },
  },
  out: {
    label: 'Out',
    options: {
      GO: { label: 'Ground out', outs: 1, battedBall: 'ground' },
      LO: { label: 'Line out', outs: 1, battedBall: 'line' },
      FO: { label: 'Fly out', outs: 1, battedBall: 'fly' },
      DP: { label: 'Double play', outs: 2 },
    },
  },
  fc: {
    label: "Fielder's choice",
    options: { FC: { label: "Fielder's choice", outs: 1 } },
  },
  sac: {
    label: 'Sac',
    options: {
      SAC_BUNT: { label: 'Sac bunt', outs: 1, battedBall: 'bunt' },
      SAC_FLY: { label: 'Sac fly', outs: 1, battedBall: 'fly' },
    },
  },
  error: {
    label: 'Error',
    options: {
      E_GROUND: { label: 'Error on a grounder', short: 'Ground ball', outs: 0, battedBall: 'ground' },
      E_LINE: { label: 'Error on a liner', short: 'Line drive', outs: 0, battedBall: 'line' },
      E_FLY: { label: 'Error on a fly', short: 'Fly ball', outs: 0, battedBall: 'fly' },
    },
  },
};

// Reasons offered by "Next batter" (no pitch ends these plate appearances).
// `other` records nothing: it is for corrections, like before.
export const NEXT_BATTER_REASONS = {
  HBP: { label: 'Hit by pitch', outs: 0 },
  IBB: { label: 'Intentional walk', outs: 0 },
  CI: { label: "Catcher's interference", outs: 0 },
  OUT_RULE: { label: 'Out by rule', outs: 1 },
  other: { label: 'Other / correction', outs: 0 },
};

export const FIELDERS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];

// Every `result` code in the PlateAppearances sheet, with its label and category.
export const PA_RESULTS = {
  K: { label: 'Strikeout', category: 'strikeout' },
  BB: { label: 'Walk', category: 'walk' },
  ...Object.fromEntries(Object.entries(OUTCOME_TREE).flatMap(([category, c]) =>
    Object.entries(c.options).map(([code, o]) => [code, { label: o.label, category }]))),
  HBP: { label: NEXT_BATTER_REASONS.HBP.label, category: 'hbp' },
  IBB: { label: NEXT_BATTER_REASONS.IBB.label, category: 'walk' },
  CI: { label: NEXT_BATTER_REASONS.CI.label, category: 'interference' },
  OUT_RULE: { label: NEXT_BATTER_REASONS.OUT_RULE.label, category: 'out' },
};

export function outcomeInfo(category, code) {
  const c = OUTCOME_TREE[category];
  const o = c?.options[code];
  if (!o) throw new Error(`Unknown outcome: ${category}/${code}`);
  return o;
}

// Column order of the "Pitches" sheet. Keep in sync with apps-script/Code.gs.
export const PITCH_COLUMNS = [
  'id', 'game_id', 'recorded_at', 'inning', 'half', 'batting_team', 'pitching_team',
  'outs_before', 'pa_number', 'pitch_number', 'pitch_in_pa', 'lineup_slot',
  'batter_number', 'batter', 'pitcher', 'pitcher_pitch_count', 'balls_before',
  'strikes_before', 'pitch_type', 'zone', 'action', 'result', 'pa_end', 'pa_result',
  'deleted', 'recorded_by', 'session_type',
];

// Column order of the "PlateAppearances" sheet (one row per finished plate
// appearance). Keep in sync with PA_HEADERS in apps-script/Code.gs.
export const PA_COLUMNS = [
  'id', 'game_id', 'recorded_at', 'inning', 'half', 'batting_team', 'pitching_team',
  'outs_before', 'pa_number', 'lineup_slot', 'batter_number', 'batter', 'pitcher',
  'pitches', 'balls', 'strikes', 'result', 'result_label', 'category', 'batted_ball',
  'fielder', 'outs_on_play', 'deleted', 'recorded_by', 'session_type',
];

// ---- Live BP sessions ----
// A session where one team's pitchers face its own hitters, in no set order: the
// recorder picks the batter after every at-bat. No innings, no outs.
export const isBp = (game) => game?.mode === 'bp';
// "Next batter" reasons that make sense in live BP.
export const BP_NEXT_REASONS = ['HBP', 'other'];

export function pitchResult(zone, action) {
  switch (action) {
    case 'TAKE': return zone === 'IN' ? 'called_strike' : 'ball';
    case 'SWING': return 'swinging_strike';
    case 'FOUL': return 'foul';
    case 'IN_PLAY': return 'in_play';
    default: throw new Error(`Unknown action: ${action}`);
  }
}

// What a pitch does to the current count. Does not mutate `state`.
export function evaluatePitch(state, { zone, action }) {
  const result = pitchResult(zone, action);
  let { balls, strikes } = state;
  let paEnd = null;
  if (result === 'ball') {
    balls += 1;
    if (balls >= 4) paEnd = 'walk';
  } else if (result === 'called_strike' || result === 'swinging_strike') {
    strikes += 1;
    if (strikes >= 3) paEnd = 'strikeout';
  } else if (result === 'foul') {
    if (strikes < 2) strikes += 1;
  } else if (result === 'in_play') {
    paEnd = 'in_play';
  }
  return { result, balls, strikes, paEnd };
}

// The teams of a game. Games from before two-team tracking have a single
// `lineup` and `pitcher` (the pitcher that lineup faced): they become one team,
// whose `pitcher` is the opposing pitcher.
export function gameTeams(game) {
  if (Array.isArray(game.teams) && game.teams.length) return game.teams;
  return [{ name: '', lineup: game.lineup || [], pitcher: game.pitcher || '' }];
}

export function initialState(game) {
  if (isBp(game)) {
    const t = gameTeams(game)[0];
    return {
      ...initialState({ teams: [{ name: t.name, lineup: [], pitcher: t.pitcher }] }),
      bp: true,
      batter: null,         // { number, name } of the batter at the plate
      awaitingBatter: true, // true until the next batter is picked
    };
  }
  return {
    teams: gameTeams(game).map((t) => ({
      name: t.name || '',
      lineup: t.lineup.map((p) => ({ number: p.number || '', name: p.name })),
      slot: 0,           // 0-based index into lineup of this team's current/next batter
      pitcher: t.pitcher || '',
      pitcherPitches: 0, // pitches thrown by this team's current pitcher
    })),
    inning: 1,
    half: 'top',        // top: teams[0] (away) bats; bottom: teams[1] (home) bats
    outs: 0,
    balls: 0,
    strikes: 0,
    paNumber: 1,        // plate appearance number within the game (1-based)
    pitchInPa: 0,       // pitches already thrown in the current PA
    pitchNumber: 0,     // pitches already thrown in the game
    pending: null,      // { pitchId } after a ball in play, until its outcome is chosen
    lastPaEnd: null,
    lastHalfEnd: false,
  };
}

export const battingIndex = (s) => (s.teams.length > 1 && s.half === 'bottom' ? 1 : 0);
export const fieldingIndex = (s) => (s.teams.length > 1 ? 1 - battingIndex(s) : 0);
export const battingTeam = (s) => s.teams[battingIndex(s)];
export const fieldingTeam = (s) => s.teams[fieldingIndex(s)];
export const currentBatter = (s) => {
  if (s.bp) return s.batter || { number: '', name: '' };
  const t = battingTeam(s);
  return t.lineup[t.slot] || { number: '', name: '' };
};
export const halfLabel = (s) => `${s.half === 'bottom' ? '▼' : '▲'}${s.inning}`;

function patchTeam(s, i, patch) {
  s.teams = s.teams.map((t, j) => (j === i ? { ...t, ...patch } : t));
}

function resetCount(s) {
  s.balls = 0;
  s.strikes = 0;
  s.pitchInPa = 0;
  s.pending = null;
}

function nextBatter(s, reason) {
  if (s.bp) {
    // Nobody is "next" in BP: keep the last batter (for "same batter again") and ask.
    resetCount(s);
    s.paNumber += 1;
    s.lastPaEnd = reason;
    s.awaitingBatter = true;
    return;
  }
  const bi = battingIndex(s);
  const t = s.teams[bi];
  patchTeam(s, bi, { slot: (t.slot + 1) % t.lineup.length });
  resetCount(s);
  s.paNumber += 1;
  s.lastPaEnd = reason;
}

// A plate appearance that was cut off (third out on the bases, a manual
// change of half-inning) counts as one if pitches were thrown; the same batter
// starts fresh next time.
function abandonPa(s) {
  if (s.pitchInPa > 0) s.paNumber += 1;
  resetCount(s);
}

// Defensive: an outcome is still owed for the last ball in play, but something
// else is happening. Move on as the old app did (the ball in play ended the PA).
function settlePending(s) {
  if (s.pending) nextBatter(s, 'in_play');
}

function stepHalf(s, delta) {
  if (s.bp) return; // no innings in BP
  abandonPa(s);
  s.outs = 0;
  if (s.teams.length === 1) {
    s.inning = Math.max(1, s.inning + delta);
    return;
  }
  // Halves numbered 0 (top 1st), 1 (bottom 1st), 2 (top 2nd)…
  const n = Math.max(0, (s.inning - 1) * 2 + (s.half === 'bottom' ? 1 : 0) + delta);
  s.inning = Math.floor(n / 2) + 1;
  s.half = n % 2 ? 'bottom' : 'top';
}

function addOuts(s, n) {
  if (s.bp) return; // no outs in BP
  s.outs = Math.max(0, s.outs + n);
  if (s.outs >= 3) {
    stepHalf(s, 1);
    s.lastHalfEnd = true;
  }
}

export function reduce(prev, ev) {
  const s = { ...prev, lastPaEnd: null, lastHalfEnd: false };
  const d = ev.data || {};
  switch (ev.type) {
    case 'pitch': {
      settlePending(s);
      const r = evaluatePitch(s, d);
      const fi = fieldingIndex(s);
      s.pitchNumber += 1;
      patchTeam(s, fi, { pitcherPitches: s.teams[fi].pitcherPitches + 1 });
      if (r.paEnd === 'in_play') {
        // The batter stays up until the outcome is chosen.
        s.pitchInPa += 1;
        s.pending = { pitchId: ev.id };
      } else if (r.paEnd) {
        nextBatter(s, r.paEnd);
        if (r.paEnd === 'strikeout') addOuts(s, 1);
      } else {
        s.balls = r.balls;
        s.strikes = r.strikes;
        s.pitchInPa += 1;
      }
      return s;
    }
    case 'outcome': {
      if (!s.pending) return s; // nothing to attach it to
      const o = outcomeInfo(d.category, d.result);
      nextBatter(s, 'in_play');
      addOuts(s, o.outs);
      return s;
    }
    case 'nextBatter': {
      settlePending(s);
      nextBatter(s, 'manual');
      addOuts(s, NEXT_BATTER_REASONS[d.reason]?.outs || 0);
      return s;
    }
    case 'setBatter':
      // Correction: jump to a lineup slot with a fresh count. Only counts as a
      // new plate appearance if pitches were already thrown in this one.
      patchTeam(s, battingIndex(s), { slot: d.slot });
      abandonPa(s);
      return s;
    case 'batterUp':
      // BP: the batter now at the plate. Picked mid at-bat (a correction), the
      // at-bat so far is left unfinished, like setBatter.
      settlePending(s);
      abandonPa(s);
      s.batter = { number: d.number || '', name: d.name || '' };
      s.awaitingBatter = false;
      return s;
    case 'sub': {
      const ti = d.team ?? battingIndex(s);
      patchTeam(s, ti, {
        lineup: s.teams[ti].lineup.map((p, i) => (i === d.slot ? { number: d.number || '', name: d.name } : p)),
      });
      return s;
    }
    case 'pitcher':
      patchTeam(s, d.team ?? fieldingIndex(s), { pitcher: d.name, pitcherPitches: 0 });
      return s;
    case 'half':
      settlePending(s);
      stepHalf(s, d.delta);
      return s;
    case 'outs':
      settlePending(s);
      addOuts(s, d.delta);
      return s;
    case 'inning':
      // Games from before half-innings: a plain inning number.
      s.inning = Math.max(1, s.inning + d.delta);
      return s;
    default:
      return s;
  }
}

export function activeEvents(events) {
  return events.filter((e) => !e.deleted).sort((a, b) => a.seq - b.seq);
}

export function replay(game, events) {
  return activeEvents(events).reduce(reduce, initialState(game));
}

// Columns shared by both sheets, from the state *before* the event.
function situation(game, state, ev) {
  const bt = battingTeam(state);
  const ft = fieldingTeam(state);
  const batter = currentBatter(state);
  if (state.bp) {
    return {
      id: ev.id,
      game_id: game.gameId,
      recorded_at: new Date(ev.createdAt).toISOString(),
      inning: '',
      half: '',
      batting_team: bt.name,
      pitching_team: bt.name, // the same team on both sides
      outs_before: '',
      pa_number: state.paNumber,
      lineup_slot: '',
      batter_number: batter.number,
      batter: batter.name,
      pitcher: ft.pitcher,
      session_type: 'bp',
    };
  }
  return {
    id: ev.id,
    game_id: game.gameId,
    recorded_at: new Date(ev.createdAt).toISOString(),
    inning: state.inning,
    half: state.teams.length > 1 ? state.half : '',
    batting_team: bt.name,
    pitching_team: state.teams.length > 1 ? ft.name : '',
    outs_before: state.outs,
    pa_number: state.paNumber,
    lineup_slot: bt.slot + 1,
    batter_number: batter.number,
    batter: batter.name,
    pitcher: ft.pitcher,
    session_type: 'game',
  };
}

// The row that goes to the Pitches sheet, computed from the state *before* the pitch.
export function buildPitchRow(game, state, input, ev) {
  const r = evaluatePitch(state, input);
  const base = situation(game, state, ev);
  return {
    id: base.id,
    game_id: base.game_id,
    recorded_at: base.recorded_at,
    inning: base.inning,
    half: base.half,
    batting_team: base.batting_team,
    pitching_team: base.pitching_team,
    outs_before: base.outs_before,
    pa_number: base.pa_number,
    pitch_number: state.pitchNumber + 1,
    pitch_in_pa: state.pitchInPa + 1,
    lineup_slot: base.lineup_slot,
    batter_number: base.batter_number,
    batter: base.batter,
    pitcher: base.pitcher,
    pitcher_pitch_count: fieldingTeam(state).pitcherPitches + 1,
    balls_before: state.balls,
    strikes_before: state.strikes,
    pitch_type: input.pitchType,
    zone: input.zone,
    action: input.action,
    result: r.result,
    pa_end: r.paEnd || '',
    pa_result: { walk: 'BB', strikeout: 'K' }[r.paEnd] || '', // a ball in play gets its result later
    deleted: false,
    session_type: base.session_type,
  };
}

// The PlateAppearances row for an event that ends a plate appearance, from the
// state before it. `outcome` = { result, category, battedBall?, fielder?, outs }.
// `isPitch` is true when the event itself is the last pitch (strikeout, walk).
export function buildPaRow(game, state, outcome, ev, isPitch = false) {
  return {
    ...situation(game, state, ev),
    pitches: state.pitchInPa + (isPitch ? 1 : 0),
    balls: state.balls,
    strikes: state.strikes,
    result: outcome.result,
    result_label: PA_RESULTS[outcome.result]?.label || '',
    category: outcome.category,
    batted_ball: outcome.battedBall || '',
    fielder: outcome.fielder || '',
    outs_on_play: outcome.outs,
    deleted: false,
  };
}

// The PA row for a pitch, if that pitch ends the PA by itself (strikeout or walk).
export function pitchPaRow(game, state, input, ev) {
  const { paEnd } = evaluatePitch(state, input);
  if (paEnd === 'strikeout') return buildPaRow(game, state, { result: 'K', category: 'strikeout', outs: 1 }, ev, true);
  if (paEnd === 'walk') return buildPaRow(game, state, { result: 'BB', category: 'walk', outs: 0 }, ev, true);
  return null;
}

// The PA row for a chosen ball-in-play outcome.
export function outcomePaRow(game, state, data, ev) {
  const o = outcomeInfo(data.category, data.result);
  return buildPaRow(game, state, {
    result: data.result,
    category: data.category,
    battedBall: o.battedBall,
    fielder: data.fielder,
    outs: o.outs,
  }, ev);
}

// The PA row for "Next batter" with a reason (null for "other").
export function nextBatterPaRow(game, state, reason, ev) {
  const r = NEXT_BATTER_REASONS[reason];
  if (!r || reason === 'other') return null;
  return buildPaRow(game, state, { result: reason, category: PA_RESULTS[reason].category, outs: r.outs }, ev);
}
