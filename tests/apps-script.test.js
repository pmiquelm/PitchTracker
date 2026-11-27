// Runs apps-script/Code.gs against a small in-memory imitation of Google Sheets,
// to check setup (including moving an old sheet to the new columns) and doPost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class FakeSheet {
  constructor(name) { this.name = name; this.cells = []; this.maxCols = 26; this.maxRows = 1000; }
  getName() { return this.name; }
  getLastRow() { return this.cells.length; }
  getLastColumn() { return this.cells.reduce((m, r) => Math.max(m, r.length), 0); }
  getMaxColumns() { return this.maxCols; }
  getMaxRows() { return this.maxRows; }
  insertColumnsAfter(after, n) { this.maxCols += n; }
  setFrozenRows() {}
  deleteRow(r) { this.cells.splice(r - 1, 1); }
  clear() { this.cells = []; }
  copyTo(ss) { const c = ss.insertSheet(`Copy of ${this.name}`); c.cells = this.cells.map((r) => r.slice()); return c; }
  setName(n) { this.name = n; return this; }
  getRange(row, col, nRows = 1, nCols = 1) {
    if (col + nCols - 1 > this.maxCols) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    const sheet = this;
    const range = {
      getValues: () => Array.from({ length: nRows }, (_, i) => Array.from({ length: nCols },
        (_, j) => sheet.cells[row - 1 + i]?.[col - 1 + j] ?? '')),
      setValues: (values) => {
        values.forEach((r, i) => r.forEach((v, j) => {
          while (sheet.cells.length < row + i) sheet.cells.push([]);
          sheet.cells[row - 1 + i][col - 1 + j] = v;
        }));
        return range;
      },
      getFormulas: () => range.getValues().map((r) => r.map((v) => (typeof v === 'string' && v.startsWith('=') ? v : ''))),
      setValue: (v) => range.setValues([[v]]),
      setFormula: (f) => range.setValues([[f]]),
      setFontWeight: () => range,
      setNumberFormat: () => range,
    };
    return range;
  }
}

function load(sheets = {}) {
  const ss = {
    // A real sheet always has room for its data
    sheets: Object.entries(sheets).map(([name, cells]) => Object.assign(new FakeSheet(name),
      { cells, maxCols: Math.max(26, ...cells.map((r) => r.length)) })),
    getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; },
    insertSheet(n) { const s = new FakeSheet(n); this.sheets.push(s); return s; },
  };
  const props = new Map([['TOKEN', 'tok']]);
  let uuids = 0;
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k), setProperty: (k, v) => props.set(k, v) }) },
    Utilities: { getUuid: () => `0000000${++uuids}-1111-4222-8333-444455556666`, formatDate: () => '2026-11-17 10-00' },
    Logger: { log() {} },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    ContentService: { createTextOutput: (t) => ({ setMimeType: () => JSON.parse(t) }), MimeType: { JSON: 'json' } },
  };
  vm.createContext(ctx);
  vm.runInContext(`${readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8')}
    this.api = { setup, doPost, doGet, HEADERS, PA_HEADERS, youtubeId, scoresheetUrl, columnLetter, pbpVideoFormula,
      videoToolGames, videoToolEvents, saveVideoLink, setVideoTime };`, ctx);
  const { HEADERS, PA_HEADERS, ...fns } = ctx.api;
  return { ss, props, ...fns, HEADERS: [...HEADERS], PA_HEADERS: [...PA_HEADERS] }; // copied out of the sandbox for deepEqual
}

const post = (api, body) => api.doPost({ postData: { contents: JSON.stringify({ token: 'tok', ...body }) } });

test('fresh setup, then upserts into both sheets', () => {
  const api = load();
  api.setup();
  assert.deepEqual(api.ss.getSheetByName('Pitches').cells[0], api.HEADERS);
  assert.deepEqual(api.ss.getSheetByName('PlateAppearances').cells[0], api.PA_HEADERS);
  assert.equal(api.doGet().version, 10);
  const res = post(api, { rows: [{ id: 'p1', batter: 'A', half: 'top' }], pas: [{ id: 'p1', result: '2B', fielder: 'CF' }] });
  assert.deepEqual([res.ok, res.version, res.received, res.pas], [true, 10, 1, 1]);
  post(api, { rows: [{ id: 'p1', batter: 'A', deleted: true }], pas: [] });
  const pitches = api.ss.getSheetByName('Pitches').cells;
  assert.equal(pitches.length, 2, 'upsert, not append');
  assert.equal(pitches[1][api.HEADERS.indexOf('deleted')], true);
  const pa = api.ss.getSheetByName('PlateAppearances').cells[1];
  assert.equal(pa[api.PA_HEADERS.indexOf('fielder')], 'CF');
});

