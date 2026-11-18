// Team rosters, downloaded from the sheet's Rosters tab. They only help fill in
// lineups: games keep the names they were started with, so a roster that changes
// (or disappears) later never changes recorded pitches.

const MAX_ROSTERS = 20;
const MAX_PLAYERS = 40;
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// Turns whatever the script sent into [{ name, players: [{ number, name }] }].
export function normalizeRosters(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw.slice(0, MAX_ROSTERS)) {
    if (!r || !Array.isArray(r.players)) continue;
    const players = [];
    for (const p of r.players.slice(0, MAX_PLAYERS)) {
      const name = clean(p?.name, 60);
      if (name) players.push({ number: clean(p.number, 4), name });
    }
    if (players.length) out.push({ name: clean(r.name, 60) || `Roster ${out.length + 1}`, players });
  }
  return out;
}

const key = (s) => String(s ?? '').trim().toLowerCase();

// The roster player a typed name means (exact match, ignoring case and spacing).
export function findByName(players, name) {
  const k = key(name).replace(/\s+/g, ' ');
  return k ? (players || []).find((p) => key(p.name) === k) || null : null;
}

export function findByNumber(players, number) {
  const k = key(number);
  if (!k) return null;
  const hits = (players || []).filter((p) => key(p.number) === k);
  return hits.length === 1 ? hits[0] : null; // two players sharing a number: don't guess
}
