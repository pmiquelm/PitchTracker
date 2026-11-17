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
      getValues: () => Array.from({ length: nRows }, (_, i) => Array.from({ length: nCols },
        (_, j) => sheet.cells[row - 1 + i]?.[col - 1 + j] ?? '')),
      setValues: (values) => {
        values.forEach((r, i) => r.forEach((v, j) => {
          while (sheet.cells.length < row + i) sheet.cells.push([]);
          sheet.cells[row - 1 + i][col - 1 + j] = v;
        }));
        return range;
      },
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
    this.api = { setup, doPost, doGet, HEADERS, PA_HEADERS };`, ctx);
  const { HEADERS, PA_HEADERS, ...fns } = ctx.api;
  return { ss, ...fns, HEADERS: [...HEADERS], PA_HEADERS: [...PA_HEADERS] }; // copied out of the sandbox for deepEqual
}

const post = (api, body) => api.doPost({ postData: { contents: JSON.stringify({ token: 'tok', ...body }) } });

test('fresh setup, then upserts into both sheets', () => {
  const api = load();
  api.setup();
  assert.deepEqual(api.ss.getSheetByName('Pitches').cells[0], api.HEADERS);
  assert.deepEqual(api.ss.getSheetByName('PlateAppearances').cells[0], api.PA_HEADERS);
  assert.equal(api.doGet().version, 2);
  const res = post(api, { rows: [{ id: 'p1', batter: 'A', half: 'top' }], pas: [{ id: 'p1', result: '2B', fielder: 'CF' }] });
  assert.deepEqual([res.ok, res.version, res.received, res.pas], [true, 2, 1, 1]);
  post(api, { rows: [{ id: 'p1', batter: 'A', deleted: true }], pas: [] });
  const pitches = api.ss.getSheetByName('Pitches').cells;
  assert.equal(pitches.length, 2, 'upsert, not append');
  assert.equal(pitches[1][api.HEADERS.indexOf('deleted')], true);
  const pa = api.ss.getSheetByName('PlateAppearances').cells[1];
  assert.equal(pa[api.PA_HEADERS.indexOf('fielder')], 'CF');
});

test('setup moves an old Pitches sheet to the new columns and keeps a copy', () => {
  const OLD = ['id', 'game_id', 'recorded_at', 'inning', 'pa_number', 'pitch_number',
    'pitch_in_pa', 'lineup_slot', 'batter_number', 'batter', 'pitcher',
    'pitcher_pitch_count', 'balls_before', 'strikes_before', 'pitch_type',
    'zone', 'action', 'result', 'pa_end', 'deleted', 'recorded_by', 'synced_at'];
  const row = OLD.map((h) => `v-${h}`);
  const api = load({ Pitches: [OLD.slice(), row.slice()] });
  // Before setup runs again, the new script refuses to write into the old layout
  const refused = post(api, { rows: [{ id: 'x' }], pas: [] });
  assert.equal(refused.ok, false);
  api.setup();
  const sheet = api.ss.getSheetByName('Pitches');
  assert.deepEqual(sheet.cells[0], api.HEADERS);
  for (const h of OLD) assert.equal(sheet.cells[1][api.HEADERS.indexOf(h)], `v-${h}`, h);
  assert.equal(sheet.cells[1][api.HEADERS.indexOf('half')], '');
  const copy = api.ss.sheets.find((s) => s.name.startsWith('Pitches (before update'));
  assert.deepEqual(copy.cells, [OLD, row]);
  // Running setup again changes nothing and makes no second copy
  api.setup();
  assert.deepEqual(sheet.cells[1], api.HEADERS.map((h) => (OLD.includes(h) ? `v-${h}` : '')));
  assert.equal(api.ss.sheets.filter((s) => s.name.startsWith('Pitches (before')).length, 1);
  assert.equal(post(api, { rows: [{ id: 'y' }], pas: [] }).ok, true);
});

test('wrong token is refused', () => {
  const api = load();
  api.setup();
  assert.equal(api.doPost({ postData: { contents: JSON.stringify({ token: 'no', rows: [] }) } }).ok, false);
});
