/**
 * PitchTracker – Google Sheets receiver.
 *
 * Setup (once):
 *  1. In your Google Sheet: Extensions → Apps Script. Replace the code with this file.
 *  2. Select the `setup` function in the toolbar and click Run. Approve permissions.
 *     It creates the "Pitches", "PlateAppearances", "Summary" and "Rosters" sheets and logs a TOKEN (View → Logs).
 *  3. Deploy → New deployment → type "Web app".
 *     Execute as: Me.  Who has access: Anyone.  → Deploy, copy the /exec URL.
 *  4. In the app: Settings → paste the URL and the token → Save → Test connection.
 *  5. Optional: in the app, Settings → Team dashboard shares a read-only link to the
 *     dashboard (dashboard/ next to the app). It carries a separate VIEW_KEY, made on first use.
 *
 * Updating: deploy the new version of this file (by hand: Deploy → Manage deployments →
 * Edit → Version: New version; or automatically from GitHub, see README). There's no need
 * to run `setup` again: if the columns changed, the first upload after the deploy moves the
 * existing rows into the new layout, after keeping a copy of the old sheet.
 *
 * Rows are upserted by `id`, so the app can safely resend the same pitch.
 */

// The app refuses to sync with a script older than its minimum. Bump this on every change:
// the deploy workflow checks the live script reports it, to confirm the deploy went live.
const VERSION = 10;

const SHEET_NAME = 'Pitches';
// Keep in sync with PITCH_COLUMNS in js/game.js (+ synced_at at the end).
const HEADERS = [
  'id', 'game_id', 'recorded_at', 'inning', 'half', 'batting_team', 'pitching_team',
  'outs_before', 'pa_number', 'pitch_number', 'pitch_in_pa', 'lineup_slot',
  'batter_number', 'batter', 'pitcher', 'pitcher_pitch_count', 'balls_before',
  'strikes_before', 'pitch_type', 'zone', 'action', 'result', 'pa_end', 'pa_result',
  'deleted', 'recorded_by', 'session_type', 'synced_at',
];

const PA_SHEET_NAME = 'PlateAppearances';
// Keep in sync with PA_COLUMNS in js/game.js (+ synced_at at the end).
const PA_HEADERS = [
  'id', 'game_id', 'recorded_at', 'inning', 'half', 'batting_team', 'pitching_team',
  'outs_before', 'pa_number', 'lineup_slot', 'batter_number', 'batter', 'pitcher',
  'pitches', 'balls', 'strikes', 'result', 'result_label', 'category', 'batted_ball',
  'fielder', 'outs_on_play', 'deleted', 'recorded_by', 'session_type', 'synced_at',
];

// session_type is "game" or "bp" (live batting practice). Rows from before it existed,
// or sent by an older app, are games.
const DEFAULTS = { session_type: 'game' };

// Kept as text (stops "2026-05-01" turning into a date, or "1B" into something else).
const TEXT_COLUMNS = ['id', 'game_id', 'batter_number', 'recorded_by', 'batting_team', 'pitching_team',
  'result', 'fielder', 'pa_result', 'session_type'];

// Rosters tab: blocks of 3 columns side by side (#, Name, a gap), one per team, edited by hand.
//   row 1: "Team" | <team name>      row 2: # | Name      rows 3+: players
// The app downloads them to fill lineups. Any block whose first cell says "Team"
// counts, so a sixth roster can be added by copying a block to the right.
const ROSTER_SHEET_NAME = 'Rosters';
const ROSTER_BLOCKS = 5;
const ROSTER_ROWS = 30; // player rows in the template; reading goes to the last filled row
const ROSTER_MAX_PLAYERS = 40;

// Run once by hand in a new sheet: creates the tabs and the token.
function setup() {
  updateLayout(SpreadsheetApp.getActiveSpreadsheet());
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('TOKEN');
  if (!token) {
    token = Utilities.getUuid();
    props.setProperty('TOKEN', token);
  }
  Logger.log('TOKEN (paste into the app settings): ' + token);
}

