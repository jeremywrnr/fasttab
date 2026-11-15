// fzf extended-search syntax plus fasttab scope prefixes.
//   foo bar   AND        a | b   OR
//   'foo      exact      ^foo    prefix (of title or host)
//   foo$      suffix     ^foo$   equal (title)
//   !foo      not (exact), !^foo, !foo$
//   g: groups  t: tabs  w: current window  c: recently closed  b: bookmarks  h: history

import { maskOf } from './text.ts';

export type TermType = 'fuzzy' | 'exact' | 'prefix' | 'suffix' | 'equal';

export interface Term {
  type: TermType;
  text: string;
  inv: boolean;
  /** smart case: any uppercase makes the term case-sensitive */
  cs: boolean;
}

export type Scope = '' | 'g' | 't' | 'w' | 'c' | 'b' | 'h';

export interface Query {
  raw: string;
  scope: Scope;
  /** AND of OR-groups */
  groups: Term[][];
  /** prefilter mask: chars every match must contain */
  m0: number;
  m1: number;
  /** plain text for history.search */
  plain: string;
}

const SCOPE_RE = /^([gtwcbh]):/;

function parseTerm(tok: string): Term | null {
  let inv = false;
  let type: TermType = 'fuzzy';
  let s = tok;
  if (s.startsWith('!')) {
    inv = true;
    type = 'exact';
    s = s.slice(1);
  }
  if (s.length > 1 && s.endsWith('$') && !s.endsWith('\\$')) {
    type = 'suffix';
    s = s.slice(0, -1);
  }
  if (s.startsWith("'")) {
    if (type === 'fuzzy') type = 'exact';
    else if (inv && type === 'exact') type = 'fuzzy'; // !'foo = not fuzzy
    s = s.slice(1);
  } else if (s.startsWith('^')) {
    type = type === 'suffix' ? 'equal' : 'prefix';
    s = s.slice(1);
  }
  s = s.replace(/\\\$$/, '$');
  if (!s) return null;
  const cs = s !== s.toLowerCase();
  return { type, text: cs ? s : s.toLowerCase(), inv, cs };
}

export function parseQuery(raw: string): Query {
  let rest = raw.trimStart();
  let scope: Scope = '';
  const m = SCOPE_RE.exec(rest);
  if (m) {
    scope = m[1] as Scope;
    rest = rest.slice(2);
  }
  // split on unescaped spaces; "\ " is a literal space
  const toks = rest
    .replace(/\\ /g, '\u0000')
    .split(/ +/)
    .filter(Boolean)
    .map((t) => t.replace(/\u0000/g, ' '));
  const groups: Term[][] = [];
  let orNext = false;
  for (const tok of toks) {
    if (tok === '|') {
      orNext = groups.length > 0;
      continue;
    }
    const t = parseTerm(tok);
    if (!t) continue;
    if (orNext) groups[groups.length - 1].push(t);
    else groups.push([t]);
    orNext = false;
  }
  let m0 = 0;
  let m1 = 0;
  const plain: string[] = [];
  for (const g of groups) {
    if (g.length !== 1 || g[0].inv) continue;
    const [a, b] = maskOf(g[0].text.toLowerCase());
    m0 |= a;
    m1 |= b;
    plain.push(g[0].text);
  }
  return { raw, scope, groups, m0: m0 >>> 0, m1: m1 >>> 0, plain: plain.join(' ') };
}

/**
 * Can results for `next` be computed by filtering the results of `prev`?
 * True when next only appends characters and nothing in prev can loosen
 * (negations, OR, suffix anchors, escapes) and the scope is unchanged.
 */
export function canNarrow(prev: Query, next: Query): boolean {
  return (
    prev.raw.length > 0 &&
    next.raw.startsWith(prev.raw) &&
    prev.scope === next.scope &&
    !/[!|$\\]/.test(next.raw)
  );
}
