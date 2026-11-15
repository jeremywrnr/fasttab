// Character classes, lowercasing, and prefilter masks.
// Everything here works per UTF-16 code unit so indexes stay aligned between
// the original haystack, its lowercase copy and the class array.

export const WHITE = 0;
export const NONWORD = 1;
export const DELIM = 2;
export const LOWER = 3;
export const UPPER = 4;
export const LETTER = 5;
export const NUMBER = 6;

const ASCII_CLASS = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  let k = NONWORD;
  if (c >= 97 && c <= 122) k = LOWER;
  else if (c >= 65 && c <= 90) k = UPPER;
  else if (c >= 48 && c <= 57) k = NUMBER;
  else if (c === 32 || (c >= 9 && c <= 13)) k = WHITE;
  else if (c === 47 || c === 44 || c === 58 || c === 59 || c === 124) k = DELIM; // / , : ; |
  ASCII_CLASS[c] = k;
}

const uniClassCache = new Map<number, number>();
const RE_LETTER = /\p{L}/u;
const RE_NUMBER = /\p{N}/u;
const RE_WHITE = /\s/u;

function uniClass(code: number): number {
  let k = uniClassCache.get(code);
  if (k !== undefined) return k;
  const ch = String.fromCharCode(code);
  const lo = ch.toLowerCase();
  const up = ch.toUpperCase();
  if (lo !== ch && lo.length === 1) k = UPPER;
  else if (up !== ch) k = LOWER;
  else if (RE_LETTER.test(ch)) k = LETTER;
  else if (RE_NUMBER.test(ch)) k = NUMBER;
  else if (RE_WHITE.test(ch)) k = WHITE;
  else k = NONWORD;
  uniClassCache.set(code, k);
  return k;
}

export function classesOf(s: string): Uint8Array {
  const n = s.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    out[i] = c < 128 ? ASCII_CLASS[c] : uniClass(c);
  }
  return out;
}

// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7f]/;

/** Lowercase without changing length (e.g. "İ" stays one code unit). */
export function lowerAligned(s: string): string {
  if (!NON_ASCII.test(s)) return s.toLowerCase();
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const lo = ch.toLowerCase();
    out += lo.length === 1 ? lo : ch;
  }
  return out;
}

// 64-bit presence mask split into two u32s. a-z → 0..25, 0-9 → 26..35,
// other ASCII hashed into 36..62, non-ASCII → 63.
function bitOf(c: number): number {
  if (c >= 97 && c <= 122) return c - 97;
  if (c >= 48 && c <= 57) return c - 22;
  if (c < 128) return 36 + (c % 27);
  return 63;
}

export function maskOf(lower: string): [number, number] {
  let m0 = 0;
  let m1 = 0;
  for (let i = 0; i < lower.length; i++) {
    const b = bitOf(lower.charCodeAt(i));
    if (b < 32) m0 |= 1 << b;
    else m1 |= 1 << (b - 32);
  }
  return [m0 >>> 0, m1 >>> 0];
}

/** Compact display form of a URL: drop scheme, www., trailing slash, cap length. */
export function prettyUrl(url: string): string {
  if (!url) return '';
  let s = url;
  if (s.startsWith('https://')) s = s.slice(8);
  else if (s.startsWith('http://')) s = s.slice(7);
  else return s.length > 160 ? s.slice(0, 160) : s;
  if (s.startsWith('www.')) s = s.slice(4);
  if (s.endsWith('/')) s = s.slice(0, -1);
  return s.length > 160 ? s.slice(0, 160) : s;
}

/** "https://www.example.com/x" → "example.com"; '' for non-network urls. */
export function hostOf(url: string): string {
  const m = /^[a-z][\w+.-]*:\/\/(?:www\.)?([^/:?#]+)/i.exec(url);
  return m ? m[1].toLowerCase() : '';
}

// Second-level labels that pair with a 2-letter country code (example.co.uk),
// and hosting suffixes where the subdomain is the actual site (you.github.io).
const CC_SECOND = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);
const SHARED_HOSTS = new Set([
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'web.app', 'firebaseapp.com',
  'herokuapp.com', 'blogspot.com', 'substack.com', 'notion.site', 'wordpress.com', 'fly.dev', 'onrender.com',
]);

/**
 * "app.plan.io" → "plan.io", "news.bbc.co.uk" → "bbc.co.uk", "you.github.io" stays.
 * Best-effort and for display only (not a public-suffix list): never key data on it.
 */
export function rootDomain(host: string): string {
  const p = host.split('.');
  if (p.length <= 2 || /^[\d.]+$/.test(host)) return host;
  const last2 = p.slice(-2).join('.');
  const take = SHARED_HOSTS.has(last2) || (p[p.length - 1].length === 2 && CC_SECOND.has(p[p.length - 2])) ? 3 : 2;
  return p.slice(-take).join('.');
}

/** What the url column shows: the root domain for web pages, a short form for the rest. */
export function siteLabel(url: string): string {
  if (/^(moz|chrome|safari-web)-extension:/.test(url)) return 'extension';
  const host = hostOf(url);
  if (host) return rootDomain(host);
  return /^[a-z-]+:(?:\/\/)?[^/?#]*/i.exec(url)?.[0] ?? url;
}
