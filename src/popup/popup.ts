// Popup: paints from the storage.session snapshot in stages, searches
// synchronously on every input event, and renders a virtualized list.
//
//   stage 1  ft_top   (~30 MRU tabs)         → first paint
//   stage 2  ft_full  (all tabs/groups/closed) → full search
//   stage 3  idle     bookmarks + recent history
//   stage 4  typing   live history.search (debounced) for older pages

import { keyOf, SEP } from '../core/prepare.ts';
import { parseQuery } from '../core/query.ts';
import { at, positionsFor, Searcher, type Result } from '../core/search.ts';
import type { Item, RawItem } from '../core/types.ts';
import { actionLabel, recentlyClosed } from '../shared/actions.ts';
import { buildRaw, FAVICONS, hasGroups, type FaviconMap, SNAP_FULL, SNAP_TOP, type GroupInfo, type Snapshot } from '../shared/raw.ts';
import { hostOf } from '../core/text.ts';
import { DEFAULT_SHORTCUT, prettyShortcut, shortcutMatcher } from '../shared/shortcut.ts';
import { direct, send, viaBackground, type Backend } from './backend.ts';
import { iconImg, setIcon, VList, type Row } from './vlist.ts';

declare const __CHROME__: boolean;

const GROUP_COLORS: Record<string, string> = {
  grey: '#80868b',
  blue: '#1a73e8',
  red: '#d93025',
  yellow: '#f9ab00',
  green: '#188038',
  pink: '#d01884',
  purple: '#a142f4',
  cyan: '#007b83',
  orange: '#fa903e',
};
const HISTORY_LIVE_DEBOUNCE = 120;

const $q = document.getElementById('q') as HTMLInputElement;
const $scroller = document.getElementById('scroller')!;
const $inner = document.getElementById('inner')!;
const $empty = document.getElementById('empty')!;
const $act = document.getElementById('act')!;
const $next = document.getElementById('next')!;
const $nextIcon = iconImg(document.getElementById('next-icon') as HTMLImageElement);
const $shortcut = document.getElementById('shortcut') as HTMLAnchorElement;
const $results = document.getElementById('results')!;
const $panel = document.getElementById('panel')!;

// Overlay mode: loaded in a frame the background injected into a page, with a
// one-time token in the hash. Otherwise this is the toolbar popup (or the
// popup-window fallback).
const TOKEN = location.hash.startsWith('#o=') ? location.hash.slice(3) : '';
const OVERLAY = !!TOKEN;
if (OVERLAY) document.documentElement.classList.add('overlay');
const MAX_ROWS = 10;

const overlayApi = OVERLAY ? viaBackground(TOKEN) : null;
const api: Backend = overlayApi ?? direct;

const s = new Searcher();
let res: Result | null = null;
let sel = 0;
let snapV = -1;
let fullLoaded = false;

// Overlay: the frame covers the page, so a click outside the panel closes it.
if (OVERLAY) {
  document.addEventListener('mousedown', (e) => {
    if (!$panel.contains(e.target as Node)) dismiss();
  });
}

function dismiss(): void {
  if (OVERLAY) parent.postMessage({ ft: 'close' }, '*');
  else window.close();
}

/**
 * Minimal first: only the input until you type or press ↓. A leading space
 * counts as typing: on its own it lists every open tab, most recent first.
 */
let expanded = false;
const showList = () => expanded || $q.value.length > 0;

function layout(): void {
  const show = showList();
  const n = count();
  $results.hidden = !show;
  $inner.parentElement!.style.height = n ? Math.min(n, MAX_ROWS) * list.rowH + 'px' : '';
  $empty.hidden = n > 0 || !fullLoaded;
  // Empty query: show on the right where ↵ goes (the previous tab's favicon).
  const next = !$q.value && res && n ? at(res, 0) : null;
  $next.hidden = !next;
  if (next) {
    setIcon($nextIcon, faviconFor(next));
    $next.title = next.title;
  }
}

// ------------------------------------------------------------------ rendering