test('setup (by hand) moves an old Pitches sheet to the new columns and keeps a copy', () => {
  const OLD = ['id', 'game_id', 'recorded_at', 'inning', 'pa_number', 'pitch_number',
    'pitch_in_pa', 'lineup_slot', 'batter_number', 'batter', 'pitcher',
    'pitcher_pitch_count', 'balls_before', 'strikes_before', 'pitch_type',
    'zone', 'action', 'result', 'pa_end', 'deleted', 'recorded_by', 'synced_at'];
  const row = OLD.map((h) => `v-${h}`);
  const api = load({ Pitches: [OLD.slice(), row.slice()] });
  api.setup();
  const sheet = api.ss.getSheetByName('Pitches');
  assert.deepEqual(sheet.cells[0], api.HEADERS);
  for (const h of OLD) assert.equal(sheet.cells[1][api.HEADERS.indexOf(h)], `v-${h}`, h);
  assert.equal(sheet.cells[1][api.HEADERS.indexOf('half')], '');
  const copy = api.ss.sheets.find((s) => s.name.startsWith('Pitches (before update'));
  assert.deepEqual(copy.cells, [OLD, row]);
  // Running setup again changes nothing and makes no second copy
  api.setup();
  assert.deepEqual(sheet.cells[1], api.HEADERS.map((h) => (OLD.includes(h) ? `v-${h}` : h === 'session_type' ? 'game' : '')));
  assert.equal(api.ss.sheets.filter((s) => s.name.startsWith('Pitches (before')).length, 1);
  assert.equal(post(api, { rows: [{ id: 'y' }], pas: [] }).ok, true);
});

