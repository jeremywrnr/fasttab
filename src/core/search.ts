import { exactMatch, fuzzyMatch, scoreRange } from './fzf.ts';
import { clsOf, keyOf, prepare, reusePrepared, SEP } from './prepare.ts';
import { canNarrow, parseQuery, type Query, type Scope, type Term } from './query.ts';
import type { Item, Kind, RawItem } from './types.ts';

export interface Ctx {
  /** window the switcher was opened in */
  win: number;
  /** key of the active tab in that window (derived from the items) */
  cur: string;
}

const KIND_BOOST: Record<Kind, number> = { tab: 24, group: 20, closed: 8, bookmark: 4, history: 0 };
const FREC_WEIGHT = 8;
const CURRENT_PENALTY = 30;
const LRU_SIZE = 32;

// ---------------------------------------------------------------- matching

function titleEnd(it: Item): number {
  if (it.uOff >= 0) return it.uOff - SEP.length;
  if (it.gOff >= 0) return it.gOff - SEP.length;
  return it.hay.length;
}

/** [start, end) of each field: title, url, group. */
function fields(it: Item): number[] {
  const out = [0, titleEnd(it)];
  if (it.uOff >= 0) out.push(it.uOff, it.gOff >= 0 ? it.gOff - SEP.length : it.hay.length);
  if (it.gOff >= 0) out.push(it.gOff, it.hay.length);
  return out;
}

export function matchTerm(it: Item, term: Term, pos: number[] | null): number {
  const t = term.cs ? it.hay : it.low;
  const p = term.text;
  // Char classes are only needed to score a hit, so the cheap rejections come first.
  switch (term.type) {
    case 'fuzzy':
      return fuzzyMatch(t, clsOf(it), p, pos);
    case 'exact':
      return t.includes(p) ? exactMatch(t, clsOf(it), p, pos) : -1;
    case 'prefix': {
      const f = fields(it);
      for (let i = 0; i < f.length; i += 2) {
        if (f[i + 1] - f[i] >= p.length && t.startsWith(p, f[i])) {
          return scoreRange(t, clsOf(it), p, f[i], f[i] + p.length, pos);
        }
      }
      return -1;
    }
    case 'suffix': {
      const f = fields(it);
      for (let i = 0; i < f.length; i += 2) {
        const s = f[i + 1] - p.length;
        if (s >= f[i] && t.startsWith(p, s)) return scoreRange(t, clsOf(it), p, s, f[i + 1], pos);
      }
      return -1;
    }
    case 'equal': {
      const e = titleEnd(it);
      if (e !== p.length || !t.startsWith(p)) return -1;
      return scoreRange(t, clsOf(it), p, 0, e, pos);
    }
  }
}

/** Sum of term scores, or -1 if any AND-group fails. */
export function matchItem(it: Item, q: Query): number {
  let total = 0;
  for (const g of q.groups) {
    let best = -1;
    for (const term of g) {
      let s: number;
      if (!term.inv) s = matchTerm(it, term, null);
      // A negation only needs presence, never a score.
      else if (term.type === 'exact') s = (term.cs ? it.hay : it.low).includes(term.text) ? -1 : 0;
      else s = matchTerm(it, term, null) < 0 ? 0 : -1;
      if (s > best) best = s;
    }
    if (best < 0) return -1;
    total += best;
  }
  return total;
}