const faviconBase = __CHROME__ ? chrome.runtime.getURL('/_favicon/') : '';
/** Firefox/Safari: host → favicon url, collected by the background from open tabs. */
let favicons: FaviconMap = {};
function setFavicons(map: FaviconMap | undefined): void {
  if (!map) return;
  favicons = map;
  list.draw(); // rows pick the icons up outside their render signature
  layout();
}
function faviconFor(it: Item): string {
  if (!it.url || it.k === 'group') return '';
  if (__CHROME__) return `${faviconBase}?pageUrl=${encodeURIComponent(it.url)}&size=32`;
  return favicons[hostOf(it.url)] ?? '';
}

/** Append text with <mark> runs for positions in [off, off + text.length). */
function highlight(el: HTMLElement, text: string, off: number, pos: number[]): void {
  el.textContent = '';
  if (!pos.length) {
    el.textContent = text;
    return;
  }
  let i = 0;
  let run = '';
  let marked = false;
  const flush = () => {
    if (!run) return;
    if (marked) {
      const m = document.createElement('mark');
      m.textContent = run;
      el.appendChild(m);
    } else el.appendChild(document.createTextNode(run));
    run = '';
  };
  let p = 0;
  while (p < pos.length && pos[p] < off) p++;
  for (; i < text.length; i++) {
    const hit = p < pos.length && pos[p] === off + i;
    if (hit) p++;
    if (hit !== marked) {
      flush();
      marked = hit;
    }
    run += text[i];
  }
  flush();
}

function badgeFor(it: Item): string {
  if (it.k === 'group') return `${it.n} tab${it.n === 1 ? '' : 's'}${it.col ? ' · collapsed' : ''}`;
  if (it.k !== 'tab') return '';
  return [it.pin && 'pinned', it.disc && 'asleep'].filter(Boolean).join(' · ');
}

// Bookmarks, history and closed tabs are dimmed (their favicons grayscale
// until selected) and marked at the right edge, so open tabs read first.
const KIND_MARK: Partial<Record<Item['k'], [string, string]>> = {
  bookmark: ['★', 'Bookmark'],
  history: ['◷', 'History'],
  closed: ['↺', 'Recently closed'],
};

function renderRow(row: Row, i: number): void {
  if (!res) return;
  const it = at(res, i);
  // Icon column: a group's colour, else the favicon, else nothing (the slot keeps its width).
  // Outside the signature check because favicons can arrive after the row is drawn.
  row.dot.hidden = setIcon(row.fav, faviconFor(it));
  const sig = `${it.key}|${it.ord}|${res.q.raw}|${it.title}|${it.gt}|${it.col}|${it.aud}`;
  row.el.classList.toggle('sel', i === sel);
  if (row.sig === sig) return;
  row.sig = sig;
  const pos = res.q.groups.length ? positionsFor(it, res.q) : [];
  const mark = KIND_MARK[it.k];
  // "past": bookmarks, history, closed. Dimmed, grayscale favicon until selected.
  row.el.className = 'row k-' + it.k + (mark ? ' past' : '') + (i === sel ? ' sel' : '');
  row.dot.classList.toggle('dot', it.k === 'group');
  if (it.k === 'group') row.dot.style.setProperty('--c', GROUP_COLORS[it.gc ?? ''] ?? '#888');
  highlight(row.t, it.title, 0, pos);
  // the url as shown is already in the haystack (prepare), between uOff and the group
  const disp = it.uOff >= 0 ? it.hay.slice(it.uOff, it.gOff >= 0 ? it.gOff - SEP.length : undefined) : '';
  if (it.uOff >= 0) highlight(row.u, disp, it.uOff, pos);
  else row.u.textContent = it.k === 'group' ? 'tab group' : '';
  if (it.gt && it.k !== 'group') {
    row.chip.hidden = false;
    highlight(row.chip, it.gt, it.gOff, pos);
    row.chip.style.setProperty('--c', GROUP_COLORS[it.gc ?? ''] ?? '#888');
  } else row.chip.hidden = true;
  const b = badgeFor(it);
  row.badge.hidden = !b;
  row.badge.textContent = b;
  row.eq.hidden = !(it.k === 'tab' && it.aud);
  row.win.hidden = !(it.k === 'tab' && it.win !== s.context.win);
  row.kind.hidden = !mark;
  row.kind.textContent = mark?.[0] ?? '';
  row.kind.title = mark?.[1] ?? '';
}

