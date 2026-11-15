// Popup: paints from the storage.session snapshot in stages, searches
// synchronously on every input event, and renders a virtualized list.
//
//   stage 1  ft_top   (~30 MRU tabs)         → first paint
//   stage 2  ft_full  (all tabs/groups/closed) → full search
//   stage 3  idle     bookmarks + recent history
//   stage 4  typing   live history.search (debounced) for older pages

import { parseQuery } from '../core/query.ts';
import { at, positionsFor, Searcher, type Result } from '../core/search.ts';
import type { FrecMap } from '../core/frecency.ts';
import {
  currentShortcut,
  loadBookmarks,
  loadRecentHistory,
  openShortcutSettings,
  performAction,
  searchHistory,
  type ActItem,
} from '../shared/actions.ts';
import type { Item, RawItem } from '../core/types.ts';
import { prettyUrl } from '../core/text.ts';
import type { Msg } from '../shared/messages.ts';
import {
  closedToRaw,
  groupsToRaw,
  hasGroups,
  SNAP_FULL,
  SNAP_TOP,
  tabToRaw,
  type GroupInfo,
  type Snapshot,
} from '../shared/raw.ts';
import { VList, type Row } from './vlist.ts';
import { shortcutMatcher } from '../shared/shortcut.ts';

declare const __FIREFOX__: boolean;

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
const $status = document.getElementById('status')!;
const $shortcut = document.getElementById('shortcut') as HTMLAnchorElement;
const $hint = document.getElementById('hint')!;
const $results = document.getElementById('results')!;
const $panel = document.getElementById('panel')!;

// Overlay mode: loaded in a frame the background injected into a page, with a
// one-time token in the hash. Otherwise this is the toolbar popup (or the
// popup-window fallback).
const TOKEN = location.hash.startsWith('#o=') ? location.hash.slice(3) : '';
const OVERLAY = !!TOKEN;
if (OVERLAY) document.documentElement.classList.add('overlay');
const MAX_ROWS = 8;
const ROW_H = 44;

const s = new Searcher();
let res: Result | null = null;
let sel = 0;
let snapV = -1;
let fullLoaded = false;
let popupWin = -1;
let snapWin = -1;
let firstPaint = 0;

const send = (m: Msg) => chrome.runtime.sendMessage(m).catch(() => undefined);

// Overlay requests go through the background: an extension page framed in a
// web page gets no tabs/storage API in Firefox. The background answers only
// for a known token, so a page that frames popup.html itself gets nothing.
type OvReq = Msg extends infer M ? (M extends { token: string } ? Omit<M, 'token'> : never) : never;
const ov = <T>(m: OvReq): Promise<T | undefined> =>
  chrome.runtime.sendMessage({ ...m, token: TOKEN }).then(
    (r) => (r ?? undefined) as T | undefined,
    () => undefined,
  );

function dismiss(): void {
  if (OVERLAY) parent.postMessage({ ft: 'close' }, '*');
  else window.close();
}

/** Minimal first: only the input until there is a query or ↓ is pressed. */
let expanded = false;
const showList = () => expanded || $q.value.trim().length > 0;

let lastH = 0;
function layout(): void {
  const show = showList();
  const n = count();
  $results.hidden = !show;
  $inner.parentElement!.style.height = n ? Math.min(n, MAX_ROWS) * ROW_H + 'px' : '';
  $empty.hidden = n > 0 || !fullLoaded;
  // Collapsed: hint at what Enter will do.
  $hint.textContent = !show && res && n ? '↵ ' + at(res, 0).title : '';
  if (OVERLAY) {
    const h = Math.ceil($panel.getBoundingClientRect().height) + 6 + 28; // panel margins
    if (h !== lastH) {
      lastH = h;
      parent.postMessage({ ft: 'size', h }, '*');
    }
  }
}

// ------------------------------------------------------------------ rendering

const faviconBase = __FIREFOX__ ? '' : chrome.runtime.getURL('/_favicon/');
function faviconFor(it: Item): string {
  if (__FIREFOX__) return it.fav ?? '';
  if (!it.url) return '';
  return `${faviconBase}?pageUrl=${encodeURIComponent(it.url)}&size=32`;
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
  switch (it.k) {
    case 'tab': {
      const b: string[] = [];
      if (it.pin) b.push('pinned');
      if (it.aud) b.push('♪');
      if (it.disc) b.push('asleep');
      if (it.win !== s.context.win) b.push('other window');
      return b.join(' · ');
    }
    case 'group':
      return `${it.n} tab${it.n === 1 ? '' : 's'}${it.col ? ' · collapsed' : ''}`;
    case 'closed':
      return 'closed';
    case 'bookmark':
      return 'bookmark';
    case 'history':
      return 'history';
  }
}

