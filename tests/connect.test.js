import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSetupLink, decodeConnect, isValidScriptUrl } from '../js/connect.js';

const settings = { url: 'https://script.google.com/macros/s/AKfy-abc_123/exec', token: '3f1c-éñ' };

test('setup link round-trips from full link, fragment and bare code', () => {
  const link = buildSetupLink('https://pmiquelm.github.io/PitchTracker/#old', settings);
  assert.ok(link.startsWith('https://pmiquelm.github.io/PitchTracker/#connect='));
  const code = link.split('#connect=')[1];
  for (const input of [link, `#connect=${code}`, code, `  ${link}  `]) {
    const d = decodeConnect(input);
    assert.equal(d.url, settings.url);
    assert.equal(d.token, settings.token);
  }
  assert.doesNotMatch(code, /[+/=]/);
});

test('rejects garbage and non-Google URLs', () => {
  assert.equal(decodeConnect(''), null);
  assert.equal(decodeConnect('hello'), null);
  assert.equal(decodeConnect(buildSetupLink('x', { url: 'https://evil.example/exec', token: 't' })), null);
  assert.equal(decodeConnect(buildSetupLink('x', { url: settings.url, token: '' })), null);
  assert.equal(isValidScriptUrl('http://script.google.com/x'), false);
});
