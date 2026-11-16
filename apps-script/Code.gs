/**
 * PitchTracker – Google Sheets receiver.
 *
 * Setup (once):
 *  1. In your Google Sheet: Extensions → Apps Script. Replace the code with this file.
 *  2. Select the `setup` function in the toolbar and click Run. Approve permissions.
 *     It creates the "Pitches" and "Summary" sheets and logs a TOKEN (View → Logs).
 *  3. Deploy → New deployment → type "Web app".
 *     Execute as: Me.  Who has access: Anyone.  → Deploy, copy the /exec URL.
 *  4. In the app: Settings → paste the URL and the token → Save → Test connection.
 *
 * Rows are upserted by `id`, so the app can safely resend the same pitch.
 */

const SHEET_NAME = 'Pitches';
// Keep in sync with PITCH_COLUMNS in js/game.js (+ synced_at at the end).
const HEADERS = [
  'id', 'game_id', 'recorded_at', 'inning', 'pa_number', 'pitch_number',
  'pitch_in_pa', 'lineup_slot', 'batter_number', 'batter', 'pitcher',
  'pitcher_pitch_count', 'balls_before', 'strikes_before', 'pitch_type',
  'zone', 'action', 'result', 'pa_end', 'deleted', 'recorded_by', 'synced_at',
];

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  // Keep ids, game ids and jersey numbers as text (stops "2026-05-01" turning into a date).
  ['id', 'game_id', 'batter_number', 'recorded_by'].forEach((h) => {
    const col = HEADERS.indexOf(h) + 1;
    sheet.getRange(1, col, sheet.getMaxRows(), 1).setNumberFormat('@');
  });

  let summary = ss.getSheetByName('Summary');
  if (!summary) summary = ss.insertSheet('Summary');
  summary.clear();
  // Column letters: K pitcher, O pitch_type, P zone, Q action, T deleted
  const blocks = [
    ['Pitches by pitcher and type', '=QUERY(Pitches!A:V, "select K, count(A) where T = false group by K pivot O", 1)'],
    ['Batter action by pitch type', '=QUERY(Pitches!A:V, "select O, count(A) where T = false group by O pivot Q", 1)'],
    ['Zone by pitch type', '=QUERY(Pitches!A:V, "select O, count(A) where T = false group by O pivot P", 1)'],
  ];
  blocks.forEach(([title, formula], i) => {
    const row = 1 + i * 12;
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

function doGet() {
  return json({ ok: true, app: 'PitchTracker' });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const body = JSON.parse(e.postData.contents);
    const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token || body.token !== token) return json({ ok: false, error: 'Wrong token' });
    if (!Array.isArray(body.rows)) return json({ ok: false, error: 'No rows' });

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) return json({ ok: false, error: 'Run setup() first' });

    // Last copy of each id in this request wins.
    const rows = new Map();
    body.rows.forEach((r) => { if (r && r.id) rows.set(String(r.id), r); });

    const lastRow = sheet.getLastRow();
    const existing = new Map();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, 1).getValues()
        .forEach((v, i) => existing.set(String(v[0]), i + 2));
    }

    const now = new Date();
    const appends = [];
    rows.forEach((r, id) => {
      const values = HEADERS.map((h) => {
        if (h === 'synced_at') return now;
        if (h === 'recorded_at') return r.recorded_at ? new Date(r.recorded_at) : '';
        if (h === 'deleted') return r.deleted === true;
        const v = r[h];
        return v === undefined || v === null ? '' : v;
      });
      const rowNum = existing.get(id);
      if (rowNum) sheet.getRange(rowNum, 1, 1, HEADERS.length).setValues([values]);
      else appends.push(values);
    });
    if (appends.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, appends.length, HEADERS.length).setValues(appends);
    }
    return json({ ok: true, received: rows.size, appended: appends.length });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
