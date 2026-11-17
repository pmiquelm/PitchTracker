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
  let serverUp = true;
  await ctx.route('https://script.google.com/**', async route => {
    if (!serverUp) return route.abort('internetdisconnected');
    const req = route.request();
    if (req.method() === 'POST') { const b = JSON.parse(req.postData()); assert.equal(b.token, 'secret'); received.push(...b.rows); }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.goto('http://localhost:8765/');
  await page.locator('[data-act=settings]').click();
  await page.fill('input[name=url]', 'https://script.google.com/macros/s/test/exec');
  await page.fill('input[name=token]', 'secret');
  await page.getByRole('button', { name: 'Save' }).click();
  // In a browser tab, saving a connection puts the setup link in the address and reloads to home
  await page.waitForURL(/#connect=/); await page.waitForSelector('text=New game');
  const safariUrl = page.url();
  await page.getByText('New game').click();
  await page.fill('input[name=gameId]', '2026-11-16-HOME');
  await page.fill('input[name=pitcher]', 'Garcia');
  const names = ['Lopez','Smith','Jones','Kim','Diaz','Ruiz','Moore','Hill','Ortiz'];
  for (let i = 0; i < 9; i++) { await page.fill(`input[name=name${i}]`, names[i]); await page.fill(`input[name=num${i}]`, String(10+i)); }
  await page.screenshot({ path: OUT + '/1-setup.png' });
  await page.getByText('Start game').click();
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
  // Jones: in play
  await pitch('CB','OUT','IN_PLAY');
  await waitBatter(/Kim/);
  // Undo the in-play -> back to Jones
  await page.click('[data-act=undo]');
  await waitBatter(/Jones/);
  await pitch('FB','IN','IN_PLAY');
  await pitch('FB','OUT','TAKE');
  // Substitution: Kim -> Park, pitcher change
  await page.click('[data-act=lineup]');
  await page.fill('dialog input[name=name3]', 'Park'); await page.fill('dialog input[name=num3]', '33');
  await page.fill('dialog input[name=pitcher]', 'Reyes');
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
  // iPad landscape screenshot
  const ipad = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
  const p2 = await ipad.newPage(); await p2.goto('http://localhost:8765/');
  await p2.getByText('New game').click(); await p2.fill('input[name=name0]', 'Lopez'); await p2.getByText('Start game').click();
  await p2.click('[data-act=pad][data-value=FB]');
  await p2.screenshot({ path: OUT + '/6-ipad.png' });
  // ---- Setup link: open link in a fresh "phone" -> connected, rows carry token + recorded_by
  const shareLink = await (async () => {
    await page.click('[data-act=menu]'); await page.click('dialog [data-act=exit]').catch(() => {});
    await page.goto('http://localhost:8765/'); await page.locator('[data-act=settings]').click();
    await page.fill('input[name=recorder]', 'Coach P'); await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(300); if (await page.locator('[data-act=back]').count()) await page.click('[data-act=back]');
    await page.locator('[data-act=settings]').click();
    return page.inputValue('#setup-link');
  })();
  assert.match(shareLink, /^http:\/\/localhost:8765\/#connect=[\w-]+$/);
  const phone2 = await browser.newContext({ ...devices['iPhone 14'] });
  await phone2.route('https://script.google.com/**', async route => {
    const req = route.request();
    if (req.method() === 'POST') { const b = JSON.parse(req.postData()); assert.equal(b.token, 'secret'); received.push(...b.rows.map(r => ({ ...r, phone: 2 }))); }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  const p3 = await phone2.newPage();
  p3.on('pageerror', e => errors.push(e.message));
  await p3.goto(shareLink);
  await p3.waitForSelector('text=Connected to the sheet');
  assert.equal(await p3.locator('.connect-box').count(), 0, 'no paste box once connected');
  await p3.screenshot({ path: OUT + '/7-connected.png' });
  await p3.getByText('New game').click(); await p3.fill('input[name=name0]', 'Lopez'); await p3.getByText('Start game').click();
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
  await p4.fill('#connect-input', shareLink); await p4.click('[data-act=connect]');
  await p4.waitForSelector('text=Connected to the sheet');
  await p4.waitForFunction(() => !document.querySelector('.connect-box'));
  // Phone 1 rows carry the recorder name after it was set
  // ---- iOS Home Screen: installed app has its own empty storage and opens the address saved at install
  const installed = await browser.newContext({ ...devices['iPhone 14'] });
  await installed.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true }));
  const p5 = await installed.newPage();
  await p5.goto(safariUrl);
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
  const tab = await hand.newPage(); await tab.goto(shareLink); await tab.waitForSelector('[data-act=copy-link]');
  await tab.click('[data-act=copy-link]'); await tab.waitForSelector('text=Setup link copied');
  const copied = await tab.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /#connect=/);
  const inst = await browser.newContext({ ...devices['iPhone 14'], permissions: ['clipboard-read', 'clipboard-write'] });
  await inst.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true }));
  const app2 = await inst.newPage(); await app2.goto('http://localhost:8765/');
  await app2.evaluate((t) => navigator.clipboard.writeText(t), copied);
  await app2.screenshot({ path: OUT + '/10-paste-connect.png' });
  await app2.click('[data-act=paste-connect]');
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
  const ad = await droid.newPage(); await ad.goto(shareLink); await ad.waitForSelector('text=New game');
  assert.equal(await ad.locator('[data-act=copy-link]').count(), 0, 'no clipboard step on Android');
  await ad.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => {}; e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); });
  await ad.click('[data-act=install]'); await ad.waitForSelector('text=Installing');
  await ad.getByText('New game').click(); await ad.fill('input[name=name0]', 'A'); await ad.getByText('Start game').click();
  await ad.click('[data-act=lineup]'); await ad.goBack();
  await ad.waitForFunction(() => !document.querySelector('dialog[open]')); assert.equal(await ad.locator('.pads').count(), 3, 'Back closes the dialog only');
  await ad.goBack(); await ad.waitForSelector('text=New game');
  // Tracker badge is compact; tapping it opens the full status
  await ad.getByText('New game').click(); await ad.fill('input[name=name0]', 'A'); await ad.getByText('Start game').click();
  assert.ok((await ad.textContent('.sync-badge')).length <= 9, 'compact badge');
  await ad.click('.sync-badge'); await ad.waitForSelector('text=Upload status');
  console.log('received rows (incl. resends):', received.length, 'errors:', errors);
  assert.deepEqual(errors.filter(e => !e.includes('INTERNET_DISCONNECTED')), []);
  console.log('E2E OK');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
