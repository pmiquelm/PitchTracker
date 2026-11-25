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
  clear() { this.cells = []; }
  copyTo(ss) { const c = ss.insertSheet(`Copy of ${this.name}`); c.cells = this.cells.map((r) => r.slice()); return c; }
  setName(n) { this.name = n; return this; }
  getRange(row, col, nRows = 1, nCols = 1) {
    if (col + nCols - 1 > this.maxCols) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    const sheet = this;
    const range = {
      // A formula is stored as its text; reading values gives a stand-in for what it shows,
      // so code that copies values instead of formulas loses it, as in Sheets.
      getValues: () => Array.from({ length: nRows }, (_, i) => Array.from({ length: nCols }, (_, j) => {
        const v = sheet.cells[row - 1 + i]?.[col - 1 + j] ?? '';
        return typeof v === 'string' && v.startsWith('=') ? `(shows ${v})` : v;
      })),
      getFormulas: () => Array.from({ length: nRows }, (_, i) => Array.from({ length: nCols }, (_, j) => {
        const v = sheet.cells[row - 1 + i]?.[col - 1 + j];
        return typeof v === 'string' && v.startsWith('=') ? v : '';
      })),
      setValues: (values) => {
        values.forEach((r, i) => r.forEach((v, j) => {
          while (sheet.cells.length < row + i) sheet.cells.push([]);
          sheet.cells[row - 1 + i][col - 1 + j] = v;
        }));
        return range;
      },
      setValue: (v) => range.setValues([[v]]),
      setFormula: (f) => range.setValues([[f]]),
      clearContent: () => range.setValues(Array.from({ length: nRows }, () => Array(nCols).fill(''))),
      setFontWeight: () => range,
      setNumberFormat: () => range,
    };
    return range;
  }
}

function load(sheets = {}) {
  const ss = {
    sheets: Object.entries(sheets).map(([name, cells]) => Object.assign(new FakeSheet(name), { cells })),
    getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; },
    insertSheet(n) { const s = new FakeSheet(n); this.sheets.push(s); return s; },
  };
  const props = new Map([['TOKEN', 'tok']]);
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k), setProperty: (k, v) => props.set(k, v) }) },
    Utilities: { getUuid: () => 'uuid', formatDate: () => '2026-11-17 10-00' },
    Logger: { log() {} },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    ContentService: { createTextOutput: (t) => ({ setMimeType: () => JSON.parse(t) }), MimeType: { JSON: 'json' } },
  };
  vm.createContext(ctx);
  vm.runInContext(`${readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8')}
    this.api = { setup, doPost, doGet, HEADERS, PA_HEADERS, youtubeId, videoToolGames, videoToolPas, saveVideoLink, setVideoTime };`, ctx);
  const { HEADERS, PA_HEADERS, ...fns } = ctx.api;
  return { ss, ...fns, HEADERS: [...HEADERS], PA_HEADERS: [...PA_HEADERS] }; // copied out of the sandbox for deepEqual
}

const post = (api, body) => api.doPost({ postData: { contents: JSON.stringify({ token: 'tok', ...body }) } });

