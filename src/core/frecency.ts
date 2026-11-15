// Exponentially decayed visit counts (zoxide-style): one number and a
// timestamp per URL, so a bump or a read is O(1).

export interface Frec {
  s: number;
  t: number;
}

export type FrecMap = Record<string, Frec>;

export const HALF_LIFE_MS = 3 * 24 * 3600 * 1000;
export const MAX_ENTRIES = 5000;

export function decayed(e: Frec | undefined, now: number): number {
  if (!e) return 0;
  const dt = now - e.t;
  return dt <= 0 ? e.s : e.s * Math.pow(2, -dt / HALF_LIFE_MS);
}

export function bump(map: FrecMap, url: string, now: number, weight = 1): void {
  const k = normUrl(url);
  if (!k) return;
  map[k] = { s: decayed(map[k], now) + weight, t: now };
}

export function lookup(map: FrecMap, url: string, now: number): number {
  return decayed(map[normUrl(url)], now);
}

/** Keep the top `max` entries by current score; drop dust. */
export function prune(map: FrecMap, now: number, max = MAX_ENTRIES): FrecMap {
  const rows = Object.entries(map)
    .map(([k, e]) => [k, decayed(e, now)] as const)
    .filter(([, s]) => s > 0.01);
  if (rows.length <= max && rows.length === Object.keys(map).length) return map;
  rows.sort((a, b) => b[1] - a[1]);
  const out: FrecMap = {};
  for (const [k, s] of rows.slice(0, max)) out[k] = { s, t: now };
  return out;
}

export function normUrl(url: string): string {
  if (!url) return '';
  let u = url;
  const h = u.indexOf('#');
  if (h >= 0) u = u.slice(0, h);
  if (u.endsWith('/')) u = u.slice(0, -1);
  return u;
}
