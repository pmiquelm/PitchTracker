import test from 'node:test';
import assert from 'node:assert/strict';
import { describeError, testConnection } from '../js/sync.js';

const URL = 'https://script.google.com/macros/s/x/exec';

test('describeError: only an offline device is "No connection"', () => {
  assert.equal(describeError(new TypeError('Load failed'), false), 'No connection');
  assert.match(describeError(new TypeError('Load failed'), true), /deployed with access "Anyone"/);
  assert.match(describeError(Object.assign(new Error('x'), { name: 'AbortError' }), true), /too long/);
  assert.match(describeError(new SyntaxError('Unexpected token <'), true), /page instead of data/);
  assert.equal(describeError(new Error('Wrong token'), true), 'Wrong token');
});

test('testConnection posts an empty upload with the token', async (t) => {
  let sent;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sent = { url, opts };
    return new Response(JSON.stringify({ ok: true, version: 6, received: 0 }));
  });
  await testConnection(URL, 'tok');
  assert.equal(sent.url, URL);
  assert.equal(sent.opts.method, 'POST');
  assert.deepEqual(JSON.parse(sent.opts.body), { token: 'tok', rows: [] });
});

test('testConnection reports a wrong token and an HTML page', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: false, error: 'Wrong token' })));
  await assert.rejects(testConnection(URL, 'bad'), /Wrong token/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>Sign in</html>'));
  await assert.rejects(testConnection(URL, 'tok'), /page instead of data/);
});

test('testConnection says when the sheet script is too old', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true, received: 0 })));
  await assert.rejects(testConnection(URL, 'tok'), /out of date/);
});