test('fresh setup, then upserts into both sheets', () => {
  const api = load();
  api.setup();
  assert.deepEqual(api.ss.getSheetByName('Pitches').cells[0], api.HEADERS);
  assert.deepEqual(api.ss.getSheetByName('PlateAppearances').cells[0], api.PA_HEADERS);
  assert.equal(api.doGet().version, 7);
  const res = post(api, { rows: [{ id: 'p1', batter: 'A', half: 'top' }], pas: [{ id: 'p1', result: '2B', fielder: 'CF' }] });
  assert.deepEqual([res.ok, res.version, res.received, res.pas], [true, 7, 1, 1]);
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
  assert.equal(res.version, 7);
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

// ---- Video timestamps ----
const LINK = 'https://youtu.be/abcDEF12345?si=x';
const videoCell = (api, id) => {
  const sheet = api.ss.getSheetByName('PlateAppearances');
  const row = sheet.cells.find((r) => r[0] === id);
  return row[api.PA_HEADERS.indexOf('video')] ?? '';
};

test('youtubeId accepts the usual YouTube links and nothing else', () => {
  const api = load();
  for (const ok of ['https://www.youtube.com/watch?v=abcDEF12345', 'youtube.com/watch?feature=x&v=abcDEF12345&t=5',
    'https://youtu.be/abcDEF12345?t=42', 'https://m.youtube.com/live/abcDEF12345', 'https://www.youtube.com/shorts/abcDEF12345',
    'abcDEF12345', ' https://www.youtube.com/embed/abcDEF12345 ']) assert.equal(api.youtubeId(ok), 'abcDEF12345', ok);
  for (const bad of ['', 'https://vimeo.com/abcDEF12345', 'https://evil.com/youtu.be/abcDEF12345',
    'https://youtu.be/abcDEF1234', 'https://youtu.be/abcDEF123456', 'abc"DEF1234', null]) assert.equal(api.youtubeId(bad), '', bad);
});

test('video times: written as a link, and uploads never overwrite them', () => {
  const api = load();
  api.setup();
  post(api, { rows: [], pas: [{ id: 'pa1', game_id: 'g1', result: '1B' }] });
  assert.equal(api.setVideoTime('pa1', 2472.8, LINK), 2472);
  const formula = '=HYPERLINK("https://www.youtube.com/watch?v=abcDEF12345&t=2472s", "41:12")';
  assert.equal(videoCell(api, 'pa1'), formula);
  // The phone resends the row (an undo, a late outcome) and adds another
  post(api, { rows: [], pas: [{ id: 'pa1', game_id: 'g1', result: '2B', deleted: true }, { id: 'pa2', game_id: 'g1' }] });
  assert.equal(videoCell(api, 'pa1'), formula);
  assert.equal(videoCell(api, 'pa2'), '');
  assert.equal(api.setVideoTime('pa2', 3725, 'abcDEF12345'), 3725);
  assert.match(videoCell(api, 'pa2'), /t=3725s", "1:02:05"\)$/);
  assert.equal(api.setVideoTime('pa1', null, ''), null);
  assert.equal(videoCell(api, 'pa1'), '');
  assert.throws(() => api.setVideoTime('pa2', 5, 'https://vimeo.com/1'), /Load the YouTube video/);
  assert.throws(() => api.setVideoTime('pa2', -1, LINK), /Not a video time/);
  assert.throws(() => api.setVideoTime('pa2', 'x', LINK), /Not a video time/);
  assert.throws(() => api.setVideoTime('nope', 5, LINK), /no longer in the sheet/);
});

test('a PlateAppearances tab from before the video column gets it on the next upload', () => {
  const OLD_PA = [...load().PA_HEADERS.filter((h) => h !== 'video')];
  const row = OLD_PA.map((h) => (h === 'deleted' ? false : `v-${h}`));
  const api = load({ PlateAppearances: [OLD_PA.slice(), row.slice()] });
  assert.equal(post(api, { rows: [], pas: [] }).ok, true);
  const cells = api.ss.getSheetByName('PlateAppearances').cells;
  assert.deepEqual(cells[0], api.PA_HEADERS);
  assert.deepEqual(cells[1].slice(0, OLD_PA.length), row);
  assert.equal(cells[1][api.PA_HEADERS.indexOf('video')], '');
});

test('moving to a new layout keeps video links as formulas', () => {
  const api0 = load();
  // A layout with a column missing, as a future change might leave it
  const old = api0.PA_HEADERS.filter((h) => h !== 'fielder');
  const link = '=HYPERLINK("https://www.youtube.com/watch?v=abcDEF12345&t=60s", "1:00")';
  const row = old.map((h) => (h === 'video' ? link : h === 'id' ? 'pa1' : ''));
  const api = load({ PlateAppearances: [old.slice(), row] });
  api.setup();
  assert.equal(videoCell(api, 'pa1'), link);
});

test('the tool lists games and their at-bats in order, without undone ones', () => {
  const api = load();
  api.setup();
  const pa = (id, game, n, at, extra = {}) => ({ id, game_id: game, pa_number: n, recorded_at: at, batting_team: 'T' + (n % 2),
    batter: 'B' + n, result_label: 'Single', inning: 1, half: n % 2 ? 'top' : 'bottom', ...extra });
  post(api, { rows: [], pas: [
    pa('a3', 'old', 3, '2026-05-01T10:03:00Z'), pa('a1', 'old', 1, '2026-05-01T10:00:00Z'),
    pa('a2', 'old', 2, '2026-05-01T10:01:00Z', { deleted: true }), pa('a2b', 'old', 2, '2026-05-01T10:02:00Z'),
    pa('b1', 'new', 1, '2026-06-01T10:00:00Z'),
  ] });
  api.setVideoTime('a1', 30, LINK);
  const games = JSON.parse(JSON.stringify(api.videoToolGames()));
  assert.deepEqual(games.map((g) => [g.id, g.pas, g.stamped, g.teams.length]), [['new', 1, 0, 1], ['old', 3, 1, 2]]);
  const d = JSON.parse(JSON.stringify(api.videoToolPas('old')));
  assert.deepEqual(d.pas.map((p) => [p.id, p.video]), [['a1', 30], ['a2b', null], ['a3', null]]);
  assert.deepEqual([d.pas[0].batter, d.pas[0].result, d.pas[0].half, d.link], ['B1', 'Single', 'top', '']);
});

test('saveVideoLink keeps one link per game in the Videos tab', () => {
  const api = load();
  api.setup();
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
  post(api, { rows: [], pas: [{ id: 'p', game_id: 'g2' }] });
  assert.equal(api.videoToolPas('g2').link, 'https://www.youtube.com/watch?v=zzzzzzzzzzz');
});

test('the tool page has no template-literal holes and its script parses', () => {
  const gs = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  const html = gs.slice(gs.indexOf('const VIDEO_TOOL_HTML = String.raw`'));
  assert.ok(!html.slice(36, html.lastIndexOf('`')).includes('${'));
  const ctx = { api: null };
  vm.createContext(ctx);
  vm.runInContext(html, ctx);
  const page = vm.runInContext('VIDEO_TOOL_HTML', ctx);
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /var m = s.match\(\/\[\?&#\]t=\(\\d\+\)/, 'backslashes kept');
});