function renderRow(row: Row, i: number): void {
  if (!res) return;
  const it = at(res, i);
  const sig = `${it.key}|${it.ord}|${res.q.raw}|${it.title}|${it.gt}|${it.col}`;
  row.el.classList.toggle('sel', i === sel);
  if (row.sig === sig) return;
  row.sig = sig;
  const pos = res.q.groups.length ? positionsFor(it, res.q) : [];
  // icon
  if (it.k === 'group') {
    row.fav.hidden = true;
    row.dot.hidden = false;
    row.dot.style.setProperty('--c', GROUP_COLORS[it.gc ?? ''] ?? '#888');
  } else {
    row.dot.hidden = true;
    const src = faviconFor(it);
    row.fav.hidden = !src;
    if (src && row.fav.getAttribute('src') !== src) row.fav.src = src;
  }
  highlight(row.t, it.title, 0, pos);
  const disp = it.k === 'group' ? '' : prettyUrl(it.url);
  if (it.uOff >= 0) highlight(row.u, disp, it.uOff, pos);
  else row.u.textContent = it.k === 'group' ? 'Tab group' : disp;
  if (it.gt && it.k !== 'group') {
    row.chip.hidden = false;
    highlight(row.chip, it.gt, it.gOff, pos);
    row.chip.style.setProperty('--c', GROUP_COLORS[it.gc ?? ''] ?? '#888');
  } else row.chip.hidden = true;
  const b = badgeFor(it);
  row.badge.hidden = !b;
  row.badge.textContent = b;
}

const list = new VList($scroller, $inner, renderRow, (i, e) => {
  sel = i;
  activate(e.metaKey || e.ctrlKey, e.shiftKey);
});
list.onHover = (i) => {
  if (i !== sel) {
    sel = i;
    list.draw();
  }
};

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
  list.draw();
  if (!firstPaint && count()) {
    // performance.now() counts from the popup document's navigation start
    firstPaint = performance.now();
    console.debug(`[fasttab] first rows painted in ${firstPaint.toFixed(1)}ms`);
  }
  status();
}

function status(): void {
  if (!res) return;
  const n = count();
  const lbl = res.q.groups.length || res.q.scope ? `${n} match${n === 1 ? '' : 'es'}` : `${n} tabs`;
  $status.textContent = fullLoaded ? `${lbl} · ${firstPaint.toFixed(0)}ms` : 'loading…';
}

function move(d: number): void {
  const n = count();
  if (!n) return;
  if (!showList()) {
    expanded = true;
    layout();
    list.reveal(sel);
    list.draw();
    return;
  }
  sel = (sel + d + n) % n;
  list.reveal(sel);
  list.draw();
}

// ------------------------------------------------------------------ actions

async function activate(mod: boolean, shift: boolean): Promise<void> {
  if (!res || sel >= count()) return;
  const it = at(res, sel);
  const act: ActItem = {
    k: it.k,
    id: it.id,
    win: it.win,
    mru: it.mru,
    col: it.col,
    url: it.k === 'group' ? (s.get('t:' + it.mru)?.url ?? '') : it.url,
  };
  if (OVERLAY) {
    await ov({ t: 'ov:act', it: act, win: s.context.win, mod, shift });
  } else {
    const url = await performAction(act, s.context.win, mod, shift).catch(() => undefined);
    if (url) void send({ t: 'visit', url });
  }
  dismiss();
}

async function closeSelected(): Promise<void> {
  if (!res || sel >= count()) return;
  const it = at(res, sel);
  if (it.k !== 'tab') return;
  s.remove(it.key);
  refresh(false);
  sel = Math.min(sel, Math.max(0, count() - 1));
  list.draw();
  if (OVERLAY) await ov({ t: 'ov:closeTab', id: it.id as number });
  else await chrome.tabs.remove(it.id as number).catch(() => undefined);
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
    void activate(e.metaKey || e.ctrlKey, e.shiftKey);
  } else if (k === 'Backspace' && (e.metaKey || e.ctrlKey)) void closeSelected();
  else if (k === 'Escape') dismiss();
  else return;
  e.preventDefault();
});

// ------------------------------------------------------------------ data

function applySnapshot(sn: Snapshot | undefined, full: boolean): void {
  if (!sn || sn.v < snapV || (!full && fullLoaded)) return;
  snapV = sn.v;
  snapWin = sn.win;
  if (full) fullLoaded = true;
  setBase(sn.items);
}