test('live BP rows keep session_type; rows without one are games', () => {
  const api = load();
  api.setup();
  post(api, {
    rows: [{ id: 'bp1', session_type: 'bp' }, { id: 'g1', session_type: 'game' }, { id: 'old' }],
    pas: [{ id: 'bp1', session_type: 'bp' }, { id: 'old-pa' }],
  });
  const col = (name, headers) => api.ss.getSheetByName(name).cells.slice(1).map((r) => r[headers.indexOf('session_type')]);
  assert.deepEqual(col('Pitches', api.HEADERS), ['bp', 'game', 'game']);
  assert.deepEqual(col('PlateAppearances', api.PA_HEADERS), ['bp', 'game']);
  // Summary letters point at session_type, and game tables leave BP out
  const letter = (i) => (i >= 26 ? 'A' : '') + String.fromCharCode(65 + (i % 26));
  assert.equal(letter(api.HEADERS.indexOf('session_type')), 'AA');
  assert.equal(letter(api.PA_HEADERS.indexOf('session_type')), 'Y');
  assert.equal(letter(api.HEADERS.indexOf('deleted')), 'Y');
  assert.equal(letter(api.PA_HEADERS.indexOf('deleted')), 'W');
  const formulas = api.ss.getSheetByName('Summary').cells.map((r) => String(r[0] ?? '')).filter((f) => f.includes('QUERY'));
  assert.equal(formulas.length, 10);
  for (const f of formulas.slice(0, 6)) assert.match(f, /(AA|Y) <> 'bp'/);
  for (const f of formulas.slice(6)) assert.match(f, /^=IFERROR\(QUERY\(.*(AA|Y) = 'bp'/);
});

test('wrong token is refused', () => {
  const api = load();
  api.setup();
  assert.equal(api.doPost({ postData: { contents: JSON.stringify({ token: 'no', rows: [] }) } }).ok, false);
});

const OLD_HEADERS = ['id', 'game_id', 'recorded_at', 'inning', 'pa_number', 'pitch_number',
  'pitch_in_pa', 'lineup_slot', 'batter_number', 'batter', 'pitcher',
  'pitcher_pitch_count', 'balls_before', 'strikes_before', 'pitch_type',
  'zone', 'action', 'result', 'pa_end', 'deleted', 'recorded_by', 'synced_at'];

test('after a deploy that changed the columns, the first upload updates the layout by itself', () => {
  const row = OLD_HEADERS.map((h) => `v-${h}`);
  // An old sheet as the previous script version left it: no PlateAppearances, old Summary.
  const api = load({ Pitches: [OLD_HEADERS.slice(), row.slice()], Summary: [['old summary']] });
  const res = post(api, { rows: [{ id: 'new', half: 'top' }], pas: [{ id: 'pa1', result: '1B' }] });
  assert.equal(res.ok, true, res.error);
  const sheet = api.ss.getSheetByName('Pitches');
  assert.deepEqual(sheet.cells[0], api.HEADERS);
  for (const h of OLD_HEADERS) assert.equal(sheet.cells[1][api.HEADERS.indexOf(h)], `v-${h}`, h);
  assert.equal(sheet.cells[2][api.HEADERS.indexOf('half')], 'top', 'the upload itself landed in the new layout');
  assert.equal(api.ss.getSheetByName('PlateAppearances').cells[1][api.PA_HEADERS.indexOf('result')], '1B');
  assert.deepEqual(api.ss.sheets.find((s) => s.name.startsWith('Pitches (before update')).cells, [OLD_HEADERS, row]);
  assert.match(String(api.ss.getSheetByName('Summary').cells[1][0]), /QUERY\(Pitches!A:AB/, 'Summary rebuilt');
  // Later uploads don't touch the layout again
  assert.equal(post(api, { rows: [{ id: 'later' }], pas: [] }).ok, true);
  assert.equal(api.ss.sheets.filter((s) => s.name.startsWith('Pitches (before')).length, 1);
});

test('an empty upload (Test connection) also updates the layout', () => {
  const api = load({ Pitches: [OLD_HEADERS.slice(), OLD_HEADERS.map(() => 'x')] });
  assert.equal(post(api, { rows: [], pas: [] }).ok, true);
  assert.deepEqual(api.ss.getSheetByName('Pitches').cells[0], api.HEADERS);
});

test('unknown columns: upload refused with the reason, sheet left as it was', () => {
  const cells = [[...OLD_HEADERS, 'my_notes'], [...OLD_HEADERS.map(() => 'x'), 'keep me']];
  const api = load({ Pitches: cells.map((r) => r.slice()) });
  const res = post(api, { rows: [{ id: 'y' }], pas: [] });
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown columns my_notes/);
  assert.deepEqual(api.ss.getSheetByName('Pitches').cells, cells);
});

test('setup creates a Rosters template with 5 empty team blocks', () => {
  const api = load();
  api.setup();
  const cells = api.ss.getSheetByName('Rosters').cells;
  for (let b = 0; b < 5; b++) {
    assert.deepEqual(cells[0].slice(b * 3, b * 3 + 2), ['Team', ''], `block ${b + 1}`);
    assert.deepEqual(cells[1].slice(b * 3, b * 3 + 2), ['#', 'Name']);
  }
  assert.deepEqual(post(api, { action: 'rosters' }).rosters, [], 'empty blocks are not rosters');
});

test('rosters action reads filled blocks, needs the token, and never rewrites the tab', () => {
  const api = load();
  api.setup();
  const sheet = api.ss.getSheetByName('Rosters');
  const set = (r, c, v) => sheet.getRange(r, c).setValue(v);
  set(1, 2, 'Tigers');
  [['07', ' Lopez '], ['', ''], [12, 'Kim']].forEach((p, i) => p.forEach((v, j) => set(3 + i, 1 + j, v)));
  set(3, 11, 'Ann'); // 4th block (columns J–K), no team name, no number
  const before = JSON.stringify(sheet.cells);
  const res = post(api, { action: 'rosters' });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.version, 10);
  assert.deepEqual(JSON.parse(JSON.stringify(res.rosters)), [
    { name: 'Tigers', players: [{ number: '07', name: 'Lopez' }, { number: '12', name: 'Kim' }] },
    { name: 'Roster 2', players: [{ number: '', name: 'Ann' }] },
  ]);
  api.setup();
  assert.equal(JSON.stringify(sheet.cells), before, 'setup leaves an existing Rosters tab alone');
  const denied = api.doPost({ postData: { contents: JSON.stringify({ token: 'no', action: 'rosters' }) } });
  assert.deepEqual([denied.ok, denied.rosters], [false, undefined]);
});

test('rosters action on a sheet set up before rosters creates the template', () => {
  const api = load({ Pitches: [OLD_HEADERS.slice()] });
  const res = post(api, { action: 'rosters' });
  assert.deepEqual([res.ok, res.rosters.length], [true, 0]);
  assert.ok(api.ss.getSheetByName('Rosters'));
});

const POS_TEMPLATE = () => [
  ['Team', '', '', '', 'Team', '', '', ''],
  ['#', 'Name', 'Pos', '', '#', 'Name', 'Pos', ''],
];

test('an empty Rosters template with a Pos column (version 4) is replaced', () => {
  const api = load({ Rosters: POS_TEMPLATE() });
  assert.equal(post(api, { action: 'rosters' }).ok, true);
  const cells = api.ss.getSheetByName('Rosters').cells;
  assert.deepEqual(Array.from(cells[1].slice(0, 6), (v) => v ?? ''), ['#', 'Name', '', '#', 'Name', '']);
  assert.ok(!cells.flat().includes('Pos'));
});

test('a Pos-column Rosters tab with anything typed in is kept and still read', () => {
  const cells = POS_TEMPLATE();
  cells[0][1] = 'Tigers';
  cells.push(['7', 'Lopez', 'SS']);
  const api = load({ Rosters: cells.map((r) => r.slice()) });
  const res = post(api, { action: 'rosters' });
  assert.deepEqual(JSON.parse(JSON.stringify(res.rosters)), [{ name: 'Tigers', players: [{ number: '7', name: 'Lopez' }] }]);
  assert.deepEqual(api.ss.getSheetByName('Rosters').cells, cells, 'left as it was');
});

// ---- Video timestamps (PlayByPlay) ----
// The 40 columns scripts/scoresheet.py writes (the scoresheet skill), in its order.
const PBP_HEADERS = ['game_id', 'date', 'event_seq', 'inning', 'half', 'batting_team', 'fielding_team', 'pa_seq',
  'lineup_slot', 'batter', 'pitcher', 'event_code', 'event_desc', 'is_pa', 'is_ab', 'is_hit', 'bases', 'outs_before',
  'runner_1b_before', 'runner_2b_before', 'runner_3b_before', 'base_state_before', 'outs_on_play', 'outs_after',
  'runner_1b_after', 'runner_2b_after', 'runner_3b_after', 'base_state_after', 'runs_on_play', 'rbi',
  'away_score_before', 'home_score_before', 'bat_lead_before', 'error_fielder', 'error_position',
  'outs_after_no_error', 'bases_after_no_error', 'runs_no_error', 'fielders', 'runner'];
const G1 = '2026-04-11- @ FLAMINGOS GAME 2';
const pbpRow = (game, date, seq, half, batter, code, desc, isPa = 1) => PBP_HEADERS.map((h) => ({
  game_id: game, date, event_seq: seq, inning: 1, half, batting_team: half === 'top' ? 'Skylarks' : 'Flamingos',
  batter, event_code: code, event_desc: desc, is_pa: isPa,
})[h] ?? '');
const pbpGame1 = () => [
  pbpRow(G1, '2026-04-11', 1, 'top', 'Tournoux Syan', 'K', 'Strikeout'),
  pbpRow(G1, '2026-04-11', 2, 'top', 'Leidinger Max', '1B', 'Single'),
  pbpRow(G1, '2026-04-11', 3, 'top', 'Mannel Julius', 'SB', 'Leidinger M steals 2B', 0),
  pbpRow(G1, '2026-04-11', 4, 'bottom', 'Gimon Carlos', 'GO', 'Ground out 6-3'),
];
const LINK = 'https://youtu.be/abcDEF12345?si=x';
const withPbp = (rows) => load({ PlayByPlay: [PBP_HEADERS.slice(), ...rows] });

test('youtubeId accepts the usual YouTube links and nothing else', () => {
  const api = load();
  for (const ok of ['https://www.youtube.com/watch?v=abcDEF12345', 'youtube.com/watch?feature=x&v=abcDEF12345&t=5',
    'https://youtu.be/abcDEF12345?t=42', 'https://m.youtube.com/live/abcDEF12345', 'https://www.youtube.com/shorts/abcDEF12345',
    'abcDEF12345', ' https://www.youtube.com/embed/abcDEF12345 ']) assert.equal(api.youtubeId(ok), 'abcDEF12345', ok);
  for (const bad of ['', 'https://vimeo.com/abcDEF12345', 'https://evil.com/youtu.be/abcDEF12345',
    'https://youtu.be/abcDEF1234', 'https://youtu.be/abcDEF123456', 'abc"DEF1234', null]) assert.equal(api.youtubeId(bad), '', bad);
  assert.deepEqual([1, 26, 27, 40, 41, 52, 53].map(api.columnLetter), ['A', 'Z', 'AA', 'AN', 'AO', 'AZ', 'BA']);
});

test('stamping writes VideoTimes, and PlayByPlay gets one video formula after its 40 columns', () => {
  const api = withPbp(pbpGame1());
  assert.equal(api.setVideoTime(G1, 3, 2472.9, LINK), 2472);
  assert.equal(api.setVideoTime(G1, '1', 3725, LINK), 3725);
  const vt = api.ss.getSheetByName('VideoTimes').cells;
  assert.deepEqual(vt[0], ['game_id', 'event_seq', 'event_code', 'batter', 'seconds', 'link', 'label', 'updated_at']);
  assert.deepEqual(vt[1].slice(0, 7), [G1, 3, 'SB', 'Mannel Julius', 2472, 'https://www.youtube.com/watch?v=abcDEF12345&t=2472s', '41:12']);
  assert.deepEqual(vt[2].slice(4, 7), [3725, 'https://www.youtube.com/watch?v=abcDEF12345&t=3725s', '1:02:05']);
  // Re-stamping replaces; clearing removes the row
  api.setVideoTime(G1, 3, 100, LINK);
  assert.equal(api.ss.getSheetByName('VideoTimes').cells.length, 3);
  assert.equal(api.ss.getSheetByName('VideoTimes').cells[1][4], 100);
  assert.equal(api.setVideoTime(G1, 1, null, ''), null);
  assert.deepEqual(api.ss.getSheetByName('VideoTimes').cells.map((r) => r[1]), ['event_seq', 3]);

  const pbp = api.ss.getSheetByName('PlayByPlay').cells;
  assert.equal(pbp[0].length, 41, 'video is column 41 (AO); the 40 generated columns are untouched');
  assert.deepEqual(pbp[0].slice(0, 40), PBP_HEADERS);
  assert.equal(pbp[0][40], api.pbpVideoFormula(Object.fromEntries(PBP_HEADERS.map((h, i) => [h, i]))));
  assert.deepEqual(pbp.slice(1).map((r) => r.length), [40, 40, 40, 40], 'no row cells written');

  assert.throws(() => api.setVideoTime(G1, 99, 5, LINK), /no longer in PlayByPlay/);
  assert.throws(() => api.setVideoTime(G1, 2, 5, 'https://vimeo.com/1'), /Load the YouTube video/);
  assert.throws(() => api.setVideoTime(G1, 2, -1, LINK), /Not a video time/);
  assert.throws(() => api.setVideoTime(G1, 2, 'x', LINK), /Not a video time/);
});

test('the video formula looks rows up by game and event, and checks code and batter', () => {
  const api = load();
  const col = Object.fromEntries(PBP_HEADERS.map((h, i) => [h, i]));
  const f = api.pbpVideoFormula(col);
  assert.equal(f, '={"video"; ARRAYFORMULA(IF(A2:A="",, IFERROR(IF('
    + 'XLOOKUP(A2:A&"|"&C2:C, VideoTimes!A2:A&"|"&VideoTimes!B2:B, VideoTimes!C2:C&"|"&VideoTimes!D2:D)=L2:L&"|"&J2:J, '
    + 'HYPERLINK(XLOOKUP(A2:A&"|"&C2:C, VideoTimes!A2:A&"|"&VideoTimes!B2:B, VideoTimes!F2:F), '
    + 'TEXT(XLOOKUP(A2:A&"|"&C2:C, VideoTimes!A2:A&"|"&VideoTimes!B2:B, VideoTimes!E2:E)/86400, '
    + 'IF(XLOOKUP(A2:A&"|"&C2:C, VideoTimes!A2:A&"|"&VideoTimes!B2:B, VideoTimes!E2:E)>=3600, "[h]:mm:ss", "[m]:ss"))), '
    + '"⚠ check"))))}');
});

test('an existing video column is reused, and the formula follows the columns if they move', () => {
  const moved = ['note', ...PBP_HEADERS.slice(0, 20), 'video', ...PBP_HEADERS.slice(20)];
  const row = (seq) => moved.map((h) => ({ game_id: 'g', event_seq: seq, event_code: 'K', batter: 'A', is_pa: 1 })[h] ?? '');
  const api = load({ PlayByPlay: [moved.slice(), row(1)] });
  api.setVideoTime('g', 1, 10, LINK);
  const header = api.ss.getSheetByName('PlayByPlay').cells[0];
  assert.equal(header.length, moved.length);
  assert.match(header[21], /IF\(B2:B="",, .*XLOOKUP\(B2:B&"\|"&D2:D,/);
});

test('the tool lists games newest first and a game\'s plays in order, between-pitch plays included', () => {
  const api = withPbp([
    pbpRow('old', '2026-04-01', 2, 'top', 'B', '1B', 'Single'), pbpRow('old', '2026-04-01', 1, 'top', 'A', 'K', 'Strikeout'),
    ...pbpGame1(),
  ]);
  api.setVideoTime(G1, 3, 30, LINK);
  api.saveVideoLink(G1, LINK);
  const games = JSON.parse(JSON.stringify(api.videoToolGames()));
  assert.deepEqual(games.map((g) => [g.id, g.events, g.stamped, g.teams.length, g.link]),
    [[G1, 4, 1, 2, 'https://www.youtube.com/watch?v=abcDEF12345'], ['old', 2, 0, 1, '']]);
  const d = JSON.parse(JSON.stringify(api.videoToolEvents(G1)));
  assert.deepEqual(d.events.map((e) => [e.seq, e.code, e.isPa, e.video, e.stale]),
    [['1', 'K', true, null, null], ['2', '1B', true, null, null], ['3', 'SB', false, 30, null], ['4', 'GO', true, null, null]]);
  assert.deepEqual([d.events[2].desc, d.events[2].half, d.link], ['Leidinger M steals 2B', 'top', 'https://www.youtube.com/watch?v=abcDEF12345']);
  assert.deepEqual(JSON.parse(JSON.stringify(api.videoToolEvents('old'))).events.map((e) => e.seq), ['1', '2']);
});

test('regenerating PlayByPlay keeps times; a play that changed is flagged, not linked', () => {
  const api = withPbp(pbpGame1());
  api.setVideoTime(G1, 2, 50, LINK);
  api.setVideoTime(G1, 4, 90, LINK);
  // The skill rewrites the 40 columns: a corrected game file inserted a wild pitch as event 2
  const sheet = api.ss.getSheetByName('PlayByPlay');
  const fixed = pbpGame1();
  fixed.splice(1, 0, pbpRow(G1, '2026-04-11', 2, 'top', 'Leidinger Max', 'WP', 'Wild pitch', 0));
  fixed.forEach((r, i) => { r[2] = i + 1; });
  fixed.forEach((r, i) => { sheet.cells[i + 1] = r; });
  const d = JSON.parse(JSON.stringify(api.videoToolEvents(G1)));
  assert.deepEqual(d.events.map((e) => [e.code, e.video, e.stale]),
    [['K', null, null], ['1B', null, null], ['WP', null, 50], ['SB', null, 90], ['GO', null, null]], 'the wild pitch was during the single');
  assert.equal(api.videoToolGames()[0].stamped, 0);
  assert.match(sheet.cells[0][40], /^=\{"video"/, 'the header formula is still there');
  // Re-stamping the WP fixes its row
  api.setVideoTime(G1, 2, 52, LINK);
  assert.deepEqual(api.videoToolEvents(G1).events[2].video, 52);
});

test('the tool lists plays in at-bat order: an at-bat, then what happened during it', () => {
  // John steals while Bob is batting, then Bob flies out: the scoresheet numbers the steal first.
  const api = withPbp([
    pbpRow(G1, '2026-04-11', 1, 'top', 'John', '1B', 'Single'),
    pbpRow(G1, '2026-04-11', 2, 'top', 'Bob', 'SB', 'John steals 2B', 0),
    pbpRow(G1, '2026-04-11', 3, 'top', 'Bob', 'WP', 'Wild pitch; John to 3B', 0),
    pbpRow(G1, '2026-04-11', 4, 'top', 'Bob', 'FO', 'Fly out F8'),
    pbpRow(G1, '2026-04-11', 5, 'top', 'Cal', 'PK', 'John picked off 3B', 0), // the third out: stays at the end
    pbpRow(G1, '2026-04-11', 6, 'bottom', 'Dan', 'K', 'Strikeout'),
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(api.videoToolEvents(G1))).events.map((e) => e.code), ['1B', 'FO', 'SB', 'WP', 'PK', 'K']);
});

test('the tool explains a missing PlayByPlay tab', () => {
  const api = load();
  assert.throws(() => api.videoToolGames(), /no PlayByPlay tab/);
  const bad = load({ PlayByPlay: [['game_id', 'date']] });
  assert.throws(() => bad.videoToolGames(), /no event_seq, event_code, batter column/);
});

test('saveVideoLink keeps one link per game in the Videos tab', () => {
  const api = withPbp(pbpGame1());
  assert.equal(api.saveVideoLink('g1', LINK), 'https://www.youtube.com/watch?v=abcDEF12345');
  api.saveVideoLink('g2', 'https://www.youtube.com/watch?v=zzzzzzzzzzz');
  api.saveVideoLink('g1', 'https://youtu.be/yyyyyyyyyyy');
  assert.deepEqual(api.ss.getSheetByName('Videos').cells, [
    ['game_id', 'youtube_link'],
    ['g1', 'https://www.youtube.com/watch?v=yyyyyyyyyyy'],
    ['g2', 'https://www.youtube.com/watch?v=zzzzzzzzzzz'],
  ]);
  assert.throws(() => api.saveVideoLink('g1', 'https://vimeo.com/1'), /isn't a YouTube/);
  assert.throws(() => api.saveVideoLink('', LINK), /Pick a game/);
});

test('uploads from the app leave the video tabs alone', () => {
  const api = withPbp(pbpGame1());
  api.setVideoTime(G1, 1, 5, LINK);
  const before = JSON.stringify([api.ss.getSheetByName('PlayByPlay').cells, api.ss.getSheetByName('VideoTimes').cells]);
  assert.equal(post(api, { rows: [{ id: 'p1' }], pas: [{ id: 'a1' }] }).ok, true);
  assert.equal(JSON.stringify([api.ss.getSheetByName('PlayByPlay').cells, api.ss.getSheetByName('VideoTimes').cells]), before);
});

test('the tool page has no template-literal holes and its script parses', () => {
  const gs = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  const html = gs.slice(gs.indexOf('const VIDEO_TOOL_HTML = String.raw`'));
  assert.ok(!html.slice(36, html.lastIndexOf('`')).includes('${'));
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(html, ctx);
  const page = vm.runInContext('VIDEO_TOOL_HTML', ctx);
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /var m = s.match\(\/\[\?&#\]t=\(\\d\+\)/, 'backslashes kept');
});

// ---- team dashboard ----
const dash = (api, key) => JSON.parse(JSON.stringify(api.doPost({ postData: { contents: JSON.stringify({ action: 'dashboard', key }) } })));

test('the viewer key needs the token, is made once, and renew replaces it', () => {
  const api = load();
  api.setup();
  const bad = api.doPost({ postData: { contents: JSON.stringify({ token: 'no', action: 'viewerKey' }) } });
  assert.equal(bad.ok, false);
  assert.equal(api.props.get('VIEW_KEY'), undefined, 'nothing made without the token');
  const a = post(api, { action: 'viewerKey' });
  assert.deepEqual([a.ok, a.version], [true, 10]);
  assert.match(a.key, /^[A-Za-z0-9_-]{20,}$/);
  assert.notEqual(a.key, 'tok');
  assert.equal(post(api, { action: 'viewerKey' }).key, a.key, 'asking again gives the same key');
  const b = post(api, { action: 'viewerKey', renew: true });
  assert.notEqual(b.key, a.key);
  assert.equal(dash(api, a.key).ok, false, 'the old key stops working');
  assert.equal(dash(api, b.key).ok, true);
});

test('the dashboard reads with the viewer key only, never the token', () => {
  const api = load();
  api.setup();
  assert.equal(dash(api, 'anything').code, 'bad_key', 'no key made yet: nothing is readable');
  const { key } = post(api, { action: 'viewerKey' });
  assert.equal(dash(api, 'tok').code, 'bad_key', 'the upload token is not a viewer key');
  assert.equal(dash(api, undefined).ok, false);
  assert.equal(dash(api, '').ok, false);
  // And the viewer key can't upload or read rosters
  for (const body of [{ token: key, rows: [{ id: 'x' }] }, { token: key, action: 'rosters' }, { key, rows: [{ id: 'x' }] }]) {
    assert.equal(api.doPost({ postData: { contents: JSON.stringify(body) } }).ok, false, JSON.stringify(body));
  }
  assert.equal(api.ss.getSheetByName('Pitches').cells.length, 1, 'nothing written');
});

test('the dashboard gets every tab by header name, without deleted rows or the video formula', () => {
  const api = withPbp(pbpGame1());
  api.setup();
  post(api, {
    rows: [{ id: 'p1', game_id: 'g', batter: 'A', pitch_type: 'FB', result: 'ball' },
      { id: 'p2', game_id: 'g', batter: 'A', deleted: true }, { id: 'p3', batter: 'no game' }],
    pas: [{ id: 'a1', game_id: 'g', batter: 'A', result: 'K', session_type: 'bp' }],
  });
  api.setVideoTime(G1, 2, 75, LINK);
  api.saveVideoLink(G1, LINK);
  const { key } = post(api, { action: 'viewerKey' });
  const d = dash(api, key);
  assert.equal(d.ok, true);
  const objects = (t) => t.rows.map((r) => Object.fromEntries(t.cols.map((c, i) => [c, r[i]])));
  const pitches = objects(d.pitches);
  assert.deepEqual(pitches.map((p) => [p.game_id, p.batter, p.pitch_type, p.result]), [['g', 'A', 'FB', 'ball']]);
  assert.ok(!d.pitches.cols.includes('id') && !d.pitches.cols.includes('recorded_by'), 'only what the dashboard shows');
  assert.deepEqual(objects(d.pas).map((p) => [p.batter, p.result, p.session_type]), [['A', 'K', 'bp']]);
  assert.deepEqual(d.pbp.cols, PBP_HEADERS, 'all PlayByPlay columns but video');
  assert.equal(d.pbp.rows.length, 4);
  assert.deepEqual(objects(d.videoTimes).map((v) => [v.game_id, v.event_seq, v.seconds]), [[G1, 2, 75]]);
  assert.deepEqual(d.videos, { [G1]: 'https://www.youtube.com/watch?v=abcDEF12345' });
});

test('the dashboard works on a sheet with no PlayByPlay or video tabs', () => {
  const api = load();
  api.setup();
  const { key } = post(api, { action: 'viewerKey' });
  const d = dash(api, key);
  assert.equal(d.ok, true);
  assert.deepEqual([d.pbp.rows, d.videoTimes.rows, d.pitches.rows, d.videos, d.scoresheets], [[], [], [], {}, {}]);
});

const SHEET_URL = 'https://bsm.baseball-softball.de/matches/59813/combined_scoresheets/Spiel-10220503-1';

test('scoresheetUrl accepts scoresheet links from the federation site and nothing else', () => {
  const api = load();
  for (const ok of [SHEET_URL, ` ${SHEET_URL} `]) assert.equal(api.scoresheetUrl(ok), SHEET_URL, ok);
  for (const bad of ['', null, 'http://bsm.baseball-softball.de/matches/59813/combined_scoresheets/Spiel-10220503-1',
    'https://bsm.baseball-softball.de.evil.com/matches/59813/combined_scoresheets/Spiel-10220503-1',
    'https://evil.com/?https://bsm.baseball-softball.de/matches/59813/combined_scoresheets/Spiel-10220503-1',
    `${SHEET_URL}?x=1`, `${SHEET_URL}"><script>`, 'javascript:alert(1)',
    'https://bsm.baseball-softball.de/matches/59813/combined_scoresheets/../../users/sign_in',
    'https://bsm.baseball-softball.de/user/sign_in']) assert.equal(api.scoresheetUrl(bad), '', String(bad));
});

test('the dashboard gets scoresheet links from the Scoresheets tab, by header name', () => {
  const api = load({
    Scoresheets: [
      ['game_id', 'date', 'notation', 'scoresheet_url'],
      ['g1', '2026-05-09', 'game: g1', SHEET_URL],
      ['g2', '2026-05-09', 'game: g2', 'javascript:alert(1)'],
      ['g3', '2026-05-09', 'game: g3', ''],
      ['', '', '', SHEET_URL],
    ],
  });
  api.setup();
  const { key } = post(api, { action: 'viewerKey' });
  assert.deepEqual(dash(api, key).scoresheets, { g1: SHEET_URL }, 'only valid links, only rows with a game');
  // An older Scoresheets tab without the column: no links, no error
  api.ss.getSheetByName('Scoresheets').cells = [['game_id', 'notation'], ['g1', 'game: g1']];
  const d = dash(api, key);
  assert.deepEqual([d.ok, d.scoresheets], [true, {}]);
});
