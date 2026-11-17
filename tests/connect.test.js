import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSetupLink, decodeConnect, encodeConnect, isValidScriptUrl, sheetCode, isSetupLinkHash } from '../js/connect.js';

const ID = 'AKfycbx3Q9d_kL2mN8pR4sT6uV0wXyZ1aB5cD7eF9gH-iJkLmNoPqRsTuVwXyZ0123456789ab';
const settings = { url: `https://script.google.com/macros/s/${ID}/exec`, token: '3f1c9a2e-7b4d-4c1e-9f0a-2b6d8e1c5a47' };
const APP = 'https://pmiquelm.github.io/PitchTracker/';

test('short link: format, length and round trip', () => {
  const link = buildSetupLink(`${APP}#old`, settings);
  assert.equal(link, `${APP}#c=${ID}.${settings.token}`);
  assert.ok(link.length < 160, `short enough (${link.length})`);
  for (const input of [link, `#c=${ID}.${settings.token}`, `${ID}.${settings.token}`, `  ${link}  `]) {
    const d = decodeConnect(input);
    assert.equal(d.url, settings.url);
    assert.equal(d.token, settings.token);
  }
});

test('old long links still work', () => {
  const json = JSON.stringify({ v: 1, u: settings.url, t: settings.token });
  const code = Buffer.from(json).toString('base64url');
  const d = decodeConnect(`${APP}#connect=${code}`);
  assert.equal(d.url, settings.url);
  assert.equal(d.token, settings.token);
  assert.equal(decodeConnect(code).url, settings.url, 'bare long code');
});

test('Workspace addresses fall back to the long form', () => {
  const ws = { url: `https://script.google.com/a/macros/club.example/s/${ID}/exec`, token: 'abcdefgh1234' };
  const enc = encodeConnect(ws);
  assert.match(enc, /^connect=/);
  assert.equal(decodeConnect(buildSetupLink(APP, ws)).url, ws.url);
});

test('rejects anything that could send pitches elsewhere', () => {
  const bad = [
    'https://evil.example/macros/s/AKfycbxxxxxxxxxx/exec',
    'http://script.google.com/macros/s/AKfycbxxxxxxxxxx/exec',
    'https://script.google.com.evil.example/macros/s/AKfycbxxxxxxxxxx/exec',
    'https://script.google.com:8443/macros/s/AKfycbxxxxxxxxxx/exec',
    'https://user@script.google.com/macros/s/AKfycbxxxxxxxxxx/exec',
    'https://script.google.com/macros/s/AKfycbxxxxxxxxxx/exec?next=https://evil.example',
    'https://script.google.com/macros/s/AKfycbxxxxxxxxxx/exec#x',
    'https://script.google.com/macros/s/../../evil/exec',
    'https://script.google.com/a/macros/evil.example/s/AKfycb/exec/../../x',
  ];
  for (const url of bad) {
    assert.equal(isValidScriptUrl(url), false, url);
    const json = Buffer.from(JSON.stringify({ v: 1, u: url, t: 'abcdefgh' })).toString('base64url');
    assert.equal(decodeConnect(`#connect=${json}`), null, url);
  }
  assert.equal(decodeConnect(''), null);
  assert.equal(decodeConnect('hello'), null);
  assert.equal(decodeConnect('#c=short.tok'), null, 'too short');
  assert.equal(decodeConnect(`#c=${ID}.tok en`), null);
  assert.equal(decodeConnect(`#c=${ID}`), null, 'missing token');
  assert.equal(decodeConnect(`#c=${ID}.<script>`), null);
});

test('sheet code is stable, readable and differs per sheet', async () => {
  const a = await sheetCode(settings.url);
  assert.match(a, /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
  assert.equal(await sheetCode(settings.url), a);
  assert.notEqual(await sheetCode(settings.url.replace('ab/exec', 'ac/exec')), a);
});

test('recognises setup links in the address', () => {
  assert.ok(isSetupLinkHash(`#c=${ID}.x`));
  assert.ok(isSetupLinkHash('#connect=abc'));
  assert.ok(!isSetupLinkHash(''));
  assert.ok(!isSetupLinkHash('#cx=1'));
});
