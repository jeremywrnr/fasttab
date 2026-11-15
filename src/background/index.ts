// Background: keeps a live index of tabs, groups and recently closed tabs,
// updated incrementally from browser events, and writes a compact snapshot to
// storage.session so the popup can paint without waiting on this worker.
// Also records frecency (tab activations with a dwell, plus popup picks).

import { bump, prune, type FrecMap } from '../core/frecency.ts';
import type { RawItem } from '../core/types.ts';
import {
  closedToRaw,
  groupsToRaw,
  hasGroups,
  SNAP_FULL,
  SNAP_TOP,
  tabToRaw,
  topOf,
  type GroupInfo,
  type Snapshot,
} from '../shared/raw.ts';
import type { Msg } from '../shared/messages.ts';

declare const __FIREFOX__: boolean;

const FREC_KEY = 'ft_frec';
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
    const [all, gs, cl, store, win] = await Promise.all([
      chrome.tabs.query({}),
      hasGroups() ? chrome.tabGroups.query({}).catch(() => []) : Promise.resolve([]),
      chrome.sessions.getRecentlyClosed({ maxResults: 25 }).catch(() => []),
      chrome.storage.local.get(FREC_KEY),
      chrome.windows.getLastFocused().catch(() => undefined),
    ]);
    for (const t of all) if (t.id !== undefined) tabs.set(t.id, t);
    for (const g of gs) groups.set(g.id, g);
    closed = cl;
    frec = (store[FREC_KEY] as FrecMap | undefined) ?? {};
    if (win?.id !== undefined) focusedWin = win.id;
    await writeSnapshot();
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
  const tabItems: RawItem[] = [];
  for (const t of tabs.values()) {
    if (t.id === undefined) continue;
    tabItems.push(tabToRaw(t, groups, frec, now, lastAct.get(t.id), __FIREFOX__));
  }
  return tabItems.concat(groupsToRaw(groups, tabItems), closedToRaw(closed));
}

async function writeSnapshot(): Promise<void> {
  clearTimeout(timer);
  timer = undefined;
  const now = Date.now();
  const items = buildItems(now);
  const v = ++seq;
  const full: Snapshot = { v, at: now, win: focusedWin, items };
  const top: Snapshot = { v, at: now, win: focusedWin, items: topOf(items, focusedWin) };
  await chrome.storage.session.set({ [SNAP_TOP]: top, [SNAP_FULL]: full });
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

const RELEVANT = ['title', 'url', 'pinned', 'audible', 'discarded', 'groupId', 'favIconUrl', 'mutedInfo'] as const;

chrome.tabs.onCreated.addListener(
  on((t: chrome.tabs.Tab) => {
    if (t.id !== undefined) tabs.set(t.id, t);
  }),
);

chrome.tabs.onUpdated.addListener(
  on((id: number, change: chrome.tabs.OnUpdatedInfo, t: chrome.tabs.Tab) => {
    tabs.set(id, t);
    if (!__FIREFOX__ && 'favIconUrl' in change && Object.keys(change).length <= 2) return false; // Chrome draws favicons itself
    return RELEVANT.some((k) => k in change);
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

chrome.sessions.onChanged.addListener(
  on(() => {
    void chrome.sessions.getRecentlyClosed({ maxResults: 25 }).then((cl) => {
      closed = cl;
      schedule();
    });
    return false;
  }),
);

chrome.runtime.onMessage.addListener((msg: Msg, _sender, reply) => {
  void init().then(async () => {
    switch (msg.t) {
      case 'hello':
        // A popup opened: make sure the snapshot it reads is current.
        if (timer) await writeSnapshot();
        reply({ v: seq });
        return;
      case 'visit':
        bump(frec, msg.url, Date.now(), 2);
        saveFrec();
        schedule();
        reply(true);
        return;
      case 'focusGroup':
        await focusGroup(msg.gid, msg.tabId, msg.win, msg.solo);
        reply(true);
        return;
      case 'restore':
        await chrome.sessions.restore(msg.sessionId).catch(() => undefined);
        reply(true);
        return;
    }
  });
  return true; // async reply
});

chrome.runtime.onStartup.addListener(() => void init());
chrome.runtime.onInstalled.addListener(() => void init());
void init();

// ------------------------------------------------------------------ actions

async function focusGroup(gid: number, tabId: number, win: number, solo: boolean): Promise<void> {
  if (!hasGroups()) return;
  if (solo) {
    const others = await chrome.tabGroups.query({ windowId: win });
    await Promise.all(
      others.filter((g) => g.id !== gid && !g.collapsed).map((g) => chrome.tabGroups.update(g.id, { collapsed: true })),
    );
  }
  await chrome.tabGroups.update(gid, { collapsed: false }).catch(() => undefined);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(win, { focused: true });
}
