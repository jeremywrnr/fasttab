// Browser-side effects shared by the toolbar popup (calls directly) and the
// background (runs them for the in-page overlay, whose frame has no tabs API).

import type { FrecMap } from '../core/frecency.ts';
import type { RawItem } from '../core/types.ts';
import { flattenBookmarks, hasGroups, historyToRaw } from './raw.ts';

export type ActItem = Pick<RawItem, 'k' | 'id' | 'win' | 'mru' | 'col' | 'url'>;

export const HISTORY_RECENT_DAYS = 30;
export const HISTORY_RECENT_MAX = 1500;

/**
 * Switch to / open the item. `ctxWin` is the window the switcher was opened
 * in. Returns the url to credit with a frecency visit, if any.
 */
export async function performAction(it: ActItem, ctxWin: number, mod: boolean, shift: boolean): Promise<string | undefined> {
  switch (it.k) {
    case 'tab': {
      const p = chrome.tabs.update(it.id as number, { active: true });
      if (it.win !== ctxWin && it.win !== undefined) await chrome.windows.update(it.win, { focused: true });
      await p;
      return it.url;
    }
    case 'group': {
      if (!hasGroups() || it.mru === undefined || it.win === undefined) return;
      if (shift) {
        const others = await chrome.tabGroups.query({ windowId: it.win });
        await Promise.all(
          others.filter((g) => g.id !== it.id && !g.collapsed).map((g) => chrome.tabGroups.update(g.id, { collapsed: true })),
        );
      }
      if (it.col) await chrome.tabGroups.update(it.id as number, { collapsed: false });
      if (it.win !== ctxWin) await chrome.windows.update(it.win, { focused: true });
      await chrome.tabs.update(it.mru, { active: true });
      return it.url || undefined;
    }
    case 'closed':
      await chrome.sessions?.restore(it.id as string).catch(() => undefined);
      return;
    case 'bookmark':
    case 'history':
      if (mod) await chrome.tabs.update({ url: it.url });
      else await chrome.tabs.create({ url: it.url });
      return it.url;
  }
}

export async function loadBookmarks(frec: FrecMap): Promise<RawItem[]> {
  if (!chrome.bookmarks) return []; // Safari
  const tree = await chrome.bookmarks.getTree().catch(() => []);
  return flattenBookmarks(tree, frec, Date.now());
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
  return cmds.find((c) => c.name === 'open-switcher')?.shortcut ?? '';
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
