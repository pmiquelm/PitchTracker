# PitchTracker – notes for Claude

- Offline-first PWA, plain ES modules, no build step, no runtime dependencies. Keep it that way unless there's a strong reason.
- Losing recorded pitches is the worst possible failure. Always write to IndexedDB (`js/db.js`) before updating the UI; never delete local data after sync.
- When any file in the app shell changes, bump `VERSION` in `sw.js`. If you add a file, add it to `ASSETS`.
- The sheet columns are defined twice: `PITCH_COLUMNS`/`PA_COLUMNS` in `js/game.js` and `HEADERS`/`PA_HEADERS` in `apps-script/Code.gs` (a unit test checks they match). Keep them in sync, update the Summary QUERY column letters if positions move, and bump `VERSION` in `Code.gs` (and `SCRIPT_VERSION` in `js/sync.js`) when the app needs the new script. Existing sheets are re-laid out by `setup` (`prepareSheet`), so never rely on column positions in old sheets.
- Tests: `npm test` (unit). Browser: serve on port 8765 and run `node tests/e2e.cjs <screenshot-dir>`.
- `index.html` has a strict Content-Security-Policy. Loading anything from a new host (or inline scripts/styles) needs a deliberate CSP change, so don't work around it.
- `js/vendor/qrcodegen.js` is vendored third-party code, pinned by checksum in `tests/vendor.test.js`. Never edit it by hand; to update, rebuild from a tagged upstream release as described in its header and update the pinned checksum.
- Setup links are security-sensitive: keep validation strict (`js/connect.js`), and always confirm a new connection with the sheet code.
