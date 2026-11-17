/**
 * PitchTracker – Google Sheets receiver.
 *
 * Setup (once):
 *  1. In your Google Sheet: Extensions → Apps Script. Replace the code with this file.
 *  2. Select the `setup` function in the toolbar and click Run. Approve permissions.
 *     It creates the "Pitches", "PlateAppearances" and "Summary" sheets and logs a TOKEN (View → Logs).
 *  3. Deploy → New deployment → type "Web app".
 *     Execute as: Me.  Who has access: Anyone.  → Deploy, copy the /exec URL.
 *  4. In the app: Settings → paste the URL and the token → Save → Test connection.
 *
 * Updating from an older version: paste this file, run `setup` again (it moves existing
 * rows into the new column layout and keeps a copy of the old sheet), then
 * Deploy → Manage deployments → Edit → Version: New version → Deploy.
 *
 * Rows are upserted by `id`, so the app can safely resend the same pitch.
 */

// The app refuses to sync with a script older than this.
const VERSION = 2;

const SHEET_NAME = 'Pitches';
// Keep in sync with PITCH_COLUMNS in js/game.js (+ synced_at at the end).
const HEADERS = [
  'id', 'game_id', 'recorded_at', 'inning', 'half', 'batting_team', 'pitching_team',
  'outs_before', 'pa_number', 'pitch_number', 'pitch_in_pa', 'lineup_slot',
  'batter_number', 'batter', 'pitcher', 'pitcher_pitch_count', 'balls_before',
  'strikes_before', 'pitch_type', 'zone', 'action', 'result', 'pa_end', 'pa_result',
  'deleted', 'recorded_by', 'synced_at',
];

const PA_SHEET_NAME = 'PlateAppearances';
// Keep in sync with PA_COLUMNS in js/game.js (+ synced_at at the end).
const PA_HEADERS = [
  'id', 'game_id', 'recorded_at', 'inning', 'half', 'batting_team', 'pitching_team',
  'outs_before', 'pa_number', 'lineup_slot', 'batter_number', 'batter', 'pitcher',
  'pitches', 'balls', 'strikes', 'result', 'result_label', 'category', 'batted_ball',
  'fielder', 'outs_on_play', 'deleted', 'recorded_by', 'synced_at',
];

// Kept as text (stops "2026-05-01" turning into a date, or "1B" into something else).
const TEXT_COLUMNS = ['id', 'game_id', 'batter_number', 'recorded_by', 'batting_team', 'pitching_team',
  'result', 'fielder', 'pa_result'];

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  prepareSheet(ss, SHEET_NAME, HEADERS);
  prepareSheet(ss, PA_SHEET_NAME, PA_HEADERS);

  let summary = ss.getSheetByName('Summary');
  if (!summary) summary = ss.insertSheet('Summary');
  summary.clear();
  // Pitches column letters: O pitcher, S pitch_type, T zone, U action, X pa_result, Y deleted
  // PlateAppearances letters: F batting_team, L batter, M pitcher, R result_label, S category, W deleted
  const blocks = [
    ['Pitches by pitcher and type', '=QUERY(Pitches!A:AA, "select O, count(A) where Y = false group by O pivot S", 1)'],
    ['Batter action by pitch type', '=QUERY(Pitches!A:AA, "select S, count(A) where Y = false group by S pivot U", 1)'],
    ['Zone by pitch type', '=QUERY(Pitches!A:AA, "select S, count(A) where Y = false group by S pivot T", 1)'],
    ['Ball-in-play results by pitch type', '=QUERY(Pitches!A:AA, "select S, count(A) where Y = false and U = \'IN_PLAY\' group by S pivot X", 1)'],
    ['Results by batter', '=QUERY(PlateAppearances!A:Y, "select F, L, count(A) where W = false group by F, L pivot R", 1)'],
    ['Results against each pitcher', '=QUERY(PlateAppearances!A:Y, "select M, count(A) where W = false group by M pivot S", 1)'],
  ];
  blocks.forEach(([title, formula], i) => {
    const row = 1 + i * 30;
    summary.getRange(row, 1).setValue(title).setFontWeight('bold');
    summary.getRange(row + 1, 1).setFormula(formula);
  });

  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('TOKEN');
  if (!token) {
    token = Utilities.getUuid();
    props.setProperty('TOKEN', token);
  }
  Logger.log('TOKEN (paste into the app settings): ' + token);
}