// Brings both data tabs to the current columns (keeping a copy of any tab whose rows
// have to move) and rebuilds Summary, whose formulas use column letters. Safe to repeat.
function updateLayout(ss) {
  prepareSheet(ss, SHEET_NAME, HEADERS);
  prepareSheet(ss, PA_SHEET_NAME, PA_HEADERS);
  ensureRosters(ss);

  let summary = ss.getSheetByName('Summary');
  if (!summary) summary = ss.insertSheet('Summary');
  summary.clear();
  // Pitches column letters: O pitcher, S pitch_type, T zone, U action, X pa_result, Y deleted, AA session_type
  // PlateAppearances letters: F batting_team, L batter, M pitcher, R result_label, S category, W deleted, Y session_type
  // Game tables leave out live BP; the BP tables show only it (IFERROR: empty until the first session).
  const P = 'Pitches!A:AB';
  const PA = 'PlateAppearances!A:Z';
  const bp = (q) => '=IFERROR(' + q.slice(1) + ', "No live BP recorded yet")';
  const blocks = [
    ['Pitches by pitcher and type', '=QUERY(' + P + ', "select O, count(A) where Y = false and AA <> \'bp\' group by O pivot S", 1)'],
    ['Batter action by pitch type', '=QUERY(' + P + ', "select S, count(A) where Y = false and AA <> \'bp\' group by S pivot U", 1)'],
    ['Zone by pitch type', '=QUERY(' + P + ', "select S, count(A) where Y = false and AA <> \'bp\' group by S pivot T", 1)'],
    ['Ball-in-play results by pitch type', '=QUERY(' + P + ', "select S, count(A) where Y = false and AA <> \'bp\' and U = \'IN_PLAY\' group by S pivot X", 1)'],
    ['Results by batter', '=QUERY(' + PA + ', "select F, L, count(A) where W = false and Y <> \'bp\' group by F, L pivot R", 1)'],
    ['Results against each pitcher', '=QUERY(' + PA + ', "select M, count(A) where W = false and Y <> \'bp\' group by M pivot S", 1)'],
    ['Live BP: pitches by pitcher and type', bp('=QUERY(' + P + ', "select O, count(A) where Y = false and AA = \'bp\' group by O pivot S", 1)')],
    ['Live BP: batter action by pitch type', bp('=QUERY(' + P + ', "select S, count(A) where Y = false and AA = \'bp\' group by S pivot U", 1)')],
    ['Live BP: results by batter', bp('=QUERY(' + PA + ', "select L, count(A) where W = false and Y = \'bp\' group by L pivot R", 1)')],
    ['Live BP: batter vs pitcher (plate appearances)', bp('=QUERY(' + PA + ', "select M, count(A) where W = false and Y = \'bp\' group by M pivot L", 1)')],
  ];
  blocks.forEach(([title, formula], i) => {
    const row = 1 + i * 30;
    summary.getRange(row, 1).setValue(title).setFontWeight('bold');
    summary.getRange(row + 1, 1).setFormula(formula);
  });
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
      moved = data.map((r) => from.map((i, j) => (i < 0 ? (DEFAULTS[headers[j]] || '') : r[i])));
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

// Creates the Rosters template if the tab doesn't exist. Never touches an existing one.
// The one exception: an empty template from version 4, which had a Pos column, is
// replaced by the current one (nobody has typed anything into it yet).
function ensureRosters(ss) {
  let sheet = ss.getSheetByName(ROSTER_SHEET_NAME);
  if (sheet && !isEmptyPosTemplate(sheet)) return sheet;
  if (sheet) sheet.clear();
  else sheet = ss.insertSheet(ROSTER_SHEET_NAME);
  if (sheet.getMaxColumns() < ROSTER_BLOCKS * 3) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), ROSTER_BLOCKS * 3 - sheet.getMaxColumns());
  }
  for (let b = 0; b < ROSTER_BLOCKS; b++) {
    const col = 1 + b * 3;
    // Numbers as text, so "07" stays "07".
    sheet.getRange(1, col, ROSTER_ROWS + 2, 1).setNumberFormat('@');
    sheet.getRange(1, col, 2, 2).setValues([['Team', ''], ['#', 'Name']]).setFontWeight('bold');
  }
  sheet.setFrozenRows(2);
  return sheet;
}

function isEmptyPosTemplate(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (!lastRow || !lastCol || lastRow > 2) return false;
  const cells = [].concat.apply([], sheet.getRange(1, 1, lastRow, lastCol).getValues()).map(String);
  return cells.indexOf('Pos') >= 0 && cells.every((v) => ['', 'Team', '#', 'Name', 'Pos'].indexOf(v) >= 0);
}

// Reads every roster block that has at least one player.
function readRosters(ss) {
  const sheet = ensureRosters(ss);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 3 || lastCol < 2) return [];
  // One extra column, so the last block's Name is read even if it's the sheet's last filled column.
  const cells = sheet.getRange(1, 1, lastRow, Math.min(sheet.getMaxColumns(), lastCol + 1)).getValues();
  const text = (v) => String(v === null || v === undefined ? '' : v).trim();
  const rosters = [];
  for (let c = 0; c < lastCol; c++) {
    if (text(cells[0][c]).toLowerCase() !== 'team') continue;
    const players = [];
    for (let r = 2; r < cells.length && players.length < ROSTER_MAX_PLAYERS; r++) {
      const name = text(cells[r][c + 1]);
      if (name) players.push({ number: text(cells[r][c]), name: name });
    }
    if (players.length) rosters.push({ name: text(cells[0][c + 1]) || 'Roster ' + (rosters.length + 1), players: players });
  }
  return rosters;
}

function doGet() {
  return json({ ok: true, app: 'PitchTracker', version: VERSION });
}

