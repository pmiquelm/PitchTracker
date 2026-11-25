// Setup links carry the sheet connection (Apps Script address + token) in the URL
// fragment (after #), which browsers never send to the server (GitHub Pages).
//
//   Short form (current):  https://<app>/#c=<deployment id>.<token>
//   Long form (old links): https://<app>/#connect=<base64url JSON {v, u, t}>
//
// The short form is used whenever the address is a standard Apps Script web app
// address; anything else (e.g. Google Workspace domain addresses) uses the long form.
// Both are always accepted.

const LONG = 'connect=';
const SHORT = 'c=';
const ID = '[A-Za-z0-9_-]{10,200}';
const TOKEN = '[A-Za-z0-9_-]{8,200}';
const STANDARD_URL = new RegExp(`^https://script\\.google\\.com/macros/s/(${ID})/exec$`);
const WORKSPACE_URL = new RegExp(`^https://script\\.google\\.com/a/macros/[A-Za-z0-9.-]{1,253}/s/${ID}/exec$`);
const SHORT_CODE = new RegExp(`^(${ID})\\.(${TOKEN})$`);

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

// Only exact Apps Script web app addresses: https, script.google.com, the /exec
// path, and nothing else (no port, login, query or fragment that could smuggle
// the pitches somewhere else).
export function isValidScriptUrl(url) {
  return typeof url === 'string' && (STANDARD_URL.test(url) || WORKSPACE_URL.test(url));
}

const isValidToken = (t) => typeof t === 'string' && new RegExp(`^${TOKEN}$`).test(t);

export function encodeConnect({ url, token }) {
  const m = STANDARD_URL.exec(url);
  if (m && isValidToken(token)) return `${SHORT}${m[1]}.${token}`;
  return `${LONG}${toBase64Url(JSON.stringify({ v: 1, u: url, t: token }))}`;
}

function decodeShort(code) {
  const m = SHORT_CODE.exec(code);
  if (!m) return null;
  return { url: `https://script.google.com/macros/s/${m[1]}/exec`, token: m[2], code };
}

function decodeLong(code) {
  try {
    const data = JSON.parse(fromBase64Url(code));
    if (data.v !== 1 || !isValidScriptUrl(data.u) || !isValidToken(data.t)) return null;
    return { url: data.u, token: data.t, code };
  } catch {
    return null;
  }
}

// Accepts a full link, a "#c=…" / "#connect=…" fragment, or a bare code.
// Returns { url, token, code } or null if it isn't a valid setup link.
export function decodeConnect(input) {
  if (!input) return null;
  const s = String(input).trim();
  const long = /(?:^|[#&?])connect=([^&\s#]+)/.exec(s);
  if (long) return decodeLong(long[1]);
  const short = /(?:^|[#&?])c=([^&\s#]+)/.exec(s);
  if (short) return decodeShort(short[1]);
  return decodeShort(s) || decodeLong(s); // bare code
}

export function buildSetupLink(baseUrl, settings) {
  const base = String(baseUrl).split('#')[0];
  return `${base}#${encodeConnect(settings)}`;
}

export const isSetupLinkHash = (hash) => /(?:^|[#&])(c|connect)=/.test(hash || '');

// Team dashboard links have the same two forms with their own names, so neither kind of
// link can be taken for the other:
//   https://<app>/dashboard/#v=<deployment id>.<viewer key>
//   https://<app>/dashboard/#view=<base64url JSON {v, u, k}>   (non-standard addresses)
// The viewer key only reads (see Code.gs), so a dashboard link can never add pitches.
const VIEW_LONG = 'view=';
const VIEW_SHORT = 'v=';

export function buildViewerLink(dashboardUrl, { url, key }) {
  const base = String(dashboardUrl).split('#')[0];
  const m = STANDARD_URL.exec(url);
  if (m && isValidToken(key)) return `${base}#${VIEW_SHORT}${m[1]}.${key}`;
  return `${base}#${VIEW_LONG}${toBase64Url(JSON.stringify({ v: 1, u: url, k: key }))}`;
}

// Accepts a full dashboard link, its "#v=…" / "#view=…" fragment, or a bare code.
// Returns { url, key } or null. Setup links (#c=, #connect=) are not dashboard links.
export function decodeViewerLink(input) {
  if (!input) return null;
  const s = String(input).trim();
  const long = /(?:^|[#&?])view=([^&\s#]+)/.exec(s);
  if (long) {
    try {
      const data = JSON.parse(fromBase64Url(long[1]));
      if (data.v !== 1 || !isValidScriptUrl(data.u) || !isValidToken(data.k)) return null;
      return { url: data.u, key: data.k };
    } catch {
      return null;
    }
  }
  const short = /(?:^|[#&?])v=([^&\s#]+)/.exec(s);
  const m = SHORT_CODE.exec(short ? short[1] : s);
  if (!m || (!short && /[#?]/.test(s))) return null;
  return { url: `https://script.google.com/macros/s/${m[1]}/exec`, key: m[2] };
}

export const isViewerLinkHash = (hash) => /(?:^|[#&])(v|view)=/.test(hash || '');

// A short, human-checkable code for a sheet ("K7Q-X2M"): the first 30 bits of a
// SHA-256 of the script address. The owner's phone and the phone being connected
// show the same code, so a link or QR code that points somewhere else is spotted
// by comparing them out loud. Not secret; it identifies the sheet, not the token.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O or 1/I

export async function sheetCode(url) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url)));
  let bits = 0;
  for (let i = 0; i < 4; i++) bits = (bits << 8) | digest[i];
  bits >>>= 2; // keep the top 30 bits
  let out = '';
  for (let i = 0; i < 6; i++) out = ALPHABET[(bits >>> (5 * i)) & 31] + out;
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}
