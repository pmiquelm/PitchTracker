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

// Column order of the "Pitches" sheet. Keep in sync with apps-script/Code.gs.
export const PITCH_COLUMNS = [
  'id', 'game_id', 'recorded_at', 'inning', 'pa_number', 'pitch_number',
  'pitch_in_pa', 'lineup_slot', 'batter_number', 'batter', 'pitcher',
  'pitcher_pitch_count', 'balls_before', 'strikes_before', 'pitch_type',
  'zone', 'action', 'result', 'pa_end', 'deleted',
];

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

export function initialState(game) {
  return {
    lineup: game.lineup.map((p) => ({ number: p.number || '', name: p.name })),
    pitcher: game.pitcher || '',
    inning: 1,
    slot: 0,          // 0-based index into lineup of the current batter
    balls: 0,
    strikes: 0,
    paNumber: 1,      // plate appearance number within the game (1-based)
    pitchInPa: 0,     // pitches already thrown in the current PA
    pitchNumber: 0,   // pitches already thrown in the game
    pitcherPitches: 0, // pitches already thrown by the current pitcher
    lastPaEnd: null,
  };
}

function nextBatter(s, reason) {
  s.slot = (s.slot + 1) % s.lineup.length;
  s.balls = 0;
  s.strikes = 0;
  s.paNumber += 1;
  s.pitchInPa = 0;
  s.lastPaEnd = reason;
}

export function reduce(prev, ev) {
  const s = { ...prev, lastPaEnd: null };
  const d = ev.data || {};
  switch (ev.type) {
    case 'pitch': {
      const r = evaluatePitch(s, d);
      s.pitchNumber += 1;
      s.pitcherPitches += 1;
      if (r.paEnd) {
        nextBatter(s, r.paEnd);
      } else {
        s.balls = r.balls;
        s.strikes = r.strikes;
        s.pitchInPa += 1;
      }
      return s;
    }
    case 'nextBatter':
      nextBatter(s, 'manual');
      return s;
    case 'setBatter':
      // Correction: jump to a lineup slot with a fresh count. Only counts as a
      // new plate appearance if pitches were already thrown in this one.
      s.slot = d.slot;
      s.balls = 0;
      s.strikes = 0;
      if (s.pitchInPa > 0) s.paNumber += 1;
      s.pitchInPa = 0;
      return s;
    case 'sub':
      s.lineup = s.lineup.map((p, i) => (i === d.slot ? { number: d.number || '', name: d.name } : p));
      return s;
    case 'pitcher':
      s.pitcher = d.name;
      s.pitcherPitches = 0;
      return s;
    case 'inning':
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

// The row that goes to the spreadsheet, computed from the state *before* the pitch.
export function buildPitchRow(game, state, input, ev) {
  const r = evaluatePitch(state, input);
  const batter = state.lineup[state.slot] || { number: '', name: '' };
  return {
    id: ev.id,
    game_id: game.gameId,
    recorded_at: new Date(ev.createdAt).toISOString(),
    inning: state.inning,
    pa_number: state.paNumber,
    pitch_number: state.pitchNumber + 1,
    pitch_in_pa: state.pitchInPa + 1,
    lineup_slot: state.slot + 1,
    batter_number: batter.number,
    batter: batter.name,
    pitcher: state.pitcher,
    pitcher_pitch_count: state.pitcherPitches + 1,
    balls_before: state.balls,
    strikes_before: state.strikes,
    pitch_type: input.pitchType,
    zone: input.zone,
    action: input.action,
    result: r.result,
    pa_end: r.paEnd || '',
    deleted: false,
  };
}