function doPost(e) {
  // The team dashboard only reads, with its own key (never the token), and doesn't wait for
  // the lock: reading never gets in the way of an upload.
  const body = parseBody_(e);
  if (body && body.action === 'dashboard') return dashboard_(body);
  const lock = LockService.getScriptLock();
  // Wait less than the app's request timeout (30 s) so a busy sheet gets a clear
  // answer, and stay inside try: an uncaught error returns Google's HTML error
  // page, which the app can only see as a failed request.
  if (!lock.tryLock(15000)) return json({ ok: false, error: 'Sheet busy (another upload is running). Try again' });
  try {
    if (!body) JSON.parse(e.postData.contents); // throws the reason, answered below
    const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token || body.token !== token) return json({ ok: false, error: 'Wrong token' });
    if (body.action === 'viewerKey') {
      return json({ ok: true, version: VERSION, key: viewerKey_(body.renew === true) });
    }
    if (body.action === 'rosters') {
      return json({ ok: true, version: VERSION, rosters: readRosters(SpreadsheetApp.getActiveSpreadsheet()) });
    }
    if (!Array.isArray(body.rows)) return json({ ok: false, error: 'No rows' });
    const pas = Array.isArray(body.pas) ? body.pas : [];

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    // First request after a deploy that changed the columns (or a tab was deleted):
    // update the layout now, under the lock, before writing anything.
    if (!layoutCurrent(ss)) updateLayout(ss);
    // Writing in the wrong layout would mix up columns, so never write unless it matches.
    if (!layoutCurrent(ss)) {
      return json({ ok: false, error: 'The sheet columns could not be updated: run setup() in the sheet script' });
    }
    const sheet = ss.getSheetByName(SHEET_NAME);
    const paSheet = ss.getSheetByName(PA_SHEET_NAME);

    const r1 = upsert(sheet, HEADERS, body.rows);
    const r2 = upsert(paSheet, PA_HEADERS, pas);
    return json({ ok: true, version: VERSION, received: r1.received, appended: r1.appended, pas: r2.received });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function layoutCurrent(ss) {
  const sheet = ss.getSheetByName(SHEET_NAME);
  const paSheet = ss.getSheetByName(PA_SHEET_NAME);
  return !!(sheet && paSheet && headersMatch(sheet, HEADERS) && headersMatch(paSheet, PA_HEADERS));
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
      return v === undefined || v === null || v === '' ? (DEFAULTS[h] || '') : v;
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

function parseBody_(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    return body && typeof body === 'object' ? body : null;
  } catch (err) {
    return null;
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---- Team dashboard (read-only) ----
// dashboard/ next to the app reads everything it shows with one request: {action: 'dashboard',
// key}. The key is VIEW_KEY, not the upload TOKEN: it can only read, and replacing it (from the
// app's Settings, which needs the TOKEN) stops every old dashboard link without touching uploads.

const VIEW_KEY_PROPERTY = 'VIEW_KEY';
const DASH_PITCH_COLUMNS = ['game_id', 'inning', 'half', 'batting_team', 'pitching_team', 'pa_number',
  'pitch_number', 'pitch_in_pa', 'batter', 'pitcher', 'balls_before', 'strikes_before', 'pitch_type',
  'zone', 'action', 'result', 'pa_end', 'session_type'];
const DASH_PA_COLUMNS = ['game_id', 'inning', 'half', 'batting_team', 'pitching_team', 'pa_number',
  'batter', 'pitcher', 'pitches', 'result', 'result_label', 'category', 'session_type'];
const DASH_VIDEO_TIME_COLUMNS = ['game_id', 'event_seq', 'event_code', 'batter', 'seconds'];

// The current viewer key, made the first time it's asked for. `renew` replaces it.
function viewerKey_(renew) {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty(VIEW_KEY_PROPERTY);
  if (!key || renew) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty(VIEW_KEY_PROPERTY, key);
  }
  return key;
}

function dashboard_(body) {
  const key = PropertiesService.getScriptProperties().getProperty(VIEW_KEY_PROPERTY);
  if (!key || typeof body.key !== 'string' || body.key !== key) {
    return json({ ok: false, code: 'bad_key', error: 'This dashboard link has been replaced. Ask for the new one' });
  }
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    return json({
      ok: true,
      version: VERSION,
      at: new Date().toISOString(),
      pitches: readTab_(ss, SHEET_NAME, DASH_PITCH_COLUMNS, true),
      pas: readTab_(ss, PA_SHEET_NAME, DASH_PA_COLUMNS, true),
      pbp: readTab_(ss, PBP_SHEET_NAME, null, false),
      videoTimes: readTab_(ss, VIDEO_TIMES_SHEET_NAME, DASH_VIDEO_TIME_COLUMNS, false),
      videos: readVideoLinks_(ss),
      scoresheets: readScoresheetLinks_(ss),
    });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

// A tab as {cols, rows}: the given columns (or all, except PlayByPlay's video formula), found by
// header name, so a moved column never mixes data up. Rows without a game and deleted rows are
// left out; dates become 'yyyy-MM-dd'.
function readTab_(ss, name, wanted, dropDeleted) {
  const sheet = ss.getSheetByName(name);
  const lastRow = sheet ? sheet.getLastRow() : 0;
  const lastCol = sheet ? sheet.getLastColumn() : 0;
  if (lastRow < 1 || lastCol < 1) return { cols: wanted || [], rows: [] };
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const header = values[0].map(cellText);
  // PlayByPlay's video column is a formula over VideoTimes, which is sent as it is.
  const cols = (wanted || header.filter((h, i) => h && h !== 'video' && !/^=/.test(h) && header.indexOf(h) === i));
  const at = cols.map((h) => header.indexOf(h));
  const game = header.indexOf('game_id');
  const deleted = dropDeleted ? header.indexOf('deleted') : -1;
  const tz = ss.getSpreadsheetTimeZone ? ss.getSpreadsheetTimeZone() : 'UTC';
  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (game < 0 || !cellText(row[game])) continue;
    if (deleted >= 0 && (row[deleted] === true || cellText(row[deleted]).toUpperCase() === 'TRUE')) continue;
    rows.push(at.map((i) => (i < 0 ? '' : dashValue_(row[i], tz))));
  }
  return { cols: cols, rows: rows };
}

function dashValue_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return cellText(v);
}

// ---- Video timestamps (play-by-play) ----
// PitchTracker → Video timestamps opens a window over the sheet with a game's YouTube video
// and its PlayByPlay events (plate appearances and plays between pitches). Enter stamps the
// highlighted event with the video's current time and moves to the next.
//
// PlayByPlay is regenerated from the Scoresheets tab, so times are never written into it.
// They live in VideoTimes, one row per event: game_id + event_seq, plus the event_code and
// batter it had when stamped, as a check. PlayByPlay's `video` column is ONE formula in its
// header cell that looks every row up in VideoTimes: regenerating the rows can't wipe or move
// a time, and if a correction changed which play has that number, the cell says "⚠ check"
// instead of linking the wrong play. Uploads from the app never touch any of this.

const PBP_SHEET_NAME = 'PlayByPlay';
const VIDEO_TIMES_SHEET_NAME = 'VideoTimes';
const VIDEO_TIMES_HEADERS = ['game_id', 'event_seq', 'event_code', 'batter', 'seconds', 'link', 'label', 'updated_at'];
const VIDEO_LINKS_SHEET_NAME = 'Videos';
const VIDEO_LINKS_HEADERS = ['game_id', 'youtube_link'];
// The Scoresheets tab (one row per transcribed game) may have a `scoresheet_url` column: the
// game's scoresheet PDF on the federation's site, shown on the dashboard's game page.
const SCORESHEETS_SHEET_NAME = 'Scoresheets';
const PBP_NEEDED = ['game_id', 'event_seq', 'event_code', 'batter'];
const MAX_VIDEO_SECONDS = 48 * 3600;

// Runs whenever the sheet is opened (a simple trigger): adds the menu.
function onOpen() {
  SpreadsheetApp.getUi().createMenu('PitchTracker')
    .addItem('Video timestamps…', 'showVideoTool')
    .addToUi();
}

function showVideoTool() {
  const html = HtmlService.createHtmlOutput(VIDEO_TOOL_HTML).setWidth(1100).setHeight(680);
  SpreadsheetApp.getUi().showModelessDialog(html, 'Video timestamps');
}

// Plays in at-bat order. The scoresheet numbers plays as they happen, so a steal during Bob's
// at-bat comes before Bob's plate appearance. Times mark when an at-bat starts, so here each plate
// appearance comes first, then the plays that happened during it. Plays after the last plate
// appearance of a half-inning (a pickoff for the third out) stay at its end. `events` must be in
// play order; each has isPa, inning and half.
function atBatOrder(events) {
  const out = [];
  let during = [];
  let half = null;
  events.forEach((e) => {
    const h = e.inning + '|' + e.half;
    if (h !== half) { out.push.apply(out, during); during = []; half = h; }
    if (e.isPa) { out.push(e); out.push.apply(out, during); during = []; } else during.push(e);
  });
  out.push.apply(out, during);
  return out;
}

// The 11-character video id from a YouTube link (watch, youtu.be, live, shorts, embed)
// or a bare id; '' if it isn't one. Strict: the id ends up inside a link.
function youtubeId(text) {
  const s = String(text == null ? '' : text).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/^(?:https?:\/\/)?(?:(?:www|m|music)\.)?(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|live\/|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/);
  return m ? m[1] : '';
}

function formatVideoTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => (n < 10 ? '0' : '') + n;
  return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}

