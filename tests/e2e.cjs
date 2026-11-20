// End-to-end browser test (Playwright, phone emulation, mocked Google endpoint).
// Run: python3 -m http.server 8765 & node tests/e2e.cjs /tmp/shots
const { chromium, devices } = require('playwright');
const assert = require('assert');
const OUT = process.argv[2];
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 14'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const received = [];
  const receivedPas = [];
  // Every new connection asks first and shows the sheet code
  const accept = async (pg) => { await pg.waitForSelector('text=Connect to this sheet?'); await pg.click('dialog [data-act=yes]'); };
  let serverUp = true;
  await ctx.route('https://script.google.com/**', async route => {
    if (!serverUp) return route.abort('internetdisconnected');
    const req = route.request();
    // A script from before rosters answers the roster request like an empty upload
    if (req.method() === 'POST' && JSON.parse(req.postData()).action === 'rosters') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'No rows' }) });
    if (req.method() === 'POST') { const b = JSON.parse(req.postData()); assert.equal(b.token, 'secret-token-1'); received.push(...b.rows); receivedPas.push(...b.pas); }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, version: 6 }) });
  });
  await page.goto('http://localhost:8765/');
  await page.locator('[data-act=settings]').click();
  await page.fill('input[name=url]', 'https://script.google.com/macros/s/AKfycbTestDeployment0123456789_abcdefghij/exec');
  await page.fill('input[name=token]', 'secret-token-1');
  await page.getByRole('button', { name: 'Save' }).click();
  // In a browser tab, saving a connection puts the setup link in the address and reloads to home
  await page.waitForURL(/#c=/); await page.waitForSelector('text=New game');
  const safariUrl = page.url();
  await page.getByText('New game').click();
  // An old sheet script can't send rosters: say so instead of looking like an empty Rosters tab
  await page.waitForSelector('.roster-error'); assert.match(await page.textContent('#roster-status'), /out of date/);
  await page.fill('input[name=gameId]', '2026-11-16-HOME');
  await page.fill('input[name=t1_pitcher]', 'Garcia'); // the home pitcher faces the away lineup
  await page.fill('input[name=t0_team]', 'Tigers');
  const names = ['Lopez','Smith','Jones','Kim','Diaz','Ruiz','Moore','Hill','Ortiz'];
  for (let i = 0; i < 9; i++) { await page.fill(`input[name=t0_name${i}]`, names[i]); await page.fill(`input[name=t0_num${i}]`, String(10+i)); }
  await page.screenshot({ path: OUT + '/1-setup.png' });
  await page.getByText('Start game').click();
  const waitFor = (pg, re) => pg.waitForFunction(src => new RegExp(src).test(document.querySelector('.batter-bar')?.textContent || ''), re.source, { timeout: 3000 });
  const pitch = async (t, z, a) => { for (const v of [t, z, a]) await page.click(`[data-act=pad][data-value=${v}]`); };
  const count = () => page.textContent('.count-num');
  const waitCount = (v) => page.waitForFunction(v => document.querySelector('.count-num')?.textContent === v, v, { timeout: 3000 }).catch(async () => { throw new Error('count ' + (await count()) + ' != ' + v); });
  const waitBatter = (re) => page.waitForFunction(src => new RegExp(src).test(document.querySelector('.batter-bar')?.textContent || ''), re.source, { timeout: 3000 }).catch(async () => { throw new Error('batter ' + (await page.textContent('.batter-bar')) + ' !~ ' + re); });
  // Lopez: K looking after a ball and a foul
  await pitch('FB','OUT','TAKE'); await waitCount('1-0');
  await pitch('CB','IN','FOUL'); await waitCount('1-1');
  await page.click('[data-act=pad][data-value=FB]'); await page.click('[data-act=pad][data-value=IN]');
  await page.screenshot({ path: OUT + '/2-selecting.png' });
  await page.click('[data-act=pad][data-value=SWING]'); await waitCount('1-2');
  await pitch('FB','IN','FOUL'); await waitCount('1-2');
  await pitch('CB','IN','TAKE'); await waitCount('0-0');
  await waitBatter(/Smith/);
  // Smith walks
  for (let i = 0; i < 4; i++) await pitch('FB','OUT','TAKE');
  await waitBatter(/Jones/);
  // Jones: in play -> the decision tree replaces the pads until the outcome is chosen
  await pitch('CB','OUT','IN_PLAY');
  await page.waitForSelector('.group-outcome');
  assert.equal(await page.locator('[data-act=next]').isDisabled(), true, 'no next batter while an outcome is owed');
  await page.click('[data-act=tree-cat][data-value=hit]');
  await page.screenshot({ path: OUT + '/2b-tree-hit.png' });
  await page.click('[data-act=tree-back]');
  await page.click('[data-act=tree-cat][data-value=hit]');
  await page.click('[data-act=tree-result][data-value="1B"]');
  await page.screenshot({ path: OUT + '/2c-tree-fielder.png' });
  await page.click('[data-act=tree-fielder][data-value=CF]');
  await page.waitForSelector('.group-pitchType'); await waitBatter(/Kim/);
  assert.match(await page.textContent('.last'), /Jones: Single \(CF\)/);
  // Undo the outcome -> tree again for Jones; undo again -> the in-play pitch is gone
  await page.click('[data-act=undo]');
  await waitBatter(/Jones/); await page.waitForSelector('.group-outcome');
  await page.click('[data-act=undo]');
  await page.waitForSelector('.group-pitchType');
  await pitch('FB','IN','IN_PLAY');
  await page.click('[data-act=tree-cat][data-value=out]');
  await page.click('[data-act=tree-result][data-value=FO]');
  await page.click('[data-act=tree-fielder][data-value=""]'); // Skip
  await page.waitForSelector('.group-pitchType'); await waitBatter(/Kim/);
  await page.waitForFunction(() => document.querySelector('.stepper.outs span')?.textContent === 'OUTS2');
  await pitch('FB','OUT','TAKE');
  // Substitution: Kim -> Park, pitcher change
  await page.click('[data-act=lineup]');
  await page.fill('dialog input[name=t0_name3]', 'Park'); await page.fill('dialog input[name=t0_num3]', '33');
  await page.fill('dialog input[name=t1_pitcher]', 'Reyes');
  await page.screenshot({ path: OUT + '/4-subs.png' });
  await page.click('dialog [data-act=save]');
  await waitBatter(/Park/);
  await waitBatter(/Reyes \(0\)/);
  await waitCount('1-0'); // sub mid-PA keeps the count
  await page.waitForTimeout(800);
  await page.screenshot({ path: OUT + '/3-tracker.png' });
  // Sync check
  await page.waitForFunction(() => document.querySelector('.sync-badge')?.getAttribute('aria-label').includes('All synced'), null, { timeout: 5000 });
  const byId = new Map(received.map(r => [r.id, r]));
  const rows = [...byId.values()];
  assert.equal(rows.length, 12, 'unique rows');
  assert.equal(rows.filter(r => r.deleted).length, 1, 'one tombstone');
  const k = rows.find(r => r.pa_end === 'strikeout'); assert.equal(k.batter, 'Lopez'); assert.equal(k.strikes_before, 2);
  assert.deepEqual([k.pa_result, k.batting_team, k.half, k.pitcher], ['K', 'Tigers', 'top', 'Garcia']);
  const bips = rows.filter(r => r.action === 'IN_PLAY').sort((a, b) => a.pitch_number - b.pitch_number || (b.deleted - a.deleted));
  assert.deepEqual(bips.map(r => [r.deleted, r.pa_result]), [[true, ''], [false, 'FO']]);
  // Plate appearances: K, BB, the undone single (deleted) and the fly out
  const pas = [...new Map(receivedPas.map(r => [r.id, r])).values()].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  assert.deepEqual(pas.map(r => [r.batter, r.result, r.deleted, r.fielder]),
    [['Lopez', 'K', false, ''], ['Smith', 'BB', false, ''], ['Jones', '1B', true, 'CF'], ['Jones', 'FO', false, '']]);
  assert.equal(pas[3].batted_ball, 'fly'); assert.equal(pas[3].outs_before, 1); assert.equal(pas[0].pitches, 5);
  // Offline: record pitches, badge shows pending
  serverUp = false; await ctx.setOffline(true);
  await pitch('CB','IN','SWING');
  await page.waitForTimeout(800);
  const badge = await page.getAttribute('.sync-badge', 'aria-label');
  assert.match(badge, /1 not uploaded/, badge);
  // Reload while offline -> app loads from SW cache, data intact
  await page.reload();
  await page.getByText('2026-11-16-HOME').click();
  await waitCount('1-1');
  await waitBatter(/Park/);
  await page.click('[data-act=log]');
  await page.screenshot({ path: OUT + '/5-log.png' });
  await page.click('dialog [data-act=close]');
  // Back online -> pending pitch uploads
  serverUp = true; await ctx.setOffline(false);
  await page.waitForFunction(() => document.querySelector('.sync-badge')?.getAttribute('aria-label').includes('All synced'), null, { timeout: 8000 });
  // Next batter asks why; out by rule is the third out -> the home team bats in the bottom of the 1st
  await page.click('[data-act=next]');
  await page.waitForSelector('text=Next batter: why?');
  await page.screenshot({ path: OUT + '/5b-next-batter.png' });
  await page.click('dialog [data-reason=OUT_RULE]');
  await waitBatter(/▼1 Home/); await waitCount('0-0');
  await page.waitForFunction(() => document.querySelector('.stepper.outs span')?.textContent === 'OUTS0');
  await pitch('CB','OUT','TAKE');
  await page.waitForFunction(() => document.querySelector('.sync-badge')?.getAttribute('aria-label').includes('All synced'), null, { timeout: 8000 });
  const homeRow = received.at(-1);
  assert.deepEqual([homeRow.half, homeRow.batting_team, homeRow.pitching_team, homeRow.batter, homeRow.inning], ['bottom', 'Home', 'Tigers', 'Batter 1', 1]);
  assert.equal(receivedPas.at(-1).result, 'OUT_RULE');
  // Manual out and half-inning controls
  await page.click('[data-act=outs][data-delta="1"]');
  await page.waitForFunction(() => document.querySelector('.stepper.outs span')?.textContent === 'OUTS1');
  await page.click('[data-act=half][data-delta="1"]');
  await waitBatter(/▲2 Tigers · Batting 5/); await waitBatter(/Diaz/);
  await page.screenshot({ path: OUT + '/3b-top-2nd.png' });
  // iPad landscape screenshot
  const ipad = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
  const p2 = await ipad.newPage(); await p2.goto('http://localhost:8765/');
  await p2.getByText('New game').click(); await p2.screenshot({ path: OUT + '/6a-ipad-setup.png' });
  await p2.fill('input[name=t0_name0]', 'Lopez'); await p2.getByText('Start game').click();
  await p2.click('[data-act=pad][data-value=FB]');
  await p2.screenshot({ path: OUT + '/6-ipad.png' });
  for (const v of ['IN', 'IN_PLAY']) await p2.click(`[data-act=pad][data-value=${v}]`);
  await p2.screenshot({ path: OUT + '/6b-ipad-tree.png' });
  // ---- Setup link: open link in a fresh "phone" -> connected, rows carry token + recorded_by
  const shareLink = await (async () => {
    await page.click('[data-act=menu]'); await page.click('dialog [data-act=exit]').catch(() => {});
    await page.goto('http://localhost:8765/'); await page.locator('[data-act=settings]').click();
    await page.fill('input[name=recorder]', 'Coach P'); await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(300); if (await page.locator('[data-act=back]').count()) await page.click('[data-act=back]');
    await page.locator('[data-act=settings]').click();
    // Settings: token hidden, link masked, sheet code shown, QR on request only
    assert.equal(await page.getAttribute('input[name=token]', 'class'), 'secret');
    assert.doesNotMatch(await page.textContent('main'), /secret-token-1/, 'token not shown as text');
    await page.waitForFunction(() => /^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(document.getElementById('my-sheet-code')?.textContent));
    const myCode = await page.textContent('#my-sheet-code');
    assert.equal(await page.locator('svg.qr').count(), 0, 'no QR until asked');
    await page.click('[data-act=show-qr]'); await page.waitForSelector('svg.qr');
    assert.match(await page.textContent('dialog'), new RegExp(myCode));
    await page.screenshot({ path: OUT + '/12-qr.png' });
    await page.click('dialog [data-act=close]');
    assert.equal(await page.locator('svg.qr').count(), 0, 'QR removed on close');
    await page.click('[data-act=show-qr]'); await page.waitForSelector('svg.qr');
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(await page.locator('svg.qr').count(), 0, 'QR removed when the app leaves the screen');
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); });
    page.__sheetCode = myCode;
    await page.click('[data-act=back]');
    return page.url();
  })();
  assert.match(shareLink, /^http:\/\/localhost:8765\/#c=[\w-]+\.[\w-]+$/);
  assert.ok(shareLink.length < 120, 'short link');
  const phone2 = await browser.newContext({ ...devices['iPhone 14'] });
  await phone2.route('https://script.google.com/**', async route => {
    const req = route.request();
    // A script from before rosters answers the roster request like an empty upload
    if (req.method() === 'POST' && JSON.parse(req.postData()).action === 'rosters') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'No rows' }) });
    if (req.method() === 'POST') { const b = JSON.parse(req.postData()); assert.equal(b.token, 'secret-token-1'); received.push(...b.rows.map(r => ({ ...r, phone: 2 }))); }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, version: 6 }) });
  });
  const p3 = await phone2.newPage();
  p3.on('pageerror', e => errors.push(e.message));
  await p3.goto(shareLink);
  await p3.waitForSelector('text=Connect to this sheet?');
  assert.match(await p3.textContent('dialog .sheet-code'), new RegExp(page.__sheetCode), 'same sheet code on both phones');
  await p3.screenshot({ path: OUT + '/13-confirm.png' });
  await p3.click('dialog [data-act=yes]');
  await p3.waitForSelector('text=Connected to the sheet');
  assert.equal(await p3.locator('.connect-box').count(), 0, 'no paste box once connected');
  await p3.screenshot({ path: OUT + '/7-connected.png' });
  await p3.getByText('New game').click(); await p3.fill('input[name=t0_name0]', 'Lopez'); await p3.getByText('Start game').click();
  for (const v of ['FB', 'IN', 'TAKE']) await p3.click(`[data-act=pad][data-value=${v}]`);
  for (let i = 0; i < 50 && !received.some(r => r.phone === 2); i++) await p3.waitForTimeout(100);
  const r2 = received.filter(r => r.phone === 2);
  assert.equal(r2.length, 1); assert.match(r2[0].recorded_by, /^device-/);
  // Reload with the same link: no second "Connected" prompt
  await p3.waitForTimeout(3000); await p3.goto('about:blank'); await p3.goto(shareLink); await p3.waitForSelector('.list'); await p3.waitForTimeout(500);
  const t3 = await p3.locator('#toast.show').count() ? await p3.textContent('#toast') : '';
  assert.equal(t3, '', 'link not re-applied');
  // Paste flow on a third phone (installed app opened without the link)
  const phone3 = await browser.newContext({ ...devices['iPhone 14'] });
  const p4 = await phone3.newPage();
  await p4.goto('http://localhost:8765/');
  await p4.screenshot({ path: OUT + '/8-paste-box.png' });
  await p4.fill('#connect-input', 'not a link'); await p4.click('[data-act=connect]');
  await p4.waitForSelector('#toast.error');
  await p4.fill('#connect-input', shareLink); await p4.click('[data-act=connect]'); await accept(p4);
  await p4.waitForSelector('text=Connected to the sheet');
  await p4.waitForFunction(() => !document.querySelector('.connect-box'));
  // Phone 1 rows carry the recorder name after it was set
  // ---- iOS Home Screen: installed app has its own empty storage and opens the address saved at install
  const installed = await browser.newContext({ ...devices['iPhone 14'] });
  await installed.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true }));
  const p5 = await installed.newPage();
  await p5.goto(safariUrl); await accept(p5);
  await p5.waitForSelector('text=Connected to the sheet');
  assert.equal(await p5.locator('.connect-box').count(), 0);
  assert.equal(await p5.locator('text=Install the app').count(), 0, 'no install notice inside the installed app');
  const settingsUrl = await p5.evaluate(() => location.href);
  assert.equal(settingsUrl, safariUrl, 'installed app does not rewrite its address');
  // Installed app opened from a plain address (old install) -> paste box shown, no reload loop
  const oldInstall = await browser.newContext({ ...devices['iPhone 14'] });
  await oldInstall.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true }));
  const p6 = await oldInstall.newPage(); await p6.goto('http://localhost:8765/');
  await p6.waitForSelector('.connect-box'); assert.equal(p6.url(), 'http://localhost:8765/');
  // Clipboard hand-over: copy in the "Safari" tab, then Paste & connect in the installed app
  const hand = await browser.newContext({ ...devices['iPhone 14'], permissions: ['clipboard-read', 'clipboard-write'] });
  const tab = await hand.newPage(); await tab.goto(shareLink); await accept(tab); await tab.waitForSelector('[data-act=copy-link]');
  await tab.click('[data-act=copy-link]'); await tab.waitForSelector('text=Setup link copied');
  await tab.bringToFront();
  const copied = await tab.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /#c=/);
  const inst = await browser.newContext({ ...devices['iPhone 14'], permissions: ['clipboard-read', 'clipboard-write'] });
  await inst.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true }));
  const app2 = await inst.newPage(); await app2.goto('http://localhost:8765/');
  await app2.evaluate((t) => navigator.clipboard.writeText(t), copied);
  await app2.screenshot({ path: OUT + '/10-paste-connect.png' });
  await app2.click('[data-act=paste-connect]'); await accept(app2);
  await app2.waitForFunction(() => !document.querySelector('.connect-box'));
  await app2.locator('[data-act=settings]').click();
  assert.match(await app2.textContent('.facts'), /App version: v\d+/);
  assert.match(await app2.textContent('.facts'), /Opened at: http:\/\/localhost:8765\/$/m);
  // Errors from outside the app ("Script error." with no file) are not shown; the app's own are
  await app2.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' })));
  await app2.waitForTimeout(200);
  assert.equal(await app2.locator('#toast.error').count(), 0, 'external error hidden');
  await app2.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'boom', filename: location.origin + '/js/app.js' })));
  await app2.waitForSelector('#toast.error');
  const m = await (await p6.request.get('http://localhost:8765/manifest.webmanifest')).json();
  assert.equal(m.start_url, undefined, 'manifest must not pin start_url');
  // ---- Android: Chrome's install offer becomes an "Install app" button; Back in a game returns home
  const droid = await browser.newContext({ ...devices['Pixel 7'] });
  const ad = await droid.newPage(); await ad.goto(shareLink); await accept(ad); await ad.waitForSelector('text=New game');
  assert.equal(await ad.locator('[data-act=copy-link]').count(), 0, 'no clipboard step on Android');
  await ad.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => {}; e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); });
  await ad.click('[data-act=install]'); await ad.waitForSelector('text=Installing');
  await ad.getByText('New game').click(); await ad.fill('input[name=t0_name0]', 'A'); await ad.getByText('Start game').click();
  await ad.click('[data-act=lineup]'); await ad.goBack();
  await ad.waitForFunction(() => !document.querySelector('dialog[open]')); assert.equal(await ad.locator('.pads').count(), 3, 'Back closes the dialog only');
  await ad.goBack(); await ad.waitForSelector('text=New game');
  // Tracker badge is compact; tapping it opens the full status
  await ad.getByText('New game').click(); await ad.fill('input[name=t0_name0]', 'A'); await ad.getByText('Start game').click();
  assert.ok((await ad.textContent('.sync-badge')).length <= 9, 'compact badge');
  await ad.click('.sync-badge'); await ad.waitForSelector('text=Upload status');
  // ---- Rosters: downloaded from the sheet, starting 9 picked by tapping, subs from the bench
  const coach = await browser.newContext({ ...devices['iPhone 14'] });
  const rosterPlayers = Array.from({ length: 14 }, (_, i) => ({ number: String(i + 1), name: `Player ${String.fromCharCode(65 + i)}` }));
  let rosterCalls = 0; const coachRows = [];
  await coach.route('https://script.google.com/**', async route => {
    const b = route.request().method() === 'POST' ? JSON.parse(route.request().postData()) : {};
    if (b.action === 'rosters') { rosterCalls++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, version: 4, rosters: [{ name: 'Eagles', players: rosterPlayers }, { name: 'Hawks', players: [{ number: '9', name: 'Zed' }] }] }) }); }
    if (b.rows) coachRows.push(...b.rows);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, version: 6 }) });
  });
  const c = await coach.newPage();
  c.on('pageerror', e => errors.push(e.message));
  await c.goto(shareLink); await accept(c); await c.waitForSelector('text=New game');
  await c.getByText('New game').click();
  await c.waitForSelector('select[name=t1_roster]');
  assert.match(await c.textContent('#roster-status'), /2 rosters from the sheet/);
  await c.selectOption('select[name=t1_roster]', '0');
  await c.waitForSelector('dialog .picker');
  assert.equal(await c.locator('dialog .bench button').count(), 14);
  for (const n of 'ABCDEFGHJ') await c.click(`dialog .bench button:has-text("Player ${n}")`);
  await c.click('dialog .bench button:has-text("Player K")'); await c.waitForSelector('text=batting order is full');
  await c.click('dialog [data-act=up][data-slot="1"]'); // B leads off, A bats 2nd
  await c.click('dialog [data-act=remove][data-slot="8"]'); await c.click('dialog .bench button:has-text("Player K")');
  await c.selectOption('dialog select[name=picker-pitcher]', 'Player N');
  assert.match(await c.textContent('dialog'), /9\/9 picked/);
  await c.screenshot({ path: OUT + '/14-roster-picker.png' });
  await c.click('dialog [data-act=use]');
  assert.equal(await c.inputValue('input[name=t1_team]'), 'Eagles', 'team named after its roster');
  assert.deepEqual(await Promise.all([0, 1, 8].map(i => c.inputValue(`input[name=t1_name${i}]`))), ['Player B', 'Player A', 'Player K']);
  assert.equal(await c.inputValue('input[name=t1_num8]'), '11');
  assert.equal(await c.inputValue('input[name=t1_pitcher]'), 'Player N');
  // Typing by hand: a roster name gets its spelling and number; a number fills an empty name
  await c.fill('input[name=t1_name7]', 'player l'); await c.press('input[name=t1_name7]', 'Tab');
  assert.deepEqual([await c.inputValue('input[name=t1_name7]'), await c.inputValue('input[name=t1_num7]')], ['Player L', '12']);
  await c.fill('input[name=t1_name6]', ''); await c.fill('input[name=t1_num6]', '13'); await c.press('input[name=t1_num6]', 'Tab');
  assert.equal(await c.inputValue('input[name=t1_name6]'), 'Player M');
  await c.screenshot({ path: OUT + '/15-roster-setup.png', fullPage: true });
  await c.fill('input[name=gameId]', 'ROSTER-1'); await c.getByText('Start game').click();
  await waitFor(c, /Player N \(0\)/); // the home roster's pitcher faces the away batters
  // Bottom of the 1st: the Eagles bat. Sub from the bench by name: the number comes along
  await c.click('[data-act=half][data-delta="1"]'); await waitFor(c, /Player B/);
  await c.click('[data-act=lineup]');
  await c.fill('dialog input[name=t1_name0]', 'Player C'); await c.press('dialog input[name=t1_name0]', 'Tab');
  assert.equal(await c.inputValue('dialog input[name=t1_num0]'), '3');
  // Or tap ⇄ on a spot, then a bench player
  assert.equal(await c.locator('#sub-bench-1 button:has-text("Player D")').count(), 0, 'batting players are not on the bench');
  await c.click('#sub-bench-1 button:has-text("Player G")'); await c.waitForSelector('text=Tap ⇄ next to the spot');
  await c.click('dialog [data-act=sub-target][data-team="1"][data-slot="3"]');
  await c.waitForSelector('[data-row="1-3"].targeted'); assert.match(await c.textContent('#sub-bench-1'), /Sub in at 4/);
  await c.screenshot({ path: OUT + '/16-roster-subs.png' });
  await c.click('#sub-bench-1 button:has-text("Player G")');
  assert.deepEqual([await c.inputValue('dialog input[name=t1_name3]'), await c.inputValue('dialog input[name=t1_num3]')], ['Player G', '7']);
  assert.equal(await c.locator('#sub-bench-1 button:has-text("Player G")').count(), 0, 'off the bench once in');
  await c.click('dialog [data-act=sub-target][data-team="1"][data-slot="p"]');
  await c.click('#sub-bench-1 button:has-text("Player H")');
  assert.equal(await c.inputValue('dialog input[name=t1_pitcher]'), 'Player H');
  await c.click('dialog [data-act=save]'); await waitFor(c, /#3 Player C/);
  // The players taken out are marked on the bench
  await c.click('[data-act=lineup]'); await c.click('dialog [data-act=sub-target][data-team="1"][data-slot="3"]');
  assert.match(await c.textContent('#sub-bench-1 button.played:has-text("Player D")'), /out/);
  await c.click('dialog [data-act=sub-target][data-team="1"][data-slot="p"]');
  assert.match(await c.textContent('#sub-bench-1 button.played:has-text("Player N")'), /pitched/);
  await c.click('dialog [data-act=close]');
  // Offline: the saved copy of the rosters is still there
  await coach.setOffline(true);
  await c.click('[data-act=menu]'); await c.click('dialog [data-act=exit]');
  c.once('dialog', d => d.accept());
  await c.getByText('New game').click(); await c.waitForSelector('select[name=t0_roster]');
  await coach.setOffline(false);
  assert.ok(rosterCalls >= 1);
  // ---- Live BP: one team, batters picked after every at-bat, no innings or outs
  await c.click('[data-act=back]'); await c.click('[data-act=new-bp]');
  await c.waitForSelector('select[name=t0_roster]');
  await c.selectOption('select[name=t0_roster]', '0');
  assert.equal(await c.inputValue('input[name=t0_team]'), 'Eagles');
  // The pitcher is picked from the roster with a tap (tap again clears); typing still works
  assert.equal(await c.locator('#pitcher-pick button').count(), 14);
  await c.click('#pitcher-pick button:has-text("Player M")'); await c.click('#pitcher-pick button:has-text("Player M")');
  assert.equal(await c.inputValue('input[name=t0_pitcher]'), '');
  await c.click('#pitcher-pick button:has-text("Player N")');
  assert.equal(await c.inputValue('input[name=t0_pitcher]'), 'Player N');
  assert.equal(await c.locator('#pitcher-pick button.selected').textContent(), '#14 Player N');
  await c.fill('input[name=t0_pitcher]', 'player n'); await c.press('input[name=t0_pitcher]', 'Tab');
  assert.equal(await c.inputValue('input[name=t0_pitcher]'), 'Player N');
  await c.waitForSelector('#pitcher-pick button.selected:has-text("Player N")');
  await c.screenshot({ path: OUT + '/17-bp-setup.png' });
  await c.click('#bp-setup [type=submit]');
  await c.waitForSelector('.group-whoup');
  assert.equal(await c.locator('.whoup button').count(), 13, 'the pitcher is not offered as a batter');
  assert.equal(await c.locator('[data-act=pad]').count(), 0, 'no pitches until a batter is picked');
  assert.equal(await c.locator('.stepper').count(), 0, 'no innings or outs');
  await c.screenshot({ path: OUT + '/18-bp-whoup.png' });
  const cp = async (t, z, a) => { for (const v of [t, z, a]) await c.click(`[data-act=pad][data-value=${v}]`); };
  await c.click('.whoup button:has-text("Player C")'); await waitFor(c, /#3 Player C/);
  await cp('FB', 'IN', 'TAKE'); await cp('CB', 'IN', 'SWING'); await cp('FB', 'IN', 'TAKE');
  await c.waitForSelector('[data-act=bp-same]');
  assert.match(await c.textContent('[data-act=bp-same]'), /Player C/);
  assert.match(await c.textContent('.whoup button:has-text("Player C")'), /1 PA/);
  // Someone not on the roster, typed by name; a roster number picks that player
  await c.fill('#bp-name', '1'); await c.click('[data-act=bp-other]'); await waitFor(c, /#1 Player A/);
  await cp('FB', 'IN', 'IN_PLAY'); await c.waitForSelector('.group-outcome');
  await c.click('[data-act=tree-cat][data-value=out]'); await c.click('[data-act=tree-result][data-value=DP]'); await c.click('[data-act=tree-fielder][data-value=SS]');
  await c.waitForSelector('.group-whoup');
  await c.fill('#bp-name', 'Guest Kid'); await c.press('#bp-name', 'Enter'); await waitFor(c, /Guest Kid/);
  await cp('FB', 'OUT', 'TAKE');
  // Changing the batter mid at-bat, then undoing it, comes back to the same count
  await c.click('[data-act=bp-batter]'); await c.waitForSelector('text=Change batter');
  await c.click('.whoup button:has-text("Player B")'); await waitFor(c, /Player B/);
  assert.equal(await c.textContent('.count-num'), '0-0');
  await c.click('[data-act=undo]'); await waitFor(c, /Guest Kid/);
  assert.equal(await c.textContent('.count-num'), '1-0');
  await c.click('[data-act=next]'); await c.waitForSelector('dialog [data-reason=HBP]');
  assert.equal(await c.locator('dialog [data-reason=OUT_RULE]').count(), 0, 'game-only reasons are hidden');
  await c.click('dialog [data-reason=HBP]'); await c.waitForSelector('.group-whoup');
  await c.click('[data-act=bp-pitcher]'); await c.click('dialog .bench button:has-text("Player H")');
  await waitFor(c, /P: Player H \(0\)/);
  await c.click('[data-act=bp-same]'); await waitFor(c, /Guest Kid/);
  await c.screenshot({ path: OUT + '/19-bp-tracker.png' });
  for (let i = 0; i < 50 && !coachRows.some(r => r.batter === 'Guest Kid'); i++) await c.waitForTimeout(100);
  const bpRows = coachRows.filter(r => r.session_type === 'bp');
  assert.ok(bpRows.length >= 5, 'BP pitches uploaded');
  for (const r of bpRows) assert.deepEqual([r.batting_team, r.pitching_team, r.inning, r.outs_before, r.lineup_slot], ['Eagles', 'Eagles', '', '', '']);
  assert.ok(coachRows.filter(r => r.game_id === 'ROSTER-1').every(r => r.session_type === 'game'));
  await c.click('[data-act=log]'); assert.match(await c.textContent('dialog'), /P: Player N/); await c.click('dialog [data-act=close]');
  await c.click('[data-act=menu]'); await c.click('dialog [data-act=exit]');
  await c.waitForSelector('.tag:has-text("Live BP")');
  await coach.close();
  // ---- Declining a link: not connected, and not asked again at every launch
  const wary = await browser.newContext({ ...devices['iPhone 14'] });
  const w = await wary.newPage(); await w.goto(shareLink);
  await w.waitForSelector('text=Connect to this sheet?'); await w.click('dialog [data-act=close]');
  await w.waitForSelector('.connect-box');
  await w.goto('about:blank'); await w.goto(shareLink); await w.waitForSelector('.connect-box'); await w.waitForTimeout(500);
  assert.equal(await w.locator('dialog[open]').count(), 0, 'declined link not asked again');
  // ---- Content Security Policy is in force: the page cannot load outside scripts
  const blocked = await w.evaluate(() => new Promise((resolve) => {
    const s = document.createElement('script'); s.src = 'https://example.com/x.js';
    s.onerror = () => resolve(true); s.onload = () => resolve(false); document.head.append(s);
  }));
  assert.ok(blocked, 'outside script blocked by CSP');
  console.log('received rows (incl. resends):', received.length, 'errors:', errors);
  assert.deepEqual(errors.filter(e => !e.includes('INTERNET_DISCONNECTED')), []);
  console.log('E2E OK');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