const list = new VList($scroller, $inner, renderRow, (i, e) => {
  sel = i;
  void activate(e.shiftKey);
});
list.onHover = (i) => {
  if (i !== sel) {
    sel = i;
    redraw();
  }
};

/** Draw rows and say in the footer what ↵ does for the selected one. */
function redraw(): void {
  list.draw();
  const label = res && sel < count() ? actionLabel(at(res, sel)) : '';
  if ($act.textContent !== label) $act.textContent = label;
}

function count(): number {
  return res ? res.ids.length : 0;
}

function selectedKey(): string | undefined {
  return res && sel < count() ? at(res, sel).key : undefined;
}

/** Re-run the current query. Keeps the selection on the same item when data changes under it. */
function refresh(keepSelection: boolean): void {
  const key = keepSelection ? selectedKey() : undefined;
  res = s.search($q.value);
  sel = 0;
  if (key && res) {
    const n = Math.min(count(), 500);
    for (let i = 0; i < n; i++) if (at(res, i).key === key) sel = i;
  }
  layout();
  list.setCount(count());
  list.reveal(sel);
  redraw();
}

function move(d: number): void {
  const n = count();
  if (!n) return;
  if (!showList()) {
    expanded = true;
    layout();
  } else {
    sel = (sel + d + n) % n;
  }
  list.reveal(sel);
  redraw();
}

// ------------------------------------------------------------------ actions

async function activate(newWindow: boolean): Promise<void> {
  if (!res || sel >= count()) return;
  const it = at(res, sel);
  // A group opens its most recent tab; credit that page.
  const url = it.k === 'group' ? (s.get(keyOf({ k: 'tab', id: it.mru ?? -1 } as RawItem))?.url ?? '') : it.url;
  await api.act({ k: it.k, id: it.id, win: it.win, mru: it.mru, col: it.col, url }, s.context.win, newWindow);
  dismiss();
}

// ------------------------------------------------------------------ input

let raf = 0;
$q.addEventListener('input', () => {
  // Coalesce bursts (key repeat, paste) into one search per frame.
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    refresh(false);
    liveHistory();
  });
});

$q.addEventListener('keydown', (e) => {
  if (toggleKey?.(e)) {
    e.preventDefault();
    dismiss();
    return;
  }
  const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
  const k = e.key;
  if (k === 'ArrowDown' || (ctrl && (k === 'n' || k === 'j')) || (k === 'Tab' && !e.shiftKey)) move(1);
  else if (k === 'ArrowUp' || (ctrl && (k === 'p' || k === 'k')) || (k === 'Tab' && e.shiftKey)) move(-1);
  else if (k === 'PageDown') move(list.pageSize);
  else if (k === 'PageUp') move(-list.pageSize);
  else if (k === 'Enter') {
    if (raf) {
      // A search is pending for the last keystroke; run it so Enter acts on what is shown next.
      cancelAnimationFrame(raf);
      raf = 0;
      refresh(false);
    }
    void activate(e.shiftKey);
  }
  else if (k === 'Escape') dismiss();
  else return;
  e.preventDefault();
});

// ------------------------------------------------------------------ data

function applySnapshot(sn: Snapshot | undefined, full: boolean): void {
  if (!sn || sn.v < snapV || (!full && fullLoaded)) return;
  snapV = sn.v;
  if (full) fullLoaded = true;
  setBase(sn.items, sn.win);
}

/** `win` is a fallback; the popup's own window wins once known. */
let ownWin = -1;
function setBase(items: RawItem[], win: number): void {
  s.setBase(items, ownWin >= 0 ? ownWin : win);
  refresh(true);
}

