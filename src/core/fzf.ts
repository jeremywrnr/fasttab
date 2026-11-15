// Port of fzf's FuzzyMatchV2 (src/algo/algo.go) plus the exact/prefix/suffix
// matchers used by its extended search syntax. Scores match fzf's default
// scheme so rankings line up with what fzf users expect.

import { WHITE, NONWORD, DELIM, LOWER, UPPER, NUMBER } from './text.ts';

export const SCORE_MATCH = 16;
const GAP_START = -3;
const GAP_EXT = -1;
const B_BOUNDARY = SCORE_MATCH / 2; // 8
const B_NONWORD = SCORE_MATCH / 2; // 8
const B_CAMEL = B_BOUNDARY + GAP_EXT; // 7
const B_CONSEC = -(GAP_START + GAP_EXT); // 4
const FIRST_MULT = 2;
const B_WHITE = B_BOUNDARY + 2; // 10
const B_DELIM = B_BOUNDARY + 1; // 9

function bonusFor(prev: number, cur: number): number {
  if (cur > NONWORD) {
    if (prev === WHITE) return B_WHITE;
    if (prev === DELIM) return B_DELIM;
    if (prev === NONWORD) return B_BOUNDARY;
  }
  if ((prev === LOWER && cur === UPPER) || (prev !== NUMBER && cur === NUMBER)) return B_CAMEL;
  if (cur === NONWORD || cur === DELIM) return B_NONWORD;
  if (cur === WHITE) return B_WHITE;
  return 0;
}

const BONUS = new Int8Array(49);
for (let p = 0; p < 7; p++) for (let c = 0; c < 7; c++) BONUS[p * 7 + c] = bonusFor(p, c);

// Reusable scratch buffers, grown on demand. Single-threaded, so sharing is safe.
let H0 = new Int32Array(512);
let C0 = new Int32Array(512);
let B = new Int32Array(512);
let F = new Int32Array(64);
let H = new Int32Array(8192);
let C = new Int32Array(8192);

function ensure(n: number, m: number) {
  if (H0.length < n) {
    const sz = Math.max(n, H0.length * 2);
    H0 = new Int32Array(sz);
    C0 = new Int32Array(sz);
    B = new Int32Array(sz);
  }
  if (F.length < m) F = new Int32Array(Math.max(m, F.length * 2));
}

function ensureMatrix(n: number) {
  if (H.length < n) {
    const sz = Math.max(n, H.length * 2);
    H = new Int32Array(sz);
    C = new Int32Array(sz);
  }
}

/**
 * fzf v2 fuzzy match. Returns the score, or -1 for no match. When `pos` is
 * given, matched indexes are pushed onto it (in reverse order).
 * `t` must already be lowercased when matching case-insensitively.
 */
