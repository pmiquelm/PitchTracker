// Setup links: https://<app>/#connect=<code>
// The code carries the Apps Script URL and token, base64url-encoded. It lives in
// the URL fragment, which browsers never send to the server (GitHub Pages).

const PREFIX = 'connect=';

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code) {
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function isValidScriptUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'script.google.com';
  } catch {
    return false;
  }
}

export function encodeConnect({ url, token }) {
  return toBase64Url(JSON.stringify({ v: 1, u: url, t: token }));
}

// Accepts a full link, a "#connect=..." fragment, or the bare code.
// Returns { url, token, code } or null if it isn't a valid setup link.
export function decodeConnect(input) {
  if (!input) return null;
  let s = String(input).trim();
  const i = s.indexOf(PREFIX);
  if (i >= 0) s = s.slice(i + PREFIX.length);
  s = s.split(/[&\s]/)[0];
  try {
    const data = JSON.parse(fromBase64Url(s));
    if (data.v !== 1 || !isValidScriptUrl(data.u) || typeof data.t !== 'string' || !data.t) return null;
    return { url: data.u, token: data.t, code: s };
  } catch {
    return null;
  }
}

export function buildSetupLink(baseUrl, settings) {
  const base = String(baseUrl).split('#')[0];
  return `${base}#${PREFIX}${encodeConnect(settings)}`;
}
