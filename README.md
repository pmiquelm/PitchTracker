# PitchTracker

Record every pitch of a baseball game on an iPhone or iPad, even with no signal. Every pitch goes into a Google
Sheet, and a **team dashboard** shows the games, with their videos, and every hitter and pitcher to anyone you send
its link.

<img src="docs/screenshot-phone.png" width="260" alt="Tracker on a phone"> <img src="docs/screenshot-ipad.png" width="420" alt="Tracker on an iPad">

> **In-depth guide:** [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) explains the whole system from first principles,
> with links to the code. Its [section 13](docs/HOW-IT-WORKS.md#13-keys-tokens-and-sign-ins) covers every key and
> sign-in: who can record, who can read, who can deploy.

## What's in it

| Part | Who uses it | What it does |
|---|---|---|
| **The app** (`/PitchTracker/`) | Recorders, on a phone or iPad | Records pitches, outcomes and live BP; works offline; uploads to the sheet |
| **The Google Sheet** | You | Holds every pitch (**Pitches**) and plate appearance (**PlateAppearances**), the **Rosters** you type in, a **Summary**, and, if you transcribe scoresheets, **PlayByPlay** with **video timestamps** |
| **The team dashboard** (`/PitchTracker/dashboard/`) | The team, read-only | Games with their video, box scores and win probability; hitters and pitchers, alone or compared with the team; leaderboards |

There is no server of our own: the app and the dashboard are plain files on GitHub Pages, and a small Google Apps
Script attached to the sheet receives the pitches and answers the dashboard.

## Recording a game

- **Three pads per pitch:** Pitch (Fastball / Curveball), Zone (In / Out) and Batter (Take / Swing / Foul / In play).
  The pitch is saved as soon as all three are chosen. Pads can be tapped in any order; tapping one again unselects it.
- **The count updates itself.** A take in the zone is a called strike, a take out of it a ball. A swing is always a
  strike. A foul is a strike unless there are already two.
- **Both teams.** Enter the away and home lineups (or leave the opponent blank: they become *Batter 1–9*) and each
  team's pitcher. The away team bats in the top of each inning; each team keeps its own place in the order and its own
  pitch count.
- **Ball in play → outcome pads:** **Hit** (single / double / triple / home run), **Out** (ground / line / fly out,
  double play), **Fielder's choice**, **Sac** (bunt / fly) or **Error** (on a grounder / liner / fly), then **where the
  ball went** (P, C, 1B … RF, or Skip). **‹ Back** goes up a level. Each result is a row in **PlateAppearances**.
- **Outs, half-innings and the next batter are automatic.** Use **Outs − / +** for anything else (caught stealing,
  pickoff) and **Inning − / +** to correct. **Next batter ›** asks why: *Hit by pitch*, *Intentional walk*,
  *Catcher's interference*, *Out by rule* or *Other / correction*.
- **Lineup / Subs:** rename a lineup spot to make a substitution, change either pitcher, or pick the current batter to
  fix a mistake. A sub in the middle of a plate appearance keeps the count.
- **Undo** reverses the last action of any kind. An undone pitch or result stays in the sheet with `deleted = TRUE`.
- **Rosters:** on **New game** the app downloads the sheet's Rosters tab (and keeps a copy for no signal). Tap players
  into the batting order and pick the starting pitcher, so names are spelled exactly as in the sheet.
- **Live BP** (**＋ Live BP** on the home screen): your own pitchers against your own hitters. No batting order, innings
  or outs: after every at-bat, **Who's up?** offers the roster. **End AB**, **Batter** and **Pitcher** handle the rest.
  Rows go to the same tabs with `session_type` = `bp`.

### How your data is kept safe

1. Each pitch is written to the phone's storage *before* the screen updates.
2. The app asks iOS to keep its storage, and it must run from the Home Screen (it warns you otherwise).
3. Pitches upload as soon as there's signal, and the app retries on reconnect, when reopened, and every 30 s. Every
   pitch has a unique id and the sheet *updates* rows by id, so resending never creates duplicates.
4. The badge at the top always shows the state: **✓ All synced** or **⚠ N not uploaded**.
5. Nothing is deleted from the phone after it uploads.
6. **☰ → Back up game (file)** saves a full backup through the share sheet, with no signal needed. **Import backup**
   on the home screen restores it and uploads anything the sheet is missing.

## Setup

### 1. Host the app (GitHub Pages, free)

On GitHub: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save**. After a
minute the app is at `https://<your-user>.github.io/PitchTracker/` and the dashboard at `…/PitchTracker/dashboard/`.

### 2. Connect the Google Sheet

1. Create a Google Sheet, then **Extensions → Apps Script**.
2. Delete the sample code, paste in everything from [`apps-script/Code.gs`](apps-script/Code.gs), and save.
3. Choose **`setup`** in the toolbar and click **Run**. Approve the permissions (it's your own script: *Advanced → Go
   to project* if Google warns you). This creates the tabs and the **upload token**: open **Execution log** and copy
   the TOKEN.
4. **Deploy → New deployment** → gear icon → **Web app**. *Execute as*: **Me**. *Who has access*: **Anyone**. Click
   **Deploy** and copy the **Web app URL** (it ends in `/exec`).
5. Open the app's address in **Safari** → **Settings**, paste the URL and the token, **Save**, then **Test connection**.

"Anyone" means phones reach the script without signing in to Google. The script itself refuses to write without the
token, and refuses to read without the dashboard's key.

To change the script later, **never** use *New deployment* (that makes a new address and disconnects every phone):
use **Deploy → Manage deployments → Edit → Version: New version**, or let GitHub do it (step 7).

### 3. Install the app on the iPhone / iPad

1. **After** step 2, the app's home screen in Safari shows *Install on this phone*. Tap **Copy setup link**.
2. **Share → Add to Home Screen**.
3. Open the new icon. If it isn't connected, tap **Paste & connect** (and **Paste** in the bubble iOS shows).

From then on, always open it from the icon. (An app added to the Home Screen starts with empty storage, so the
connection is carried over through the clipboard.)

**Android** (Chrome, Samsung Internet, Edge): connect in the browser, then tap **Install app** (or **⋮ → Install
app**). The installed app shares the browser's storage, so it's already connected.

### 4. Add other recorders

In the app, **Settings → Share with other recorders → Share setup link** (text, WhatsApp, email), or in person **Show
QR code** and let them scan it with the phone's **Camera** app (it disappears after 60 s). Their phone shows a **sheet
code** like `K7Q-X2M` before connecting: check it matches yours in Settings. On iPhone they then do step 3.

The setup link carries the upload token: anyone with it can add pitches to your sheet. Send it only to recorders.
`recorded_by` in the sheet shows who recorded each pitch (**Settings → Your name**, or a device id).

### 5. Share the team dashboard

In the app, **Settings → Team dashboard → Share link** (or **QR code**, or **Open** to see it yourself). Anyone with the
link can *see* everything in the dashboard; nobody can change anything, and no Google account is needed. The first
time, the dashboard asks to confirm the sheet code.

The link carries a separate, read-only **viewer key**, never the upload token. **Replace the link…** makes a new key:
every old dashboard link stops working, and recorders aren't affected.

### 6. Share the sheet itself (optional)

For people who should see the raw data: Google Sheets **Share → Viewer**. Give **Editor** only to people you'd trust
with the script, because an editor can open the script and its keys.

### 7. Automatic script updates (optional)

A GitHub Action ([`.github/workflows/deploy-apps-script.yml`](.github/workflows/deploy-apps-script.yml)) deploys
`Code.gs` whenever it changes on `main`, as a new version of your **existing** deployment, so the address and every
link stay the same. From then on the repository is the source of truth: edits made in the Apps Script editor are
overwritten.

1. Turn on **Google Apps Script API** at <https://script.google.com/home/usersettings>.
2. On a computer with Node.js, run `npx @google/clasp@3.4.1 login` and allow access. This creates `.clasprc.json` in
   your home folder.
3. Find two IDs in the Apps Script editor: the **Script ID** (⚙ **Project Settings** → *IDs*) and the **Deployment ID**
   (**Deploy → Manage deployments**; the middle of the `/exec` address).
4. On GitHub: **Settings → Environments → New environment** `apps-script`; under *Deployment branches and tags* choose
   **Selected branches and tags** and add `main`. Add three **environment secrets**:

   | Secret | Value |
   |---|---|
   | `CLASPRC_JSON` | The whole contents of `.clasprc.json` |
   | `APPS_SCRIPT_ID` | The script ID |
   | `APPS_SCRIPT_DEPLOYMENT_ID` | The deployment ID |

5. **Actions → Deploy Apps Script → Run workflow** once to check it works.

`CLASPRC_JSON` is a password to *all* your Apps Script projects: only workflows on `main` can read it, and you can cut
it off at <https://myaccount.google.com/permissions>. How the deploy works and what to do when it fails:
[guide section 17](docs/HOW-IT-WORKS.md#17-editing-the-google-script-how-the-build-works).

You never need to run `setup` again after a deploy: if the columns changed, the first upload moves the existing rows
into the new layout, after keeping a copy of the old tab. Until a script the app needs is live, phones keep everything
and show *the sheet script is out of date*.

## In the sheet

- **Rosters:** 5 blocks side by side, one per team: the team name next to **Team**, then **#** and **Name**, up to 40
  players. Copy a block to the right for a sixth team. A game keeps the roster it started with.
- **Summary:** starter pivots for games (pitches by pitcher and type, batter action, zone, ball-in-play results,
  results by batter and against each pitcher) and the same for live BP. Rebuilt on every layout change: build your own
  tables in a tab of your own.
- **Your own dashboards:** [Looker Studio](https://lookerstudio.google.com) → **Create → Data source → Google Sheets →
  Pitches**, with a filter `deleted = false` and a control on `session_type`; add **PlateAppearances** for results.

### Video timestamps (optional)

If a game is on YouTube, every play in the **PlayByPlay** tab (transcribed from the scoresheets) can be linked to its
moment in the video. In the sheet, on a computer: **PitchTracker → Video timestamps**. A window opens with the video
and the game's plays **in at-bat order**: each plate appearance, then whatever happened during it (a steal during
Bob's at-bat comes after Bob's at-bat), because you stamp when an at-bat starts.

1. Pick the game and paste its YouTube link (kept in the **Videos** tab).
2. Play or skip to where the next at-bat starts and press **Enter**: the highlighted play gets the current time and the
   next one is highlighted.
3. PlayByPlay's `video` column shows each time as a link, and the dashboard plays the video from there.

Keys: **Space** play / pause, **← →** 5 s, **J L** 10 s, **, .** 1 s, **↑ ↓** pick a play, **Backspace** clear its time.
If a video won't play in the window, keep it open on YouTube, right-click → *Copy video URL at current time*, and paste
it into the box under the video.

Times live in their own **VideoTimes** tab, so regenerating PlayByPlay never loses them. If a corrected game file
moved the plays, a time whose play changed shows **⚠ check**: stamp it again. Don't clear PlayByPlay's `video` header
cell (opening the window puts it back).

## The team dashboard

- **Games** (oldest first in the menu): the score, the YouTube video, and every play in at-bat order. Tap a play's ▶ to
  jump the video there. **Follow the video** highlights the play on screen and keeps it in view. Below: the box score,
  and for games with a scoresheet, **win probability** (the chance of winning after every play), the biggest plays,
  who moved the game, team totals, and how the run model is worked out.
- **Hitters / Pitchers:** the whole team or one player. Every rate (quality at-bats, whiff, chase, freeze; strike,
  first-pitch, 1-1, putaway, quick-out, leadoff…) with a player's set beside the team's, game-by-game charts, a chart
  comparing the team on any rate, a sortable table of everyone, pitch types, swing rate by count, every number against
  each pitcher (Hitters) or batter (Pitchers), and every plate appearance with a ▶ to watch it. A player's numbers are
  green where they beat the team's and red where they trail it, by what is good for that player (a hitter's low whiff
  rate is green).
- **Leaders:** the good and bad leaderboards for a team's hitters and pitchers, or for all teams at once, with streaks
  across games.
- The browser's back gesture or button steps back through the tabs, games, teams and players you opened.
- **Games / Live BP / Both** at the top filters every tab. Wide tables keep the names pinned and shrink them to
  initials as you scroll sideways.

Games with a transcribed scoresheet show its plays (with the app's pitches matched to each plate appearance); other
games and live BP show the app's own plate appearances. The data is read fresh on every visit.

## Access at a glance

| Who | Holds | Can | To cut off |
|---|---|---|---|
| **You** | The Google account that owns the sheet | Everything | — |
| **Sheet editors** | Editor access to the sheet | Everything the owner can, including the script and its keys | Remove their access |
| **Recorders** | The setup link (upload token) | Add pitches, download rosters, make dashboard links | New token: delete `TOKEN` in Script properties, run `setup`, share a new setup link |
| **The team** | The dashboard link (viewer key) | Read what the dashboard shows | **Settings → Team dashboard → Replace the link…** |
| **Sheet viewers** | View access to the sheet | Read the sheet | Remove their access |
| **GitHub** | Write access to the repository, and the `apps-script` secrets | Change the app and dashboard; deploy the script | Remove collaborators; revoke clasp at myaccount.google.com/permissions |

Full detail, including what each request to the script needs: [guide section 13](docs/HOW-IT-WORKS.md#13-keys-tokens-and-sign-ins).

## Sheet columns

**Pitches** (one row per pitch):

| column | meaning |
|---|---|
| `id` | unique pitch id |
| `game_id` | entered at game setup; starts with the date (`2026-05-30 …`) |
| `recorded_at` | when the pitch was entered |
| `inning`, `half` | inning and `top` / `bottom` |
| `batting_team`, `pitching_team` | team names from setup |
| `outs_before` | outs when the pitch was thrown |
| `pa_number` | plate appearance number in the game (1, 2, 3…, both teams together) |
| `pitch_number` / `pitch_in_pa` | pitch number in the game / in the plate appearance |
| `lineup_slot`, `batter_number`, `batter` | the batter |
| `pitcher`, `pitcher_pitch_count` | the pitcher and their pitch count including this pitch |
| `balls_before`, `strikes_before` | count before the pitch |
| `pitch_type` | `FB` / `CB` |
| `zone` | `IN` / `OUT` |
| `action` | `TAKE` / `SWING` / `FOUL` / `IN_PLAY` |
| `result` | `ball`, `called_strike`, `swinging_strike`, `foul`, `in_play` |
| `pa_end` | `walk`, `strikeout`, `in_play` or empty |
| `pa_result` | on the last pitch of a plate appearance: its result code (`K`, `BB`, `2B`, `GO`…) |
| `deleted` | TRUE if undone in the app |
| `recorded_by` | the recorder's name from Settings, or `device-xxxxxx` |
| `session_type` | `game`, or `bp` for live BP |
| `synced_at` | when the sheet last received the row |

**PlateAppearances** (one row per finished plate appearance): the same situation columns, `id` to `pitcher`, plus:

| column | meaning |
|---|---|
| `pitches` | pitches in the plate appearance |
| `balls`, `strikes` | the count on the last pitch |
| `result` | `1B` `2B` `3B` `HR` · `GO` `LO` `FO` `DP` · `FC` · `SAC_BUNT` `SAC_FLY` · `E_GROUND` `E_LINE` `E_FLY` · `K` `BB` · `HBP` `IBB` `CI` `OUT_RULE` |
| `result_label` | the same in words (`Double`, `Fly out`…) |
| `category` | `hit`, `out`, `fc`, `sac`, `error`, `strikeout`, `walk`, `hbp`, `interference` |
| `batted_ball` | `ground`, `line`, `fly`, `bunt` where the choice says so |
| `fielder` | `P` `C` `1B` `2B` `3B` `SS` `LF` `CF` `RF`, or empty if skipped |
| `outs_on_play` | outs the app counted for the play |
| `deleted`, `recorded_by`, `session_type`, `synced_at` | as above |

The other tabs: **Rosters** (typed in), **Summary** (built by the script), **PlayByPlay** and **Scoresheets** (from the
scoresheet transcriptions, made outside the app), **VideoTimes** and **Videos** (the video timestamps), and copies named
*… (before update …)* kept when a layout change moved rows.

## Development

No build step and no dependencies: plain HTML, CSS and JavaScript modules.

```bash
npm test
```

```bash
python3 -m http.server 8765
```

```bash
node tests/e2e.cjs /tmp/shots
```

`npm test` runs the unit tests (Node 18+). The browser test drives the app in Playwright's Chromium against the
server on port 8765.

| file | role |
|---|---|
| `index.html`, `css/app.css`, `js/app.js` | the app's page, styles, screens and UI |
| `js/game.js` | count, outs, half-inning, outcome and lineup rules (pure; also used by the dashboard) |
| `js/db.js` | storage on the phone (IndexedDB) |
| `js/sync.js` | uploads, rosters and the dashboard's viewer key |
| `js/connect.js` | setup links, dashboard links and the sheet code (pure; also used by the dashboard) |
| `js/backup.js`, `js/roster.js` | backups and CSV; roster matching |
| `js/vendor/qrcodegen.js` | QR codes (vendored, pinned by checksum) |
| `sw.js` | offline cache for the app. **Bump `VERSION` whenever an app file changes** |
| `dashboard/` | the team dashboard: `dash.js` (page), `model.js` (plays and stats), `winprob.js` (run and win model), `leaders.js` (leaderboards) |
| `apps-script/Code.gs` | the script in the sheet: uploads, rosters, the dashboard's data, video timestamps. **Bump `VERSION` on every change** |

Rules for changing the code are in [`CLAUDE.md`](CLAUDE.md) and [guide section 16](docs/HOW-IT-WORKS.md#16-testing-changing-and-releasing).