// Creates the sheet, or brings an existing one up to the current columns.
// Existing rows are moved by column name, after saving a copy of the sheet as it was.
function prepareSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  let moved = null;
  if (lastRow > 0 && lastCol > 0) {
    const old = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    if (!sameHeaders(old, headers) && lastRow > 1) {
      const lost = old.filter((h) => h && headers.indexOf(h) < 0);
      if (lost.length) throw new Error(name + ': unknown columns ' + lost.join(', ') + '. Move them to another sheet first.');
      const copy = sheet.copyTo(ss);
      copy.setName(name + ' (before update ' + Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd HH-mm') + ')');
      const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
      const from = headers.map((h) => old.indexOf(h));
      moved = data.map((r) => from.map((i) => (i < 0 ? '' : r[i])));
      sheet.clear();
    }
  }
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  // Text formats first, so the values written next keep their exact text.
  TEXT_COLUMNS.forEach((h) => {
    const col = headers.indexOf(h) + 1;
    if (col) sheet.getRange(1, col, sheet.getMaxRows(), 1).setNumberFormat('@');
  });
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  if (moved && moved.length) sheet.getRange(2, 1, moved.length, headers.length).setValues(moved);
}

function sameHeaders(a, b) {
  const trimmed = a.slice();
  while (trimmed.length && trimmed[trimmed.length - 1] === '') trimmed.pop();
  return trimmed.length === b.length && b.every((h, i) => trimmed[i] === h);
}

function doGet() {
  return json({ ok: true, app: 'PitchTracker', version: VERSION });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  // Wait less than the app's request timeout (30 s) so a busy sheet gets a clear
  // answer, and stay inside try: an uncaught error returns Google's HTML error
  // page, which the app can only see as a failed request.
  if (!lock.tryLock(15000)) return json({ ok: false, error: 'Sheet busy (another upload is running). Try again' });
  try {
    const body = JSON.parse(e.postData.contents);
    const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token || body.token !== token) return json({ ok: false, error: 'Wrong token' });
    if (!Array.isArray(body.rows)) return json({ ok: false, error: 'No rows' });
    const pas = Array.isArray(body.pas) ? body.pas : [];

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME);
    const paSheet = ss.getSheetByName(PA_SHEET_NAME);
    if (!sheet || !paSheet) return json({ ok: false, error: 'Run setup() in the sheet script first' });
    // Writing in the wrong layout would mix up columns, so refuse until setup has run.
    if (!headersMatch(sheet, HEADERS) || !headersMatch(paSheet, PA_HEADERS)) {
      return json({ ok: false, error: 'The sheet columns are out of date: run setup() in the sheet script again' });
    }

    const r1 = upsert(sheet, HEADERS, body.rows);
    const r2 = upsert(paSheet, PA_HEADERS, pas);
    return json({ ok: true, version: VERSION, received: r1.received, appended: r1.appended, pas: r2.received });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function headersMatch(sheet, headers) {
  if (sheet.getLastColumn() < headers.length) return false;
  return sameHeaders(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String), headers);
}

// Writes rows into the sheet, replacing any row with the same id.
function upsert(sheet, headers, input) {
  // Last copy of each id in this request wins.
  const rows = new Map();
  input.forEach((r) => { if (r && r.id) rows.set(String(r.id), r); });
  if (!rows.size) return { received: 0, appended: 0 };

  const lastRow = sheet.getLastRow();
  const existing = new Map();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 1).getValues()
      .forEach((v, i) => existing.set(String(v[0]), i + 2));
  }

  const now = new Date();
  const appends = [];
  rows.forEach((r, id) => {
    const values = headers.map((h) => {
      if (h === 'synced_at') return now;
      if (h === 'recorded_at') return r.recorded_at ? new Date(r.recorded_at) : '';
      if (h === 'deleted') return r.deleted === true;
      const v = r[h];
      return v === undefined || v === null ? '' : v;
    });
    const rowNum = existing.get(id);
    if (rowNum) sheet.getRange(rowNum, 1, 1, headers.length).setValues([values]);
    else appends.push(values);
  });
  if (appends.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, appends.length, headers.length).setValues(appends);
  }
  return { received: rows.size, appended: appends.length };
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
