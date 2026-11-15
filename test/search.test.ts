import { describe, expect, it } from 'vitest';
import { canNarrow, parseQuery } from '../src/core/query.ts';
import { Searcher, at, positionsFor, type Result } from '../src/core/search.ts';

const keys = (r: Result) => Array.from(r.ids, (_, i) => at(r, i).key);
import { bump, decayed, HALF_LIFE_MS, lookup, normUrl, prune, type FrecMap } from '../src/core/frecency.ts';
import { prepare } from '../src/core/prepare.ts';
import type { RawItem } from '../src/core/types.ts';
import { makeLines } from './fixtures/lines.ts';

const NOW = 1_800_000_000_000;

function tabs(): RawItem[] {
  return [
    { k: 'tab', id: 1, title: 'Pull requests', url: 'https://github.com/pulls', win: 1, la: NOW - 1000, act: 1 },
    { k: 'tab', id: 2, title: 'chrome.tabGroups', url: 'https://developer.chrome.com/docs/extensions/reference/api/tabGroups', win: 1, la: NOW - 5000, gid: 9, gt: 'Research', gc: 'blue' },
    { k: 'tab', id: 3, title: 'Inbox - Gmail', url: 'https://mail.google.com/mail/u/0/', win: 2, la: NOW - 2000 },
    { k: 'tab', id: 4, title: 'Hacker News', url: 'https://news.ycombinator.com/', win: 1, la: NOW - 9000, fr: 40 },
    { k: 'group', id: 9, title: 'Research', url: '', win: 1, la: NOW - 5000, n: 1, mru: 2, gc: 'blue' },
    { k: 'closed', id: 's1', title: 'Closed thing', url: 'https://example.com/closed', la: NOW - 100 },
  ];
}

function searcher() {
  const s = new Searcher();
  s.setBase(tabs());
  s.setCtx({ win: 1, cur: 't:1' });
  return s;
}

describe('parseQuery', () => {
  it('parses scopes, AND, OR and operators', () => {
    const q = parseQuery("g:work 'exact ^pre suf$ !neg a | b");
    expect(q.scope).toBe('g');
    expect(q.groups.map((g) => g.map((t) => `${t.inv ? '!' : ''}${t.type}:${t.text}`))).toEqual([
      ['fuzzy:work'], ['exact:exact'], ['prefix:pre'], ['suffix:suf'], ['!exact:neg'], ['fuzzy:a', 'fuzzy:b'],
    ]);
  });
  it('smart case', () => {
    expect(parseQuery('Foo').groups[0][0]).toMatchObject({ cs: true, text: 'Foo' });
    expect(parseQuery('foo').groups[0][0]).toMatchObject({ cs: false });
  });
  it('narrowing rules', () => {
    const n = (a: string, b: string) => canNarrow(parseQuery(a), parseQuery(b));
    expect(n('foo', 'foob')).toBe(true);
    expect(n('foo', 'foo bar')).toBe(true);
    expect(n('g', 'g:')).toBe(false);
    expect(n('foo', 'foo !x')).toBe(false);
    expect(n('foo', 'fo')).toBe(false);
  });
});

