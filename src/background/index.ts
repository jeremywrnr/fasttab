// Background: keeps a live index of tabs, groups and recently closed tabs,
// updated incrementally from browser events, and writes a compact snapshot to
// storage.session so the popup can paint without waiting on this worker.
// Also records frecency (tab activations with a dwell, plus popup picks).

import { bump, FREC_KEY, prune, type FrecMap } from '../core/frecency.ts';
import { hostOf } from '../core/text.ts';
import { COMMAND } from '../shared/shortcut.ts';
import type { RawItem } from '../core/types.ts';
import {
  buildRaw,
  FAVICONS,
  hasGroups,
  type FaviconMap,
  SNAP_FULL,
  SNAP_TOP,
  topOf,
  type GroupInfo,
  type Snapshot,
} from '../shared/raw.ts';
import type { Msg } from '../shared/messages.ts';
import { captureEnabled, SHORTCUT_KEY, syncCapture } from '../shared/capture.ts';
import { currentShortcut, recentlyClosed, loadBookmarks, loadRecentHistory, performAction, searchHistory } from '../shared/actions.ts';

declare const __FIREFOX__: boolean;
declare const __CHROME__: boolean;

const DWELL_MS = 1000;
const SNAP_DEBOUNCE = 100;
const SNAP_MAX_WAIT = 400;

const tabs = new Map<number, chrome.tabs.Tab>();
const groups = new Map<number, GroupInfo>();
const lastAct = new Map<number, number>();
let closed: chrome.sessions.Session[] = [];
let frec: FrecMap = {};
let focusedWin = -1;
let seq = 0;

// ------------------------------------------------------------------ init

let ready: Promise<void> | null = null;

function init(): Promise<void> {
  return (ready ??= (async () => {
    const [all, gs, cl, store, win, saved] = await Promise.all([
      chrome.tabs.query({}),
      hasGroups() ? chrome.tabGroups.query({}).catch(() => []) : Promise.resolve([]),
      recentlyClosed(),
      chrome.storage.local.get(FREC_KEY),
      chrome.windows.getLastFocused().catch(() => undefined),
      chrome.storage.session.get(FAVICONS).catch(() => ({}) as Record<string, unknown>),
    ]);
    // Favicons from before the worker slept (Firefox/Safari; empty on Chrome).
    for (const [h, f] of Object.entries((saved[FAVICONS] as FaviconMap | undefined) ?? {})) favicons.set(h, f);
    for (const t of all) {
      if (t.id !== undefined) tabs.set(t.id, t);
      noteFavicon(t);
    }
    for (const g of gs) groups.set(g.id, g);
    closed = cl;
    frec = (store[FREC_KEY] as FrecMap | undefined) ?? {};
    if (win?.id !== undefined) focusedWin = win.id;
    // Debounced like any change: the event that woke the worker schedules one too,
    // and a popup that is waiting flushes it with 'hello'.
    schedule();
  })());
}

// ------------------------------------------------------------------ snapshot

let timer: ReturnType<typeof setTimeout> | undefined;
let firstDirty = 0;

function schedule(): void {
  const now = Date.now();
  if (!timer) firstDirty = now;
  clearTimeout(timer);
  const wait = Math.min(SNAP_DEBOUNCE, Math.max(0, firstDirty + SNAP_MAX_WAIT - now));
  timer = setTimeout(() => {
    timer = undefined;
    void writeSnapshot();
  }, wait);
}

function buildItems(now: number): RawItem[] {
  return buildRaw(tabs.values(), groups, closed, frec, now, lastAct);
}

async function writeSnapshot(): Promise<void> {
  clearTimeout(timer);
  timer = undefined;
  const now = Date.now();
  const items = buildItems(now);
  const v = ++seq;
  const full: Snapshot = { v, win: focusedWin, items };
  const top: Snapshot = { v, win: focusedWin, items: topOf(items, focusedWin) };
  const write: Record<string, unknown> = { [SNAP_TOP]: top, [SNAP_FULL]: full };
  if (favDirty) {
    write[FAVICONS] = Object.fromEntries(favicons);
    favDirty = false;
  }
  await chrome.storage.session.set(write);
}