export function fuzzyMatch(t: string, cls: Uint8Array, pat: string, pos: number[] | null): number {
  const M = pat.length;
  const N = t.length;
  if (M === 0) return 0;
  if (M > N) return -1;

  // Phase 1: check the pattern occurs in order and find the scan window.
  let pidx = 0;
  let first = -1;
  let pc = pat.charCodeAt(0);
  for (let i = 0; i < N; i++) {
    if (t.charCodeAt(i) === pc) {
      if (pidx === 0) first = i;
      if (++pidx === M) break;
      pc = pat.charCodeAt(pidx);
    }
  }
  if (pidx < M) return -1;
  const lastc = pat.charCodeAt(M - 1);
  let last = N - 1;
  while (t.charCodeAt(last) !== lastc) last--;

  ensure(N, M);

  // Phase 2: bonuses, first row of the score matrix, first-occurrence table.
  const p0 = pat.charCodeAt(0);
  pc = p0;
  pidx = 0;
  let maxScore = 0;
  let maxPos = 0;
  let prevH0 = 0;
  let inGap = false;
  let prevClass = first > 0 ? cls[first - 1] : WHITE;
  for (let i = first; i <= last; i++) {
    const c = t.charCodeAt(i);
    const k = cls[i];
    const bonus = BONUS[prevClass * 7 + k];
    B[i] = bonus;
    prevClass = k;
    if (c === pc && pidx < M) {
      F[pidx++] = i;
      pc = pat.charCodeAt(pidx < M ? pidx : M - 1);
    }
    if (c === p0) {
      const s = SCORE_MATCH + bonus * FIRST_MULT;
      H0[i] = s;
      C0[i] = 1;
      if (M === 1 && s > maxScore) {
        maxScore = s;
        maxPos = i;
        if (bonus >= B_BOUNDARY) break;
      }
      inGap = false;
    } else {
      const s = prevH0 + (inGap ? GAP_EXT : GAP_START);
      H0[i] = s > 0 ? s : 0;
      C0[i] = 0;
      inGap = true;
    }
    prevH0 = H0[i];
  }

  if (M === 1) {
    if (pos) pos.push(maxPos);
    return maxScore;
  }

  // Phase 3: fill the score matrix, row per pattern char, from F[i] to last.
  const f0 = F[0];
  const width = last - f0 + 1;
  ensureMatrix(M * width);
  for (let j = 0; j < width; j++) {
    H[j] = H0[f0 + j];
    C[j] = C0[f0 + j];
  }
  const lastRow = (M - 1) * width;
  for (let i = 1; i < M; i++) {
    const f = F[i];
    const pch = pat.charCodeAt(i);
    const row = i * width;
    const prow = row - width;
    H.fill(0, row, row + f - f0);
    C.fill(0, row, row + f - f0);
    inGap = false;
    for (let col = f; col <= last; col++) {
      const j0 = col - f0;
      let s1 = 0;
      const s2: number = H[row + j0 - 1] + (inGap ? GAP_EXT : GAP_START);
      let consec = 0;
      if (t.charCodeAt(col) === pch) {
        s1 = H[prow + j0 - 1] + SCORE_MATCH;
        let b = B[col];
        consec = C[prow + j0 - 1] + 1;
        if (consec > 1) {
          const fb = B[col - consec + 1];
          if (b >= B_BOUNDARY && b > fb) consec = 1;
          else b = Math.max(b, B_CONSEC, fb);
        }
        if (s1 + b < s2) {
          s1 += B[col];
          consec = 0;
        } else {
          s1 += b;
        }
      }
      C[row + j0] = consec;
      inGap = s1 < s2;
      const score = s1 > s2 ? (s1 > 0 ? s1 : 0) : s2 > 0 ? s2 : 0;
      if (row === lastRow && score > maxScore) {
        maxScore = score;
        maxPos = col;
      }
      H[row + j0] = score;
    }
  }

  // Phase 4: backtrace for positions.
  if (pos) {
    const size = M * width;
    let i = M - 1;
    let j = maxPos;
    let preferMatch = true;
    while (j >= f0) {
      const I = i * width;
      const j0 = j - f0;
      const s = H[I + j0];
      let s1 = 0;
      let s2 = 0;
      if (i > 0 && j >= F[i]) s1 = H[I - width + j0 - 1];
      if (j > F[i]) s2 = H[I + j0 - 1];
      if (s > s1 && (s > s2 || (s === s2 && preferMatch))) {
        pos.push(j);
        if (i === 0) break;
        i--;
      }
      const nx = I + width + j0 + 1;
      preferMatch = C[I + j0] > 1 || (nx < size && C[nx] > 0);
      j--;
    }
  }
  return maxScore;
}

/** fzf calculateScore: score a known contiguous match t[s..e). */
export function scoreRange(t: string, cls: Uint8Array, pat: string, s: number, e: number, pos: number[] | null): number {
  let pidx = 0;
  let score = 0;
  let inGap = false;
  let consec = 0;
  let firstBonus = 0;
  let prevClass = s > 0 ? cls[s - 1] : WHITE;
  for (let i = s; i < e; i++) {
    const k = cls[i];
    if (t.charCodeAt(i) === pat.charCodeAt(pidx)) {
      if (pos) pos.push(i);
      score += SCORE_MATCH;
      let bonus = BONUS[prevClass * 7 + k];
      if (consec === 0) {
        firstBonus = bonus;
      } else {
        if (bonus >= B_BOUNDARY && bonus > firstBonus) firstBonus = bonus;
        bonus = Math.max(bonus, firstBonus, B_CONSEC);
      }
      score += pidx === 0 ? bonus * FIRST_MULT : bonus;
      inGap = false;
      consec++;
      pidx++;
    } else {
      score += inGap ? GAP_EXT : GAP_START;
      inGap = true;
      consec = 0;
      firstBonus = 0;
    }
    prevClass = k;
  }
  return score;
}

/** Exact substring; picks the occurrence with the best start bonus, like fzf. */
export function exactMatch(t: string, cls: Uint8Array, pat: string, pos: number[] | null): number {
  const M = pat.length;
  if (M === 0) return 0;
  let idx = t.indexOf(pat);
  if (idx < 0) return -1;
  let best = idx;
  let bestBonus = -1;
  for (let n = 0; idx >= 0 && n < 32; n++) {
    const b = BONUS[(idx > 0 ? cls[idx - 1] : WHITE) * 7 + cls[idx]];
    if (b > bestBonus) {
      bestBonus = b;
      best = idx;
      if (b >= B_WHITE) break;
    }
    idx = t.indexOf(pat, idx + 1);
  }
  return scoreRange(t, cls, pat, best, best + M, pos);
}
