import { exactMatch, fuzzyMatch, scoreRange } from './fzf.ts';
import { clsOf, prepare, SEP } from './prepare.ts';
import { canNarrow, parseQuery, type Query, type Term } from './query.ts';
import type { Item, Kind, RawItem } from './types.ts';

export interface Ctx {
  /** window the popup belongs to */
  win: number;
  /** key of the active tab in that window */
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
  const cls = clsOf(it);
  switch (term.type) {
    case 'fuzzy':
      return fuzzyMatch(t, cls, p, pos);
    case 'exact':
      return exactMatch(t, cls, p, pos);
    case 'prefix': {
      const f = fields(it);
      for (let i = 0; i < f.length; i += 2) {
        if (f[i + 1] - f[i] >= p.length && t.startsWith(p, f[i])) {
          return scoreRange(t, cls, p, f[i], f[i] + p.length, pos);
        }
      }
      return -1;
    }
    case 'suffix': {
      const f = fields(it);
      for (let i = 0; i < f.length; i += 2) {
        const s = f[i + 1] - p.length;
        if (s >= f[i] && t.startsWith(p, s)) return scoreRange(t, cls, p, s, f[i + 1], pos);
      }
      return -1;
    }
    case 'equal': {
      const e = titleEnd(it);
      if (e !== p.length || !t.startsWith(p)) return -1;
      return scoreRange(t, cls, p, 0, e, pos);
    }
  }
}

/** Sum of term scores, or -1 if any AND-group fails. */
export function matchItem(it: Item, q: Query): number {
  let total = 0;
  for (const g of q.groups) {
    let best = -1;
    for (const term of g) {
      let s = matchTerm(it, term, null);
      if (term.inv) s = s < 0 ? 0 : -1;
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

function inScope(it: Item, q: Query, ctx: Ctx): boolean {
  switch (q.scope) {
    case '':
      return true;
    case 't':
      return it.k === 'tab';
    case 'w':
      return it.k === 'tab' && it.win === ctx.win;
    case 'g':
      return it.k === 'group';
    case 'c':
      return it.k === 'closed';
    case 'b':
      return it.k === 'bookmark';
    case 'h':
      return it.k === 'history';
  }
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

  get size(): number {
    return this.all.length;
  }

  get context(): Ctx {
    return this.ctx;
  }

  setCtx(ctx: Ctx): void {
    if (ctx.win === this.ctx.win && ctx.cur === this.ctx.cur) return;
    this.ctx = ctx;
    this.rebuild();
  }

  /** Replace tabs/groups/closed, reusing prepared items that did not change. */
  setBase(raws: RawItem[]): void {
    const prev = new Map(this.base.map((it) => [it.key, it]));
    this.base = raws.map((r) => {
      const old = prev.get(r.k[0] + ':' + r.id);
      if (old && old.title === r.title && old.url === r.url && old.gt === r.gt) {
        const { hay, low, m0, m1, uOff, gOff, cls, key } = old;
        return Object.assign(r, { hay, low, m0, m1, uOff, gOff, cls, key }) as Item;
      }
      return prepare(r);
    });
    this.rebuild();
  }

  setBookmarks(raws: RawItem[]): void {
    this.bookmarks = raws.map(prepare);
    this.rebuild();
  }

  /** Merge history items (deduped by url, newest data wins). */
  addHistory(raws: RawItem[], replace = false): void {
    const m = new Map(replace ? [] : this.history.map((it) => [it.url, it]));
    for (const r of raws) m.set(r.url, prepare(r));
    this.history = Array.from(m.values());
    this.rebuild();
  }

  remove(key: string): void {
    this.base = this.base.filter((it) => it.key !== key);
    this.rebuild();
  }

  get(key: string): Item | undefined {
    return this.all.find((it) => it.key === key);
  }

  private rebuild(now = Date.now()): void {
    const open = new Set<string>();
    for (const it of this.base) if (it.k === 'tab') open.add(it.url);
    const bm = this.bookmarks.filter((it) => !open.has(it.url));
    for (const it of bm) open.add(it.url);
    const hist = this.history.filter((it) => !open.has(it.url));
    let all = this.base.concat(bm, hist);
    if (all.length > MAX_ITEMS) all = all.slice(0, MAX_ITEMS);
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
    const ctx = this.ctx;
    const kind: Kind = q.scope === 'g' ? 'group' : q.scope === 'c' ? 'closed' : q.scope === 'b' ? 'bookmark' : q.scope === 'h' ? 'history' : 'tab';
    const sel: Item[] = [];
    for (const it of this.all) {
      if (it.k !== kind) continue;
      if (q.scope === 'w' && it.win !== ctx.win) continue;
      sel.push(it);
    }
    const score = (it: Item) =>
      it.key === ctx.cur ? -1 : kind === 'bookmark' ? (it.fr ?? 0) * 1e13 + (it.la ?? 0) : (it.la ?? 0);
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
      const narrow = last && last.version === this.version && last.q.groups.length > 0 && canNarrow(last.q, q);
      const { m0, m1 } = q;
      const kb = keyBuf;
      let n = 0;
      if (narrow) {
        const ids = last.ids;
        for (let i = 0; i < ids.length; i++) {
          const it = all[ids[i]];
          if ((it.m0 & m0) !== m0 || (it.m1 & m1) !== m1) continue;
          const s = matchItem(it, q);
          if (s >= 0) kb[n++] = sortKey(it, s + it.boost);
        }
      } else {
        const ctx = this.ctx;
        for (let i = 0; i < all.length; i++) {
          const it = all[i];
          if ((it.m0 & m0) !== m0 || (it.m1 & m1) !== m1) continue;
          if (q.scope && !inScope(it, q, ctx)) continue;
          const s = matchItem(it, q);
          if (s >= 0) kb[n++] = sortKey(it, s + it.boost);
        }
      }
      res = finish(n, all, q);
    }
    this.lru.set(raw, res);
    if (this.lru.size > LRU_SIZE) this.lru.delete(this.lru.keys().next().value!);
    this.last = { ...res, version: this.version };
    return res;
  }
}