describe('Searcher', () => {
  it('empty query is MRU with the current tab last', () => {
    const r = searcher().search('');
    expect(keys(r)).toEqual(['t:3', 't:2', 't:4', 't:1']);
  });

  it('scopes', () => {
    const s = searcher();
    expect(keys(s.search('g:'))).toEqual(['g:9']);
    const w = s.search('w:');
    expect(Array.from(w.ids, (_, i) => at(w, i).win).every((x) => x === 1)).toBe(true);
    expect(keys(s.search('c:clo'))).toEqual(['c:s1']);
  });

  it('matches group names through tab haystacks', () => {
    const ks = keys(searcher().search('research'));
    expect(ks).toContain('t:2');
    expect(ks).toContain('g:9');
  });

  it('prefix matches host as well as title', () => {
    expect(keys(searcher().search('^news'))).toEqual(['t:4']);
  });

  it('negation', () => {
    const ks = keys(searcher().search('com !gmail'));
    expect(ks).not.toContain('t:3');
    expect(ks).toContain('t:4');
  });

  it('frecency lifts an otherwise weaker match', () => {
    const s = new Searcher();
    s.setBase([
      { k: 'tab', id: 1, title: 'news one', url: 'https://a.com', win: 1 },
      { k: 'tab', id: 2, title: 'news two', url: 'https://b.com', win: 1, fr: 30 },
    ]);
    expect(at(s.search('news'), 0).key).toBe('t:2');
  });

  it('history sorts after everything, bookmarks deduped against open tabs', () => {
    const s = searcher();
    s.setBookmarks([
      { k: 'bookmark', id: 'b1', title: 'GitHub pulls', url: 'https://github.com/pulls' },
      { k: 'bookmark', id: 'b2', title: 'Pull request guide', url: 'https://example.com/pr' },
    ]);
    s.addHistory([{ k: 'history', id: 'https://pulls.dev', title: 'Pull pull pull', url: 'https://pulls.dev' }]);
    const ks = keys(s.search('pull'));
    expect(ks).not.toContain('b:b1');
    expect(ks[ks.length - 1]).toBe('h:https://pulls.dev');
  });

  it('an open tab hides the same page as bookmark, history or closed, ignoring #fragment', () => {
    const s = new Searcher();
    s.setBase([
      { k: 'tab', id: 1, title: 'Guide to the Job Hunt', url: 'https://alvinwan.com/job-hunting', win: 1 },
      { k: 'closed', id: 'c1', title: 'Guide to the Job Hunt', url: 'https://alvinwan.com/job-hunting/#fn:1' },
    ]);
    s.setBookmarks([{ k: 'bookmark', id: 'b1', title: 'Guide to the Job Hunt', url: 'https://alvinwan.com/job-hunting/#fn:1' }]);
    s.addHistory([{ k: 'history', id: 'h', title: 'Guide to the Job Hunt', url: 'https://alvinwan.com/job-hunting#top' }]);
    expect(keys(s.search('guide'))).toEqual(['t:1']);
  });

  it('incremental narrowing gives the same result as a full search', () => {
    const lines = makeLines(3000);
    const raws: RawItem[] = lines.map((l, i) => ({ k: 'tab', id: i, title: l, url: '', win: 1 }));
    const inc = new Searcher();
    inc.setBase(raws.map((r) => ({ ...r })));
    for (const q of ['d', 'de', 'des', 'desi', 'desig', 'design', 'design ', 'design r', 'design re']) {
      const a = keys(inc.search(q));
      const fresh = new Searcher();
      fresh.setBase(raws.map((r) => ({ ...r })));
      const b = keys(fresh.search(q));
      expect(a).toEqual(b);
    }
  });

  it('positions split across title and url', () => {
    const it = prepare({ k: 'tab', id: 1, title: 'Hacker News', url: 'https://news.ycombinator.com/', win: 1 });
    const pos = positionsFor(it, parseQuery('hn ycomb'));
    expect(pos).toContain(0);
    expect(pos.some((p) => p >= it.uOff)).toBe(true);
  });
});

describe('frecency', () => {
  it('halves every half-life and accumulates', () => {
    const m: FrecMap = {};
    bump(m, 'https://a.com/#x', NOW);
    bump(m, 'https://a.com/', NOW);
    expect(lookup(m, 'https://a.com', NOW)).toBeCloseTo(2);
    expect(decayed(m['https://a.com'], NOW + HALF_LIFE_MS)).toBeCloseTo(1);
  });
  it('normalizes urls', () => {
    expect(normUrl('https://a.com/x/#frag')).toBe('https://a.com/x');
  });
  it('prunes to the top entries', () => {
    const m: FrecMap = {};
    for (let i = 0; i < 10; i++) bump(m, 'https://x/' + i, NOW, i + 1);
    expect(Object.keys(prune(m, NOW, 3))).toEqual(['https://x/9', 'https://x/8', 'https://x/7']);
  });
});