function columnLetter(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const cellText = (v) => String(v == null ? '' : v).trim();
const eventKey = (game, seq) => cellText(game) + '|' + cellText(seq);
const eventCheck = (code, batter) => cellText(code) + '|' + cellText(batter);

function withVideoLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('The sheet is busy (an upload is running). Try again');
  try {
    return fn(SpreadsheetApp.getActiveSpreadsheet());
  } finally {
    lock.releaseLock();
  }
}

function ensureTab_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, sheet.getMaxRows(), 1).setNumberFormat('@'); // game IDs stay text
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// PlayByPlay's header positions (by name, so new columns there don't matter).
function pbpColumns_(sheet) {
  if (!sheet || sheet.getLastRow() < 1) throw new Error('There is no PlayByPlay tab yet');
  const range = sheet.getRange(1, 1, 1, sheet.getLastColumn());
  const header = range.getValues()[0].map(cellText);
  // The video header is our formula: recognise it by the formula too, not only by what it shows.
  range.getFormulas()[0].forEach((f, i) => { if (/^=\{"video"/.test(f)) header[i] = 'video'; });
  const col = {};
  header.forEach((h, i) => { if (h && !(h in col)) col[h] = i; });
  const missing = PBP_NEEDED.filter((h) => !(h in col));
  if (missing.length) throw new Error('PlayByPlay has no ' + missing.join(', ') + ' column');
  return { col: col, width: header.length };
}

function readPbp_(ss) {
  const sheet = ss.getSheetByName(PBP_SHEET_NAME);
  const c = pbpColumns_(sheet).col;
  const n = sheet.getLastRow() - 1;
  if (n < 1) return [];
  const width = Math.max.apply(null, Object.keys(c).map((k) => c[k])) + 1;
  const get = (r, name) => (name in c ? r[c[name]] : '');
  return sheet.getRange(2, 1, n, width).getValues().map((r) => ({
    game: cellText(get(r, 'game_id')),
    seq: cellText(get(r, 'event_seq')),
    date: get(r, 'date') instanceof Date ? Utilities.formatDate(get(r, 'date'), 'UTC', 'yyyy-MM-dd') : cellText(get(r, 'date')),
    inning: cellText(get(r, 'inning')),
    half: cellText(get(r, 'half')),
    team: cellText(get(r, 'batting_team')),
    batter: cellText(get(r, 'batter')),
    code: cellText(get(r, 'event_code')),
    desc: cellText(get(r, 'event_desc')),
    isPa: cellText(get(r, 'is_pa')) !== '0' && cellText(get(r, 'is_pa')).toUpperCase() !== 'FALSE',
  })).filter((e) => e.game && e.seq);
}

// key → { row, check, seconds }
function readVideoTimes_(ss) {
  const sheet = ss.getSheetByName(VIDEO_TIMES_SHEET_NAME);
  const times = {};
  if (!sheet || sheet.getLastRow() < 2) return times;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues().forEach((r, i) => {
    const sec = Number(r[4]);
    if (cellText(r[0]) && cellText(r[1]) && cellText(r[4]) !== '' && sec >= 0) {
      times[eventKey(r[0], r[1])] = { row: i + 2, check: eventCheck(r[2], r[3]), seconds: sec };
    }
  });
  return times;
}

function readVideoLinks_(ss) {
  const sheet = ss.getSheetByName(VIDEO_LINKS_SHEET_NAME);
  const links = {};
  if (!sheet || sheet.getLastRow() < 2) return links;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach((r) => {
    const id = youtubeId(r[1]);
    if (cellText(r[0]) && id) links[cellText(r[0])] = 'https://www.youtube.com/watch?v=' + id;
  });
  return links;
}

// A link to a scoresheet PDF on the federation's match system, rebuilt from its parts; '' if it
// isn't one. Strict, like youtubeId: the text ends up as a link on the dashboard.
function scoresheetUrl(text) {
  const m = String(text == null ? '' : text).trim()
    .match(/^https:\/\/bsm\.baseball-softball\.de\/matches\/(\d{1,9})\/combined_scoresheets\/(Spiel-[0-9]{1,12}-[0-9]{1,2})$/);
  return m ? 'https://bsm.baseball-softball.de/matches/' + m[1] + '/combined_scoresheets/' + m[2] : '';
}

// game_id → scoresheet link, from the Scoresheets tab's `scoresheet_url` column (found by header
// name; no column, no links).
function readScoresheetLinks_(ss) {
  const sheet = ss.getSheetByName(SCORESHEETS_SHEET_NAME);
  const links = {};
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) return links;
  const values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  const header = values[0].map(cellText);
  const game = header.indexOf('game_id');
  const url = header.indexOf('scoresheet_url');
  if (game < 0 || url < 0) return links;
  values.slice(1).forEach((r) => {
    const link = scoresheetUrl(r[url]);
    if (cellText(r[game]) && link) links[cellText(r[game])] = link;
  });
  return links;
}