// ------------------------------------------------------------------ favicons
// Chrome draws any page's favicon itself (_favicon). Firefox and Safari only
// hand us each tab's favIconUrl, often a large data: url, so keep one per site
// and reuse it for that site's bookmarks and history too.

const favicons = new Map<string, string>();
let favDirty = false;
// Bounded: the whole map is rewritten when one icon changes, so keep it small.
// Real favicons are a few KB; skip anything huge rather than carry it around.
const MAX_FAVICONS = 600;
const MAX_FAVICON_BYTES = 24_000;

/** Record a tab's favicon for its site. Returns whether the map changed. */
function noteFavicon(t: chrome.tabs.Tab): boolean {
  if (__CHROME__) return false; // Chrome draws any page's favicon itself
  const host = hostOf(t.url ?? '');
  const f = t.favIconUrl;
  if (!host || !f || f.length > MAX_FAVICON_BYTES || favicons.get(host) === f) return false;
  favicons.delete(host); // re-insert as newest
  favicons.set(host, f);
  if (favicons.size > MAX_FAVICONS) favicons.delete(favicons.keys().next().value!);
  favDirty = true;
  return true;
}

/** Run a state change once the index is loaded, then schedule a snapshot. */
function on<A extends unknown[]>(fn: (...a: A) => void | boolean) {
  return (...a: A) => {
    void init().then(() => {
      if (fn(...a) !== false) schedule();
    });
  };
}

// ------------------------------------------------------------------ frecency

let frecTimer: ReturnType<typeof setTimeout> | undefined;
function saveFrec(): void {
  clearTimeout(frecTimer);
  frecTimer = setTimeout(() => {
    frec = prune(frec, Date.now());
    void chrome.storage.local.set({ [FREC_KEY]: frec });
  }, 2000);
}

let dwell: ReturnType<typeof setTimeout> | undefined;
function recordActivation(tabId: number): void {
  clearTimeout(dwell);
  dwell = setTimeout(() => {
    const t = tabs.get(tabId);
    if (t?.active && t.url) {
      bump(frec, t.url, Date.now(), 1);
      saveFrec();
      schedule();
    }
  }, DWELL_MS);
}

// ------------------------------------------------------------------ events
// Listeners must be registered synchronously at top level so the worker is
// woken for them after it has been suspended.

const RELEVANT = ['title', 'url', 'pinned', 'audible', 'discarded', 'groupId', 'mutedInfo'] as const;

chrome.tabs.onCreated.addListener(
  on((t: chrome.tabs.Tab) => {
    if (t.id !== undefined) tabs.set(t.id, t);
    noteFavicon(t);
  }),
);

chrome.tabs.onUpdated.addListener(
  on((id: number, change: chrome.tabs.OnUpdatedInfo, t: chrome.tabs.Tab) => {
    tabs.set(id, t);
    // A new favicon only needs the (separate) favicon map written.
    return noteFavicon(t) || RELEVANT.some((k) => k in change);
  }),
);

chrome.tabs.onRemoved.addListener(
  on((id: number) => {
    tabs.delete(id);
    lastAct.delete(id);
  }),
);

chrome.tabs.onActivated.addListener(
  on(({ tabId, windowId }: chrome.tabs.OnActivatedInfo) => {
    for (const t of tabs.values()) if (t.windowId === windowId) t.active = t.id === tabId;
    lastAct.set(tabId, Date.now());
    recordActivation(tabId);
  }),
);

const refreshTab = on((id: number) => {
  void chrome.tabs.get(id).then(
    (t) => {
      tabs.set(id, t);
      schedule();
    },
    () => tabs.delete(id),
  );
  return false;
});
chrome.tabs.onAttached.addListener(refreshTab);
chrome.tabs.onMoved.addListener(refreshTab);
chrome.tabs.onReplaced?.addListener(
  on((added: number, removed: number) => {
    tabs.delete(removed);
    refreshTab(added);
  }),
);

