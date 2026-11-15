// Per-keystroke latency for typing queries one char at a time, the way the
// popup does: same Searcher instance, so narrowing and the LRU are in play.
// Also reports a cold (full-scan) number per keystroke for comparison.
import { Searcher } from '../src/core/search.ts';
import type { RawItem } from '../src/core/types.ts';
import { makeLines } from '../test/fixtures/lines.ts';

const QUERIES = ['github pull', 'mdn sort', 'design review', 'ft-88', 'localhost dash', 'gmail inbox', 'tabgroups', 'x'];

function items(n: number): RawItem[] {
  return makeLines(n, 11).map((l, i) => {
    const [title, url, group] = l.split('  ');
    return { k: 'tab', id: i, title, url: 'https://' + url, win: i % 4, gt: group, la: Date.now() - i * 1000, fr: (i % 50) / 5 };
  });
}

function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

for (const n of [1000, 5000, 20000]) {
  const raws = items(n);
  let t = performance.now();
  const s = new Searcher();
  s.setBase(raws);
  s.setCtx({ win: 0, cur: 't:0' });
  const indexMs = performance.now() - t;

  // warm up JIT
  for (let r = 0; r < 3; r++) for (const q of QUERIES) for (let i = 1; i <= q.length; i++) { s.search(q.slice(0, i) + ' '.repeat(r)); }

  const typed: number[] = [];
  const cold: number[] = [];
  for (let rep = 0; rep < 5; rep++) {
    for (const q of QUERIES) {
      s.setCtx({ win: rep, cur: q }); // drop caches between queries without reallocating
      for (let i = 1; i <= q.length; i++) {
        t = performance.now();
        s.search(q.slice(0, i));
        typed.push(performance.now() - t);
      }
      for (let i = 1; i <= q.length; i++) {
        s.setCtx({ win: -i, cur: q }); // full scan: no narrowing, no LRU
        t = performance.now();
        s.search(q.slice(0, i));
        cold.push(performance.now() - t);
      }
    }
  }
  const f = (x: number) => x.toFixed(2).padStart(6);
  console.log(
    `${String(n).padStart(6)} items  index ${f(indexMs)}ms | typed p50 ${f(pct(typed, 50))} p99 ${f(pct(typed, 99))} max ${f(Math.max(...typed))} | cold p50 ${f(pct(cold, 50))} p99 ${f(pct(cold, 99))} ms`,
  );
}