/** No snapshot yet (fresh install, worker not run): build one here. */
async function liveFallback(): Promise<void> {
  const [tabs, gs, cl, w] = await Promise.all([
    chrome.tabs.query({}),
    hasGroups() ? chrome.tabGroups.query({}).catch(() => []) : Promise.resolve([]),
    recentlyClosed(),
    chrome.windows.getCurrent().catch(() => undefined),
  ]);
  if (fullLoaded) return;
  fullLoaded = true;
  setBase(buildRaw(tabs, new Map<number, GroupInfo>(gs.map((g) => [g.id, g])), cl, {}, Date.now()), w?.id ?? -1);
}

const idle = (fn: () => void) =>
  'requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 300 }) : setTimeout(fn, 50);

async function loadExtras(): Promise<void> {
  s.setBookmarks(await api.bookmarks());
  refresh(true);
  idle(async () => {
    s.addHistory(await api.recent());
    refresh(true);
  });
}

let histTimer: ReturnType<typeof setTimeout> | undefined;
function liveHistory(): void {
  clearTimeout(histTimer);
  const q = parseQuery($q.value);
  if (q.plain.length < 2 || (q.scope !== '' && q.scope !== 'h')) return;
  histTimer = setTimeout(async () => {
    const hist = await api.history(q.plain);
    if (!hist.length || parseQuery($q.value).plain !== q.plain) return;
    s.addHistory(hist);
    refresh(true);
  }, HISTORY_LIVE_DEBOUNCE);
}

// Firefox doesn't run extension shortcuts while focus is inside the
// extension's own frame or popup, so pressing the shortcut again would just
// type a character. Recognize it here and close, like a toggle. (Elsewhere the
// browser takes the key first, so this never fires.)
let toggleKey = shortcutMatcher(DEFAULT_SHORTCUT());

async function shortcutHint(): Promise<void> {
  const sc = await api.shortcut();
  toggleKey = shortcutMatcher(sc || DEFAULT_SHORTCUT());
  // The shortcut itself, linking to fasttab's settings (shortcut, "work everywhere").
  $shortcut.hidden = false;
  $shortcut.textContent = prettyShortcut(sc);
  $shortcut.title = 'fasttab settings';
  $shortcut.onclick = (e) => {
    e.preventDefault();
    api.openSettings();
    dismiss();
  };
}

function afterBase(): void {
  if (!__CHROME__) idle(() => void api.favicons().then(setFavicons));
  idle(() => void loadExtras());
  idle(() => void shortcutHint());
}

if (overlayApi) {
  // One round trip: the background already holds the live index.
  void overlayApi.init().then((r) => {
    if (!r) return;
    fullLoaded = true;
    setBase(r.items, r.win);
    afterBase();
  });
} else {
  // Stage 1 + 2 run in parallel; the small key usually resolves first.
  void chrome.storage.session.get(SNAP_TOP).then((r) => applySnapshot(r[SNAP_TOP] as Snapshot | undefined, false));
  void chrome.storage.session.get(SNAP_FULL).then((r) => {
    const sn = r[SNAP_FULL] as Snapshot | undefined;
    if (sn) applySnapshot(sn, true);
    else void liveFallback();
    afterBase();
  });
  void send({ t: 'hello' });
  // The snapshot's focused window is almost always the popup's; confirm it.
  void chrome.windows.getCurrent().then((w) => {
    // The popup-window fallback lives in its own window; act on the browser window behind it.
    if (w.id === undefined || w.type === 'popup') return;
    ownWin = w.id;
    s.setWin(w.id);
    if (fullLoaded) refresh(true);
  });
  // Live updates while the popup is open (tab closed elsewhere, title changes).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    // A snapshot redraws anyway; favicons are picked up by that draw.
    if (changes[FAVICONS]) favicons = (changes[FAVICONS].newValue as FaviconMap | undefined) ?? {};
    if (changes[SNAP_FULL]) applySnapshot(changes[SNAP_FULL].newValue as Snapshot | undefined, true);
    else if (changes[FAVICONS]) setFavicons(favicons);
  });
}

// The overlay frame gets focus from the page after it loads; hand it to the input.
window.addEventListener('focus', () => $q.focus());
window.focus();
$q.focus();
