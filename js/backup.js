// Offline backups: export a game to a file through the iOS share sheet (save to
// Files / iCloud Drive, AirDrop, email...) and import it again later.

import { PITCH_COLUMNS, activeEvents } from './game.js';
import * as db from './db.js';

const FORMAT = 'pitchtracker-backup';

function safeName(s) {
  return String(s).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'game';
}

function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
}

// Must be called synchronously from a tap (iOS requires a user gesture for share).
export async function shareFile(name, text, type) {
  const file = new File([text], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
      // fall through to download
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  return 'downloaded';
}

export function backupJSON(game, events) {
  const text = JSON.stringify({ format: FORMAT, version: 1, exportedAt: new Date().toISOString(), game, events }, null, 1);
  return shareFile(`pitchtracker-${safeName(game.gameId)}-${stamp()}.json`, text, 'application/json');
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(events) {
  const rows = activeEvents(events).filter((e) => e.type === 'pitch').map((e) => e.row);
  return [PITCH_COLUMNS.join(','), ...rows.map((r) => PITCH_COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\n');
}

export function exportCSV(game, events) {
  return shareFile(`pitches-${safeName(game.gameId)}-${stamp()}.csv`, toCSV(events), 'text/csv');
}

// Merges a backup file into local storage. Existing events are kept as they are;
// imported pitches are queued for upload (the sheet ignores duplicates by id).
export async function importBackup(file) {
  const data = JSON.parse(await file.text());
  if (data.format !== FORMAT || !data.game || !Array.isArray(data.events)) {
    throw new Error('Not a PitchTracker backup file');
  }
  const existing = await db.getGame(data.game.key);
  if (!existing) await db.putGame(data.game);
  const added = await db.addMissingEvents(data.events.filter((e) => e.gameKey === data.game.key));
  return { game: data.game, added, newGame: !existing };
}
