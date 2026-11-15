// Browser-side effects shared by the toolbar popup (calls directly) and the
// background (runs them for the in-page overlay, whose frame has no tabs API).

import { FREC_KEY, type FrecMap } from '../core/frecency.ts';
import { COMMAND } from './shortcut.ts';
import type { RawItem } from '../core/types.ts';
import { flattenBookmarks, hasGroups, historyToRaw } from './raw.ts';

export type ActItem = Pick<RawItem, 'k' | 'id' | 'win' | 'mru' | 'col' | 'url'>;

export const HISTORY_RECENT_DAYS = 30;
export const HISTORY_RECENT_MAX = 1500;

/** What ↵ does for each kind; shown in the switcher's footer. */
export function actionLabel(it: Pick<RawItem, 'k' | 'n' | 'url'>): string {
  switch (it.k) {
    case 'tab':
      return 'Switch to tab';
    case 'group':
      return 'Open group';
    case 'closed':
      return it.url ? 'Reopen tab' : 'Reopen window';
    case 'bookmark':
      return 'Open bookmark';
    case 'history':
      return 'Open page';
  }
}

/**
 * ↵ switches to / opens the item; ⇧↵ (`newWindow`) puts it in a new window
 * instead (a tab or group moves there). `ctxWin` is the window the switcher
 * was opened in. Returns the url to credit with a frecency visit, if any.
 */
export async function performAction(it: ActItem, ctxWin: number, newWindow: boolean): Promise<string | undefined> {
  switch (it.k) {
    case 'tab': {
      if (newWindow) {
        await chrome.windows.create({ tabId: it.id as number, focused: true });
        return it.url;
      }
      const p = chrome.tabs.update(it.id as number, { active: true });
      if (it.win !== ctxWin && it.win !== undefined) await chrome.windows.update(it.win, { focused: true });
      await p;
      return it.url;
    }
    case 'group': {
      if (!hasGroups() || it.mru === undefined || it.win === undefined) return;
      const gid = it.id as number;
      if (newWindow) {
        // A new window starts with one tab; move the group in, then drop that tab.
        const w = await chrome.windows.create({ focused: true });
        if (w?.id === undefined) return;
        await chrome.tabGroups.move(gid, { windowId: w.id, index: -1 });
        const blank = w.tabs?.[0]?.id;
        if (blank !== undefined) await chrome.tabs.remove(blank).catch(() => undefined);
      } else if (it.win !== ctxWin) {
        await chrome.windows.update(it.win, { focused: true });
      }
      if (it.col) await chrome.tabGroups.update(gid, { collapsed: false });
      await chrome.tabs.update(it.mru, { active: true });
      return it.url || undefined;
    }
    case 'closed':
      if (newWindow && it.url) {
        await chrome.windows.create({ url: it.url, focused: true });
        return it.url;
      }
      await chrome.sessions?.restore(it.id as string).catch(() => undefined);
      return;
    case 'bookmark':
    case 'history':
      if (newWindow) await chrome.windows.create({ url: it.url, focused: true });
      else await chrome.tabs.create({ url: it.url });
      return it.url;
  }
}

/** `frec` defaults to the stored map (the background passes its live copy). */
export async function loadBookmarks(frec?: FrecMap): Promise<RawItem[]> {
  if (!chrome.bookmarks) return []; // Safari
  const [tree, map] = await Promise.all([
    chrome.bookmarks.getTree().catch(() => []),
    frec ?? chrome.storage.local.get(FREC_KEY).then((st) => (st[FREC_KEY] as FrecMap | undefined) ?? {}, () => ({})),
  ]);
  return flattenBookmarks(tree, map, Date.now());
}

export async function loadRecentHistory(): Promise<RawItem[]> {
  const now = Date.now();
  if (!chrome.history) return []; // Safari
  const hist = await chrome.history
    .search({ text: '', startTime: now - HISTORY_RECENT_DAYS * 864e5, maxResults: HISTORY_RECENT_MAX })
    .catch(() => []);
  return historyToRaw(hist, now);
}

export async function searchHistory(text: string): Promise<RawItem[]> {
  if (!chrome.history) return [];
  const hist = await chrome.history.search({ text, startTime: 0, maxResults: 100 }).catch(() => []);
  return historyToRaw(hist, Date.now());
}

export async function currentShortcut(): Promise<string> {
  const cmds = await chrome.commands.getAll().catch(() => []);
  return cmds.find((c) => c.name === COMMAND)?.shortcut ?? '';
}

export function openShortcutSettings(): void {
  const open = (chrome.commands as { openShortcutSettings?: () => Promise<void> }).openShortcutSettings;
  if (open) void open();
  else void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
}

/** Recently closed tabs/windows; Safari has no sessions API. */
export function recentlyClosed(): Promise<chrome.sessions.Session[]> {
  if (!chrome.sessions) return Promise.resolve([]);
  return chrome.sessions.getRecentlyClosed({ maxResults: 25 }).catch(() => []);
}