chrome.windows.onFocusChanged.addListener(
  on((win: number) => {
    if (win === chrome.windows.WINDOW_ID_NONE) return false;
    focusedWin = win;
    // the active tab in the newly focused window was just "visited"
    for (const t of tabs.values()) if (t.windowId === win && t.active && t.id !== undefined) lastAct.set(t.id, Date.now());
  }),
);

if (hasGroups()) {
  const setGroup = on((g: chrome.tabGroups.TabGroup) => {
    groups.set(g.id, g);
  });
  chrome.tabGroups.onCreated.addListener(setGroup);
  chrome.tabGroups.onUpdated.addListener(setGroup);
  chrome.tabGroups.onMoved?.addListener(setGroup);
  chrome.tabGroups.onRemoved.addListener(
    on((g: chrome.tabGroups.TabGroup) => {
      groups.delete(g.id);
    }),
  );
}

chrome.sessions?.onChanged.addListener(
  on(() => {
    void recentlyClosed().then((cl) => {
      closed = cl;
      schedule();
    });
    return false;
  }),
);

chrome.runtime.onMessage.addListener((msg: Msg, sender, reply) => {
  if (msg.t.startsWith('ov:') && !overlayTokens.has((msg as { token: string }).token)) {
    reply(null); // unknown frame: no data, no actions
    return false;
  }
  void init().then(async () => {
    switch (msg.t) {
      case 'hotkey':
        // From the opt-in page listener: only honoured while the setting is on.
        if (__FIREFOX__ && (await captureEnabled())) openSwitcher(sender.tab);
        reply(true);
        return;
      case 'hello':
        // A popup opened: make sure the snapshot it reads is current.
        if (timer) await writeSnapshot();
        reply({ v: seq });
        return;
      case 'visit':
        visit(msg.url);
        reply(true);
        return;
      case 'ov:init': {
        const win = sender.tab?.windowId ?? focusedWin;
        reply({ items: buildItems(Date.now()), win });
        return;
      }
      case 'ov:bookmarks':
        reply(await loadBookmarks(frec));
        return;
      case 'ov:recent':
        reply(await loadRecentHistory());
        return;
      case 'ov:history':
        reply(await searchHistory(msg.text));
        return;
      case 'ov:favicons':
        reply(Object.fromEntries(favicons));
        return;
      case 'ov:shortcut':
        reply(await currentShortcut());
        return;
      case 'ov:settings':
        void chrome.runtime.openOptionsPage();
        reply(true);
        return;
      case 'ov:act': {
        const url = await performAction(msg.it, msg.win, msg.alt).catch(() => undefined);
        if (url) visit(url);
        reply(true);
        return;
      }
    }
  });
  return true; // async reply
});

function visit(url: string): void {
  bump(frec, url, Date.now(), 2);
  saveFrec();
  schedule();
}