// The video column's formula, built from where PlayByPlay's columns are now.
function pbpVideoFormula(col) {
  const r = (name) => columnLetter(col[name] + 1) + '2:' + columnLetter(col[name] + 1);
  const vt = (letter) => VIDEO_TIMES_SHEET_NAME + '!' + letter + '2:' + letter;
  const key = r('game_id') + '&"|"&' + r('event_seq');
  const keys = vt('A') + '&"|"&' + vt('B');
  const check = r('event_code') + '&"|"&' + r('batter');
  const look = (what) => 'XLOOKUP(' + key + ', ' + keys + ', ' + what + ')';
  // The label is worked out from the seconds (41:12, 1:02:05), not read from the label column:
  // Sheets turns a typed "26:19" into a time of day, which would show as 1.0965.
  const sec = look(vt('E'));
  const label = 'TEXT(' + sec + '/86400, IF(' + sec + '>=3600, "[h]:mm:ss", "[m]:ss"))';
  return '={"video"; ARRAYFORMULA(IF(' + r('game_id') + '="",, IFERROR(IF(' +
    look(vt('C') + '&"|"&' + vt('D')) + '=' + check + ', HYPERLINK(' + look(vt('F')) + ', ' + label +
    '), "⚠ check"))))}';
}

// Puts (or refreshes) the formula in PlayByPlay's `video` header cell: an existing `video`
// column, or a new one after the last. Safe to repeat; the generated columns aren't touched.
function ensurePbpVideoColumn_(ss) {
  ensureTab_(ss, VIDEO_TIMES_SHEET_NAME, VIDEO_TIMES_HEADERS);
  const sheet = ss.getSheetByName(PBP_SHEET_NAME);
  const info = pbpColumns_(sheet);
  const at = 'video' in info.col ? info.col.video + 1 : info.width + 1;
  if (sheet.getMaxColumns() < at) sheet.insertColumnsAfter(sheet.getMaxColumns(), at - sheet.getMaxColumns());
  sheet.getRange(1, at).setFormula(pbpVideoFormula(info.col)).setFontWeight('bold');
}

// Every game in PlayByPlay, newest first, with how many events have a time.
function videoToolGames() {
  return withVideoLock_((ss) => {
    ensurePbpVideoColumn_(ss);
    const times = readVideoTimes_(ss);
    const links = readVideoLinks_(ss);
    const games = {};
    const list = [];
    readPbp_(ss).forEach((e) => {
      let g = games[e.game];
      if (!g) {
        g = games[e.game] = { id: e.game, date: e.date, teams: [], events: 0, stamped: 0, link: links[e.game] || '' };
        list.push(g);
      }
      g.events++;
      const t = times[eventKey(e.game, e.seq)];
      if (t && t.check === eventCheck(e.code, e.batter)) g.stamped++;
      if (e.team && g.teams.indexOf(e.team) < 0) g.teams.push(e.team);
    });
    return list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1));
  });
}

// One game's events in order, each with its time. `stale`: a time was set for this event
// number, but the play there has changed since (a corrected game file); re-stamp it.
function videoToolEvents(gameId) {
  return withVideoLock_((ss) => {
    const game = cellText(gameId);
    const times = readVideoTimes_(ss);
    const events = readPbp_(ss).filter((e) => e.game === game);
    events.sort((a, b) => Number(a.seq) - Number(b.seq));
    // At-bat order: each plate appearance, then the plays during it (times mark when an at-bat starts).
    return {
      link: readVideoLinks_(ss)[game] || '',
      events: atBatOrder(events).map((e) => {
        const t = times[eventKey(e.game, e.seq)];
        const ok = !!t && t.check === eventCheck(e.code, e.batter);
        return { seq: e.seq, inning: e.inning, half: e.half, team: e.team, batter: e.batter, code: e.code,
          desc: e.desc, isPa: e.isPa, video: ok ? t.seconds : null, stale: t && !ok ? t.seconds : null };
      }),
    };
  });
}

// Saves the game's YouTube link in the Videos tab. Returns it in a standard form.
function saveVideoLink(gameId, link) {
  const game = cellText(gameId);
  const id = youtubeId(link);
  if (!game) throw new Error('Pick a game first');
  if (!id) throw new Error("That isn't a YouTube video link");
  const url = 'https://www.youtube.com/watch?v=' + id;
  return withVideoLock_((ss) => {
    const sheet = ensureTab_(ss, VIDEO_LINKS_SHEET_NAME, VIDEO_LINKS_HEADERS);
    const last = sheet.getLastRow();
    const ids = last > 1 ? sheet.getRange(2, 1, last - 1, 1).getValues().map((r) => cellText(r[0])) : [];
    const i = ids.indexOf(game);
    sheet.getRange(i < 0 ? Math.max(last, 1) + 1 : i + 2, 1, 1, 2).setValues([[game, url]]);
    return url;
  });
}