let baseItems: RawItem[] = [];
function setBase(items: RawItem[]): void {
  baseItems = items;
  const win = popupWin >= 0 ? popupWin : snapWin;
  const cur = items.find((r) => r.k === 'tab' && r.act && r.win === win);
  s.setCtx({ win, cur: cur ? 't:' + cur.id : '' });
  s.setBase(items);
  refresh(true);
}

/** No snapshot yet (fresh install, worker not run): build one here. */
async function liveFallback(): Promise<void> {
  const [tabs, gs, cl] = await Promise.all([
    chrome.tabs.query({}),
    hasGroups() ? chrome.tabGroups.query({}) : Promise.resolve([]),
    chrome.sessions.getRecentlyClosed({ maxResults: 25 }).catch(() => []),
  ]);
  if (fullLoaded) return;
  const groups = new Map<number, GroupInfo>(gs.map((g) => [g.id, g]));
  const now = Date.now();
  const tabItems = tabs.filter((t) => t.id !== undefined).map((t) => tabToRaw(t, groups, {}, now, undefined, __FIREFOX__));
  fullLoaded = true;
  setBase(tabItems.concat(groupsToRaw(groups, tabItems), closedToRaw(cl)));
}

const idle = (fn: () => void) =>
  'requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 300 }) : setTimeout(fn, 50);

async function loadExtras(): Promise<void> {
  const bookmarks = OVERLAY
    ? await ov<RawItem[]>({ t: 'ov:bookmarks' })
    : await chrome.storage.local
        .get('ft_frec')
        .catch(() => ({}) as Record<string, unknown>)
        .then((st) => loadBookmarks((st.ft_frec as FrecMap | undefined) ?? {}));
  s.setBookmarks(bookmarks ?? []);
  refresh(true);
  idle(async () => {
    const hist = OVERLAY ? await ov<RawItem[]>({ t: 'ov:recent' }) : await loadRecentHistory();
    s.addHistory(hist ?? []);
    refresh(true);
  });
}

let histTimer: ReturnType<typeof setTimeout> | undefined;
function liveHistory(): void {
  clearTimeout(histTimer);
  const q = parseQuery($q.value);
  if (q.plain.length < 2 || (q.scope !== '' && q.scope !== 'h')) return;
  histTimer = setTimeout(async () => {
    const hist = OVERLAY ? await ov<RawItem[]>({ t: 'ov:history', text: q.plain }) : await searchHistory(q.plain);
    if (!hist?.length || parseQuery($q.value).plain !== q.plain) return;
    s.addHistory(hist);
    refresh(true);
  }, HISTORY_LIVE_DEBOUNCE);
}

// Firefox does not run extension shortcuts while focus is inside the
// extension's own frame or popup, so pressing the shortcut again would just
// type a character. Recognize it here and close, like a toggle.
let toggleKey: ((e: KeyboardEvent) => boolean) | null = null;

async function shortcutHint(): Promise<void> {
  const sc = OVERLAY ? await ov<string>({ t: 'ov:shortcut' }) : await currentShortcut();
  if (__FIREFOX__) toggleKey = shortcutMatcher(sc || 'Alt+K');
  $shortcut.hidden = false;
  $shortcut.textContent = sc || 'shortcut';
  $shortcut.title = 'Change the fasttab shortcut';
  $shortcut.onclick = (e) => {
    e.preventDefault();
    if (OVERLAY) void ov({ t: 'ov:settings' });
    else openShortcutSettings();
    dismiss();
  };
}

function afterBase(): void {
  idle(() => void loadExtras());
  idle(() => void shortcutHint());
}

if (OVERLAY) {
  // One round trip: the background already holds the live index.
  void ov<{ items: RawItem[]; win: number }>({ t: 'ov:init' }).then((r) => {
    if (!r) return;
    popupWin = snapWin = r.win;
    fullLoaded = true;
    setBase(r.items);
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
    if (w.id === undefined || w.id === popupWin || w.type === 'popup') return;
    popupWin = w.id;
    if (baseItems.length && popupWin !== s.context.win) setBase(baseItems);
  });
  // Live updates while the popup is open (tab closed elsewhere, title changes).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes[SNAP_FULL]) return;
    applySnapshot(changes[SNAP_FULL].newValue as Snapshot | undefined, true);
  });
}

// The overlay frame gets focus from the page after it loads; hand it to the input.
window.addEventListener('focus', () => $q.focus());
window.focus();
$q.focus();