/** Highlight positions for one item (only computed for rendered rows). */
export function positionsFor(it: Item, q: Query): number[] {
  const out: number[] = [];
  const tmp: number[] = [];
  for (const g of q.groups) {
    let best = -1;
    let bestPos: number[] = [];
    for (const term of g) {
      if (term.inv) continue;
      tmp.length = 0;
      const s = matchTerm(it, term, tmp);
      if (s > best) {
        best = s;
        bestPos = tmp.slice();
      }
    }
    for (const p of bestPos) out.push(p);
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

// ---------------------------------------------------------------- searcher

const SCOPE_KIND: Record<Exclude<Scope, ''>, Kind> = { t: 'tab', w: 'tab', g: 'group', c: 'closed', b: 'bookmark', h: 'history' };

function inScope(it: Item, scope: Scope, win: number): boolean {
  return !scope || (it.k === SCOPE_KIND[scope] && (scope !== 'w' || it.win === win));
}

export interface Result {
  q: Query;
  /** ordinals into `items`, best first */
  ids: Int32Array;
  items: Item[];
}

export function at(r: Result, i: number): Item {
  return r.items[r.ids[i]];
}

// Sort keys pack (history flag, rank, length, ordinal) into one float64 so a
// native TypedArray sort (no comparator, no per-hit objects) does the work.
//   bit 44      history-last flag
//   bits 30..43 inverted rank, 1/8 resolution, rank in [-512, 1536)
//   bits 20..29 haystack length (capped)
//   bits 0..19  ordinal
const P20 = 2 ** 20;
const P30 = 2 ** 30;
const P44 = 2 ** 44;
const MAX_ITEMS = P20;

function sortKey(it: Item, rank: number): number {
  let r = Math.round((rank + 512) * 8);
  r = r < 0 ? 0 : r > 16383 ? 16383 : r;
  const len = it.hay.length > 1023 ? 1023 : it.hay.length;
  return (it.k === 'history' ? P44 : 0) + (16383 - r) * P30 + len * P20 + it.ord;
}

let keyBuf = new Float64Array(4096);

function finish(n: number, items: Item[], q: Query): Result {
  const keys = keyBuf.subarray(0, n).sort();
  const ids = new Int32Array(n);
  for (let i = 0; i < n; i++) ids[i] = keys[i] % P20;
  return { q, ids, items };
}

export class Searcher {
  private base: Item[] = [];
  private bookmarks: Item[] = [];
  private history: Item[] = [];
  private all: Item[] = [];
  private version = 0;
  private lru = new Map<string, Result>();
  private last: (Result & { version: number }) | null = null;
  private ctx: Ctx = { win: -1, cur: '' };

  get context(): Ctx {
    return this.ctx;
  }

  /** The window the switcher belongs to; the current tab is derived from it. */
  setWin(win: number): void {
    if (win === this.ctx.win) return;
    this.ctx = { win, cur: '' };
    this.rebuild();
  }

  /** Replace tabs/groups/closed, reusing prepared items that did not change. */
  setBase(raws: RawItem[], win = this.ctx.win): void {
    const prev = new Map(this.base.map((it) => [it.key, it]));
    this.base = raws.map((r) => reusePrepared(prev.get(keyOf(r)), r) ?? prepare(r));
    this.ctx = { win, cur: '' };
    this.rebuild();
  }

  setBookmarks(raws: RawItem[]): void {
    this.bookmarks = raws.map(prepare);
    this.rebuild();
  }

  /** Merge history items (newest data wins); duplicates are dropped in rebuild. */
  addHistory(raws: RawItem[]): void {
    const m = new Map(this.history.map((it) => [it.nu, it]));
    for (const r of raws) {
      const it = prepare(r);
      m.set(it.nu, it);
    }
    this.history = Array.from(m.values());
    this.rebuild();
  }

  get(key: string): Item | undefined {
    return this.all.find((it) => it.key === key);
  }

  private rebuild(now = Date.now()): void {
    // One pass in priority order (tabs and groups, then closed, bookmarks,
    // history): the first item for a page wins, ignoring #fragment and
    // trailing slash, so an open tab hides the same page elsewhere.
    const seen = new Set<string>();
    for (const it of this.base) if (it.k === 'tab' && it.nu) seen.add(it.nu);
    const all: Item[] = [];
    let cur = '';
    for (const list of [this.base, this.bookmarks, this.history]) {
      for (const it of list) {
        if (it.k !== 'tab' && it.nu) {
          if (seen.has(it.nu)) continue;
          seen.add(it.nu);
        } else if (it.k === 'tab' && it.act && it.win === this.ctx.win) cur = it.key;
        if (all.length < MAX_ITEMS) all.push(it);
      }
    }
    this.ctx.cur = cur;
    for (let i = 0; i < all.length; i++) {
      const it = all[i];
      it.ord = i;
      it.boost = this.staticRank(it, now);
    }
    this.all = all;
    if (keyBuf.length < all.length) keyBuf = new Float64Array(all.length * 2);
    this.version++;
    this.lru.clear();
    this.last = null;
  }

  /** Query-independent part of the rank, computed once per rebuild. */
  private staticRank(it: Item, now: number): number {
    let r = KIND_BOOST[it.k];
    if (it.fr) r += FREC_WEIGHT * Math.log1p(it.fr);
    if (it.la && it.k === 'tab') r += 4 * Math.exp(-Math.max(0, now - it.la) / 3600e3);
    if (it.key === this.ctx.cur) r -= CURRENT_PENALTY;
    return r;
  }

  private defaults(q: Query): Result {
    const { win, cur } = this.ctx;
    const kind = q.scope ? SCOPE_KIND[q.scope] : 'tab';
    const sel = this.all.filter((it) => inScope(it, q.scope || 't', win));
    const score = (it: Item) =>
      it.key === cur ? -1 : kind === 'bookmark' ? (it.fr ?? 0) * 1e13 + (it.la ?? 0) : (it.la ?? 0);
    sel.sort((a, b) => score(b) - score(a) || a.ord - b.ord);
    return { q, ids: Int32Array.from(sel, (it) => it.ord), items: this.all };
  }

  search(raw: string): Result {
    const cached = this.lru.get(raw);
    if (cached) {
      this.lru.delete(raw);
      this.lru.set(raw, cached);
      this.last = { ...cached, version: this.version };
      return cached;
    }
    const q = parseQuery(raw);
    let res: Result;
    if (q.groups.length === 0) {
      res = this.defaults(q);
    } else {
      const all = this.all;
      const last = this.last;
      // Narrowing rescans only the previous hits (same scope, so no scope check needed).
      const ids = last && last.version === this.version && last.q.groups.length > 0 && canNarrow(last.q, q) ? last.ids : null;
      const len = ids ? ids.length : all.length;
      const { m0, m1, scope } = q;
      const win = this.ctx.win;
      const kb = keyBuf;
      let n = 0;
      for (let i = 0; i < len; i++) {
        const it = all[ids ? ids[i] : i];
        if ((it.m0 & m0) !== m0 || (it.m1 & m1) !== m1) continue;
        if (!ids && scope && !inScope(it, scope, win)) continue;
        const s = matchItem(it, q);
        if (s >= 0) kb[n++] = sortKey(it, s + it.boost);
      }
      res = finish(n, all, q);
    }
    this.lru.set(raw, res);
    if (this.lru.size > LRU_SIZE) this.lru.delete(this.lru.keys().next().value!);
    this.last = { ...res, version: this.version };
    return res;
  }
}