// Sets (or with seconds = null, clears) one event's video time. Returns the seconds.
function setVideoTime(gameId, eventSeq, seconds, link) {
  const clear = seconds === null || seconds === undefined || seconds === '';
  const sec = Math.floor(Number(seconds));
  const id = youtubeId(link);
  if (!clear && !(sec >= 0 && sec <= MAX_VIDEO_SECONDS)) throw new Error('Not a video time');
  if (!clear && !id) throw new Error('Load the YouTube video first');
  return withVideoLock_((ss) => {
    const game = cellText(gameId);
    const seq = cellText(eventSeq);
    const event = readPbp_(ss).filter((e) => e.game === game && e.seq === seq)[0];
    if (!event) throw new Error('That play is no longer in PlayByPlay');
    const sheet = ensureTab_(ss, VIDEO_TIMES_SHEET_NAME, VIDEO_TIMES_HEADERS);
    const existing = readVideoTimes_(ss)[eventKey(game, seq)];
    if (clear) {
      if (existing) sheet.deleteRow(existing.row);
      return null;
    }
    const row = [game, Number(seq), event.code, event.batter, sec,
      'https://www.youtube.com/watch?v=' + id + '&t=' + sec + 's', formatVideoTime(sec), new Date()];
    const at = existing ? existing.row : Math.max(sheet.getLastRow(), 1) + 1;
    sheet.getRange(at, 7).setNumberFormat('@'); // the label stays text ("26:19", not a time of day)
    sheet.getRange(at, 1, 1, row.length).setValues([row]);
    ensurePbpVideoColumn_(ss);
    return sec;
  });
}