chrome.runtime.onStartup.addListener(() => void init());
chrome.runtime.onInstalled.addListener(({ reason }) => {
  void init();
  // Firefox: offer "⌃K everywhere" once, right away, so sites like Google Docs don't eat the shortcut.
  if (__FIREFOX__ && reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html#setup') });
});
void init();

// ------------------------------------------------------------------ overlay
// ⌃K (Alt+K off macOS) injects a centered frame (Alfred-style) into the current page. Pages an
// extension may not script (browser UI pages, new tab, add-on stores) get the
// toolbar popup instead. Each overlay carries a one-time token so a web page
// that frames popup.html on its own cannot drive it.

const overlayTokens = new Set<string>();

const RESTRICTED_HOSTS = new Set([
  'chromewebstore.google.com',
  'chrome.google.com',
  'addons.mozilla.org',
  'accounts.firefox.com',
  'support.mozilla.org',
]);

function injectable(url: string | undefined): boolean {
  if (!url || !/^https?:/.test(url)) return false;
  try {
    return !RESTRICTED_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Runs in the page (must be self-contained). Toggles the overlay. */
function injectOverlay(src: string, origin: string): string {
  const ID = '__fasttab_overlay__';
  const old = document.getElementById(ID);
  if (old) {
    // An event, not an expando: each injection may run in a fresh script world.
    old.dispatchEvent(new Event('fasttab-close'));
    return 'closed';
  }
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  // Transparent and full-viewport: the switcher positions its panel itself and
  // treats clicks outside it as "close". Browsers paint a frame opaque when its
  // color-scheme differs from its document's, and a site's <meta color-scheme>
  // changes what "normal" means here (GitHub: the page vanished behind white).
  // So both sides name the scheme explicitly, from the same media query.
  const scheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const frame = document.createElement('iframe');
  frame.src = src;
  // Invisible (but focusable) until the switcher has painted, so the frame's
  // blank first document never flashes over the page.
  frame.style.cssText = `position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;color-scheme:${scheme};opacity:0;`;
  const show = () => (frame.style.opacity = '1');
  setTimeout(show, 400); // in case the ready message never comes
  root.appendChild(frame);
  const prev = document.activeElement as HTMLElement | null;
  const onMsg = (e: MessageEvent) => {
    if (e.origin !== origin || e.source !== frame.contentWindow) return;
    const ft = (e.data as { ft?: string })?.ft;
    if (ft === 'ready') show();
    else if (ft === 'close') close();
  };
  const onVis = () => {
    if (document.hidden) close();
  };
  const close = () => {
    host.remove();
    window.removeEventListener('message', onMsg, true);
    document.removeEventListener('visibilitychange', onVis);
    prev?.focus?.();
  };
  host.addEventListener('fasttab-close', close);
  window.addEventListener('message', onMsg, true);
  document.addEventListener('visibilitychange', onVis);
  document.documentElement.appendChild(host);
  frame.addEventListener('load', () => frame.focus());
  return 'opened';
}

async function popupWindowFallback(): Promise<void> {
  const w = await chrome.windows.getLastFocused().catch(() => undefined);
  const width = 720;
  const height = 520;
  const left = w?.left !== undefined && w.width ? Math.round(w.left + (w.width - width) / 2) : undefined;
  const top = w?.top !== undefined && w.height ? Math.round(w.top + w.height * 0.15) : undefined;
  await chrome.windows.create({ url: chrome.runtime.getURL('popup.html'), type: 'popup', width, height, left, top });
}

chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === COMMAND) openSwitcher(tab);
});

function openSwitcher(tab: chrome.tabs.Tab | undefined): void {
  if (!tab?.id || !injectable(tab.url)) {
    // Must stay synchronous: openPopup needs the shortcut's user action.
    chrome.action.openPopup().catch(() => void popupWindowFallback());
    return;
  }
  const token = crypto.randomUUID();
  overlayTokens.add(token);
  setTimeout(() => overlayTokens.delete(token), 30 * 60_000);
  const src = chrome.runtime.getURL('popup.html') + '#o=' + token;
  const origin = new URL(chrome.runtime.getURL('')).origin;
  chrome.scripting
    .executeScript({ target: { tabId: tab.id }, func: injectOverlay, args: [src, origin] })
    .catch(() => {
      overlayTokens.delete(token);
      return popupWindowFallback();
    });
}

// The page-level hotkey listener (opt-in, see shared/capture.ts) needs to know
// the current shortcut; content scripts can't read commands themselves.
async function syncShortcut(): Promise<void> {
  const sc = await currentShortcut();
  await chrome.storage.local.set({ [SHORTCUT_KEY]: sc });
}
(chrome.commands as { onChanged?: chrome.events.Event<() => void> }).onChanged?.addListener(() => void syncShortcut());
void syncShortcut();
if (__FIREFOX__) {
  void syncCapture();
  // Granted from the setup page, options or the popup's "Fix" link; revoked there or in about:addons.
  chrome.permissions.onAdded.addListener(() => void syncCapture());
  chrome.permissions.onRemoved.addListener(() => void syncCapture());
}
