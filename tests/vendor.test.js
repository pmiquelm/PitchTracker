import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// The vendored QR library must be exactly the reviewed build (see the header of the
// file for its source). Any change, accidental or not, fails this test. After a
// deliberate update, put the new checksum here and note it in the pull request.
const PINNED = '198f67eda96a19a5b862c072bd7b0afc43d46bac01d27f191f7226470f676ae2';

test('vendored QR library is unchanged', () => {
  const sha = createHash('sha256').update(readFileSync(new URL('../js/vendor/qrcodegen.js', import.meta.url))).digest('hex');
  assert.equal(sha, PINNED);
});

test('vendored QR library makes no network, page or storage calls', () => {
  const src = readFileSync(new URL('../js/vendor/qrcodegen.js', import.meta.url), 'utf8');
  for (const api of ['fetch(', 'XMLHttpRequest', 'eval(', 'Function(', 'document.', 'window.', 'localStorage', 'indexedDB', 'navigator.', 'import(', 'WebSocket', 'postMessage']) {
    assert.ok(!src.includes(api), `unexpected use of ${api}`);
  }
});