// The window's page. Inside String.raw so its regular expressions keep their backslashes.
const VIDEO_TOOL_HTML = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><base target="_blank">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #202124; background: #fff; }
  button, input, select { font: inherit; }
  button { cursor: pointer; border: 1px solid #dadce0; background: #fff; border-radius: 4px; padding: 5px 10px; }
  .top { display: flex; gap: 8px; align-items: center; padding: 8px 10px; border-bottom: 1px solid #dadce0; }
  #game { max-width: 380px; }
  #link { flex: 1; min-width: 160px; padding: 5px 8px; }
  .main { display: flex; height: calc(100vh - 48px); }
  .left { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; padding: 10px; }
  #playerBox { position: relative; flex: 1; min-height: 200px; background: #000; border-radius: 4px; overflow: hidden; }
  #playerBox iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  #msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 24px; color: #e8eaed; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  #stamp { background: #1a73e8; border-color: #1a73e8; color: #fff; font-weight: 600; padding: 8px 16px; }
  #now { font-weight: 600; }
  #manual { width: 300px; padding: 5px 8px; }
  .keys { color: #5f6368; font-size: 12px; }
  kbd { border: 1px solid #ccc; border-bottom-width: 2px; border-radius: 3px; padding: 0 4px; font: 11px ui-monospace, monospace; background: #f8f9fa; }
  .right { width: 340px; border-left: 1px solid #dadce0; display: flex; flex-direction: column; }
  #list { flex: 1; overflow: auto; outline: none; }
  .half { position: sticky; top: 0; background: #f1f3f4; font-size: 12px; font-weight: 600; padding: 4px 10px; }
  .pa { display: flex; gap: 8px; padding: 6px 10px; border-bottom: 1px solid #f1f3f4; cursor: pointer; }
  .pa:hover { background: #f8f9fa; }
  .pa.cur { background: #e8f0fe; box-shadow: inset 3px 0 #1a73e8; }
  .who { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .res { color: #5f6368; white-space: nowrap; }
  .t { min-width: 58px; text-align: right; font-variant-numeric: tabular-nums; color: #1a73e8; }
  .t.none { color: #bdc1c6; }
  .t.saving { color: #9aa0a6; }
  .t.stale { color: #b06000; }
  .pa.between .who { color: #5f6368; font-style: italic; }
  #status { min-height: 30px; padding: 6px 10px; border-top: 1px solid #dadce0; font-size: 12px; color: #5f6368; }
  #status.err { color: #c5221f; }
</style></head>
<body>
<div class="top">
  <select id="game" title="Game"><option>Loading games…</option></select>
  <input id="link" placeholder="This game's YouTube link: paste it, then Enter" autocomplete="off">
  <button id="load">Load video</button>
</div>
<div class="main">
  <div class="left">
    <div id="playerBox"><div id="player"></div><div id="msg">Loading…</div></div>
    <div class="row"><button id="stamp">Stamp play (Enter)</button><span id="now"></span></div>
    <div class="row">
      <input id="manual" placeholder="Or type a time (41:12) or paste a timed link" autocomplete="off">
      <button id="useManual">Use this time</button>
    </div>
    <div class="keys">
      <kbd>Enter</kbd> stamp and go to the next play &nbsp; <kbd>Space</kbd> play / pause &nbsp;
      <kbd>←</kbd> <kbd>→</kbd> 5 s &nbsp; <kbd>J</kbd> <kbd>L</kbd> 10 s &nbsp; <kbd>,</kbd> <kbd>.</kbd> 1 s &nbsp;
      <kbd>↑</kbd> <kbd>↓</kbd> choose a play &nbsp; <kbd>Backspace</kbd> clear its time.
      If the keys stop working, click the list.
    </div>
  </div>
  <div class="right"><div id="list" tabindex="-1"></div><div id="status"></div></div>
</div>
<script>
var S = { games: [], game: null, link: '', vid: '', ev: [], cur: 0, player: null, ready: false, api: 'loading', req: 0 };
function $(id) { return document.getElementById(id); }

function youtubeId(text) {
  var s = String(text == null ? '' : text).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  var m = s.match(/^(?:https?:\/\/)?(?:(?:www|m|music)\.)?(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|live\/|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/);
  return m ? m[1] : '';
}
// 41:12, 1:02:03, 2472, or a link with ?t=2472 / &t=2472s.
function parseTime(text) {
  var s = String(text).trim();
  var m = s.match(/[?&#]t=(\d+)s?(?![\w])/);
  if (m) return Number(m[1]);
  m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (m) return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return /^\d+$/.test(s) ? Number(s) : null;
}
function fmt(sec) {
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}
// A plate appearance shows the batter; a play between pitches (steal, wild pitch…) its description.
function who(p) { return p.isPa ? (p.batter || 'Batter') : (p.desc || p.code); }
function what(p) { return p.isPa ? (p.desc || p.code) : p.code; }
function halfName(p) {
  return (p.half === 'bottom' ? 'Bottom ' : p.half === 'top' ? 'Top ' : 'Inning ') + p.inning + (p.team ? ' · ' + p.team : '');
}
function status(text, err) { $('status').textContent = text || ''; $('status').className = err ? 'err' : ''; }
function msg(text) { $('msg').textContent = text || ''; $('msg').style.display = text ? 'flex' : 'none'; }
function focusList() { $('list').focus(); }
function run(fn, args, ok, fail) {
  var r = google.script.run
    .withSuccessHandler(ok)
    .withFailureHandler(function (e) { status((e && e.message) || String(e), true); if (fail) fail(e); });
  r[fn].apply(r, args);
}

// ---- games ----
function gameLabel(g) {
  return g.id + (g.teams.length ? ' · ' + g.teams.join(' vs ') : '') + ' · ' + g.stamped + '/' + g.events + ' timed';
}
function loadGames() {
  run('videoToolGames', [], function (games) {
    S.games = games;
    var sel = $('game');
    sel.textContent = '';
    if (!games.length) {
      sel.add(new Option('No games in PlayByPlay yet'));
      msg('PlayByPlay has no games yet.');
      return;
    }
    games.forEach(function (g) { sel.add(new Option(gameLabel(g), g.id)); });
    var first = games.filter(function (g) { return g.stamped < g.events; })[0] || games[0];
    sel.value = first.id;
    openGame(first.id);
  }, function () { msg("Couldn't read the sheet."); });
}
function currentGame() { return S.games.filter(function (g) { return g.id === S.game; })[0]; }
function updateCount() {
  var g = currentGame();
  if (!g) return;
  g.stamped = S.ev.filter(function (p) { return p.video !== null; }).length;
  var opt = $('game').options[$('game').selectedIndex];
  if (opt && opt.value === g.id) opt.text = gameLabel(g);
}
function openGame(id) {
  var req = ++S.req;
  S.game = id;
  S.ev = [];
  render();
  status('Loading plays…');
  run('videoToolEvents', [id], function (d) {
    if (req !== S.req) return;
    S.ev = d.events;
    S.link = d.link;
    $('link').value = d.link;
    var next = -1;
    S.ev.forEach(function (p, i) { if (next < 0 && p.video === null) next = i; });
    S.cur = next < 0 ? 0 : next;
    render();
    var stale = S.ev.filter(function (p) { return p.stale !== null; }).length;
    status(S.ev.length + ' plays' + (stale ? ' · ' + stale + ' marked ⚠: the play changed since its time was set, stamp it again' : ''));
    if (d.link) cue(youtubeId(d.link));
    else { S.vid = ''; msg("Paste this game's YouTube link at the top."); }
    focusList();
  });
}

// ---- player ----
function cue(id) {
  S.vid = id;
  if (S.api === 'failed') { msg("YouTube's player couldn't load here. Keep the video open on YouTube and paste timed links into the box below (right-click the video → Copy video URL at current time)."); return; }
  if (S.api !== 'ready') { msg('Loading the YouTube player…'); return; }
  if (!S.player) { makePlayer(); return; }
  S.player.cueVideoById(id);
  msg('');
}
function makePlayer() {
  msg('Loading the video…');
  S.player = new YT.Player('player', {
    videoId: S.vid,
    playerVars: { rel: 0, playsinline: 1 },
    events: {
      onReady: function () { S.ready = true; msg(''); },
      onStateChange: function () { setTimeout(focusBack, 0); },
      onError: function (e) {
        msg(e.data === 101 || e.data === 150
          ? "This video's owner doesn't allow it to play here. Keep it open on YouTube and paste timed links into the box below (right-click the video → Copy video URL at current time)."
          : "YouTube couldn't play this video (error " + e.data + '). Check the link.');
      },
    },
  });
}
// Clicking inside the video gives it the keyboard; take it back so the keys keep working.
function focusBack() {
  if (document.activeElement && document.activeElement.tagName === 'IFRAME') focusList();
}
window.addEventListener('blur', function () { setTimeout(focusBack, 200); });
function onYouTubeIframeAPIReady() {
  S.api = 'ready';
  if (S.vid) cue(S.vid);
}
function apiFailed() {
  if (S.api === 'ready') return;
  S.api = 'failed';
  if (S.vid) cue(S.vid);
}
setTimeout(function () { if (S.api !== 'ready') apiFailed(); }, 15000);
function playing() { return S.ready && S.player.getPlayerState() === 1; }
function toggle() { if (S.ready) { if (playing()) S.player.pauseVideo(); else S.player.playVideo(); } }
function seek(d) { if (S.ready) S.player.seekTo(Math.max(0, S.player.getCurrentTime() + d), true); }

// ---- the list of plays ----
function render() {
  var list = $('list');
  list.textContent = '';
  var last = null;
  S.ev.forEach(function (p, i) {
    var group = halfName(p);
    if (group !== last) {
      var h = document.createElement('div');
      h.className = 'half';
      h.textContent = group;
      list.appendChild(h);
      last = group;
    }
    var row = document.createElement('div');
    row.className = 'pa' + (p.isPa ? '' : ' between') + (i === S.cur ? ' cur' : '');
    row.dataset.i = i;
    var a = document.createElement('span'); a.className = 'who'; a.textContent = who(p);
    a.title = p.desc;
    var b = document.createElement('span'); b.className = 'res'; b.textContent = what(p);
    var t = document.createElement('span');
    var stale = p.video === null && p.stale !== null && !p.saving;
    t.className = 't' + (p.saving ? ' saving' : stale ? ' stale' : p.video === null ? ' none' : '');
    t.textContent = p.saving ? 'saving…' : stale ? '⚠ ' + fmt(p.stale) : p.video === null ? '–' : fmt(p.video);
    if (stale) t.title = 'This play changed since its time was set. Stamp it again.';
    row.appendChild(a); row.appendChild(b); row.appendChild(t);
    list.appendChild(row);
  });
  var cur = list.querySelector('.pa.cur');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
  var p = S.ev[S.cur];
  $('now').textContent = !p ? '' : 'Next: ' + who(p) + ' · ' + halfName(p) +
    (p.video !== null && !p.saving ? ' (has ' + fmt(p.video) + ': Enter replaces it)' : '');
}
function move(d) {
  if (!S.ev.length) return;
  S.cur = Math.max(0, Math.min(S.ev.length - 1, S.cur + d));
  render();
}
$('list').addEventListener('click', function (e) {
  var row = e.target.closest('.pa');
  if (!row) return;
  S.cur = Number(row.dataset.i);
  render();
  var p = S.ev[S.cur];
  if (p.video !== null && S.ready) S.player.seekTo(p.video, true);
  focusList();
});

// ---- stamping ----
function save(p, sec, onFail) {
  var before = p.video;
  p.video = sec;
  p.saving = true;
  render();
  run('setVideoTime', [S.game, p.seq, sec, S.link], function (v) {
    p.saving = false;
    p.video = v;
    p.stale = null;
    render();
    updateCount();
    status(v === null ? 'Cleared ' + who(p) : 'Saved ' + fmt(v) + ' for ' + who(p));
  }, function () {
    p.saving = false;
    p.video = before;
    if (onFail) onFail();
    render();
  });
}
function stamp(sec) {
  var p = S.ev[S.cur];
  if (!p) return;
  if (!S.link) { status("Paste this game's YouTube link at the top first", true); return; }
  if (sec === null) {
    if (!S.ready) { status("The video isn't playing here: type a time or paste a timed link in the box", true); return; }
    sec = Math.floor(S.player.getCurrentTime());
  }
  var at = S.cur;
  if (S.cur < S.ev.length - 1) S.cur++;
  save(p, sec, function () { S.cur = at; }); // not saved: back to that play
}
function clearCurrent() {
  var p = S.ev[S.cur];
  if (p && (p.video !== null || p.stale !== null) && !p.saving) save(p, null);
}
function loadLink() {
  var text = $('link').value;
  var id = youtubeId(text);
  if (!S.game) return;
  if (!id) { status("That isn't a YouTube video link", true); return; }
  run('saveVideoLink', [S.game, text], function (url) {
    S.link = url;
    $('link').value = url;
    cue(id);
    status('Video saved for this game');
    focusList();
  });
}
function useManual() {
  var text = $('manual').value.trim();
  if (!text) return;
  var sec = parseTime(text);
  if (sec === null) { status('Type a time like 41:12 or 1:02:03, or paste a YouTube link that has ?t= in it', true); return; }
  var id = youtubeId(text);
  var go = function () { $('manual').value = ''; stamp(sec); };
  // A timed link to another video (say part 2 of the game) becomes the game's link.
  if (id && id !== youtubeId(S.link)) {
    run('saveVideoLink', [S.game, text], function (url) {
      S.link = url;
      $('link').value = url;
      if (S.api === 'ready') cue(id);
      go();
    });
  } else go();
}

// Buttons never keep the keyboard, so Enter can't press one by accident.
Array.prototype.forEach.call(document.querySelectorAll('button'), function (b) {
  b.addEventListener('mousedown', function (e) { e.preventDefault(); });
});
$('stamp').addEventListener('click', function () { stamp(null); });
$('load').addEventListener('click', loadLink);
$('useManual').addEventListener('click', useManual);
$('game').addEventListener('change', function () { openGame($('game').value); });
document.addEventListener('keydown', function (e) {
  var tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT') {
    if (e.key === 'Enter' && tag === 'INPUT') {
      e.preventDefault();
      if (e.target.id === 'link') loadLink(); else useManual();
    }
    if (e.key === 'Escape') { e.target.blur(); focusList(); }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  var k = e.key.toLowerCase();
  var keys = {
    enter: function () { stamp(null); }, ' ': toggle, k: toggle,
    arrowleft: function () { seek(-5); }, arrowright: function () { seek(5); },
    j: function () { seek(-10); }, l: function () { seek(10); },
    ',': function () { seek(-1); }, '.': function () { seek(1); },
    arrowup: function () { move(-1); }, arrowdown: function () { move(1); },
    backspace: clearCurrent, delete: clearCurrent,
  };
  if (keys[k]) { e.preventDefault(); keys[k](); }
});

loadGames();
</script>
<script src="https://www.youtube.com/iframe_api" onerror="apiFailed()"></script>
</body></html>`;
