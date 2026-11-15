import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { exactMatch, fuzzyMatch } from '../src/core/fzf.ts';
import { classesOf, lowerAligned } from '../src/core/text.ts';
import { parseQuery } from '../src/core/query.ts';
import { makeLines, QUERIES } from './fixtures/lines.ts';

function score(line: string, query: string): number {
  const q = parseQuery(query);
  const cls = classesOf(line);
  const low = lowerAligned(line);
  let total = 0;
  for (const [t] of q.groups) {
    const s = t.type === 'exact' ? exactMatch(t.cs ? line : low, cls, t.text, null) : fuzzyMatch(t.cs ? line : low, cls, t.text, null);
    if (s < 0) return -1;
    total += s;
  }
  return total;
}

function ours(lines: string[], query: string): string[] {
  return lines
    .map((l, i) => ({ l, i, s: score(l, query) }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.l);
}

const hasFzf = spawnSync('fzf', ['--version']).status === 0;

describe.skipIf(!hasFzf)('parity with fzf --filter', () => {
  // Unique lines so ordering comparisons are unambiguous.
  const lines = Array.from(new Set(makeLines(600)));
  for (const q of QUERIES) {
    it(`orders like fzf for "${q}"`, () => {
      const r = spawnSync('fzf', ['--filter', q, '--tiebreak=index'], {
        input: lines.join('\n'),
        encoding: 'utf8',
      });
      const theirs = r.stdout.split('\n').filter(Boolean);
      expect(ours(lines, q)).toEqual(theirs);
    });
  }
});

describe('fuzzyMatch', () => {
  const run = (text: string, pat: string) => {
    const pos: number[] = [];
    const s = fuzzyMatch(lowerAligned(text), classesOf(text), pat, pos);
    return { s, pos: pos.sort((a, b) => a - b) };
  };

  it('rejects out-of-order and missing chars', () => {
    expect(run('abc', 'cba').s).toBe(-1);
    expect(run('abc', 'abcd').s).toBe(-1);
    expect(run('', 'a').s).toBe(-1);
  });

  it('prefers word boundaries for positions', () => {
    expect(run('foo bar baz', 'bb').pos).toEqual([4, 8]);
    expect(run('xxfooxx foo', 'foo').pos).toEqual([8, 9, 10]);
  });

  it('scores a camelCase hit above a mid-word hit', () => {
    expect(run('tabGroups', 'tg').s).toBeGreaterThan(run('outage', 'tg').s);
  });

  it('positions for single char use the best boundary', () => {
    expect(run('xab b', 'b').pos).toEqual([4]);
  });
});
