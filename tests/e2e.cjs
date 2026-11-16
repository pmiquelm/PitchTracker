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
  await page.getByText('Settings').click();
  await page.fill('input[name=url]', 'https://script.google.com/macros/s/test/exec');
  await page.fill('input[name=token]', 'secret');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.click('[data-act=back]');
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
  await page.waitForFunction(() => document.querySelector('.sync-badge')?.textContent.includes('All synced'), null, { timeout: 5000 });
  const byId = new Map(received.map(r => [r.id, r]));
  const rows = [...byId.values()];
  assert.equal(rows.length, 12, 'unique rows');
  assert.equal(rows.filter(r => r.deleted).length, 1, 'one tombstone');
  const k = rows.find(r => r.pa_end === 'strikeout'); assert.equal(k.batter, 'Lopez'); assert.equal(k.strikes_before, 2);
  // Offline: record pitches, badge shows pending
  serverUp = false; await ctx.setOffline(true);
  await pitch('CB','IN','SWING');
  await page.waitForTimeout(800);
  const badge = await page.textContent('.sync-badge');
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
  await page.waitForFunction(() => document.querySelector('.sync-badge')?.textContent.includes('All synced'), null, { timeout: 8000 });
  // iPad landscape screenshot
  const ipad = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
  const p2 = await ipad.newPage(); await p2.goto('http://localhost:8765/');
  await p2.getByText('New game').click(); await p2.fill('input[name=name0]', 'Lopez'); await p2.getByText('Start game').click();
  await p2.click('[data-act=pad][data-value=FB]');
  await p2.screenshot({ path: OUT + '/6-ipad.png' });
  console.log('received rows (incl. resends):', received.length, 'errors:', errors);
  assert.deepEqual(errors.filter(e => !e.includes('INTERNET_DISCONNECTED')), []);
  console.log('E2E OK');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
