// Browser-side effects shared by the toolbar popup (calls directly) and the
// background (runs them for the in-page overlay, whose frame has no tabs API).

import { FREC_KEY, type FrecMap } from '../core/frecency.ts';
import { COMMAND } from './shortcut.ts';
import type { RawItem } from '../core/types.ts';
import { flattenBookmarks, hasGroups, historyToRaw } from './raw.ts';

export type ActItem = Pick<RawItem, 'k' | 'id' | 'win' | 'mru' | 'col' | 'url'>;

export const HISTORY_RECENT_DAYS = 30;
export const HISTORY_RECENT_MAX = 1500;

/** Footer labels for ↵ and ⇧↵: open tabs jump/clone, groups jump/window, the rest open/window. */
export function actionLabels(it: Pick<RawItem, 'k' | 'url'>): [string, string] {
  // A closed window has no single page to put in a new window: ⇧↵ restores it too.
  if (it.k === 'closed' && !it.url) return ['Open', 'Open'];
  return [it.k === 'tab' || it.k === 'group' ? 'Jump' : 'Open', it.k === 'tab' ? 'Clone' : 'Window'];
}

/**
 * ↵ jumps to / opens the item. ⇧↵ (`alt`) clones an open tab next to itself,
 * moves a group to a new window, and opens anything else in a new window.
 * `ctxWin` is the window the switcher was opened in. Returns the url to
 * credit with a frecency visit, if any.
 */
export async function performAction(it: ActItem, ctxWin: number, alt: boolean): Promise<string | undefined> {
  switch (it.k) {
    case 'tab': {
      // Focusing the window and switching/cloning the tab are independent: run them together.
      const focus = it.win !== ctxWin && it.win !== undefined ? chrome.windows.update(it.win, { focused: true }) : undefined;
      if (alt) {
        const [, copy] = await Promise.all([focus, chrome.tabs.duplicate(it.id as number)]);
        // Both browsers select the duplicate already; make sure where they don't.
        if (copy?.id !== undefined && !copy.active) await chrome.tabs.update(copy.id, { active: true });
      } else {
        await Promise.all([focus, chrome.tabs.update(it.id as number, { active: true })]);
      }
      return it.url;
    }
    case 'group': {
      if (!hasGroups() || it.mru === undefined || it.win === undefined) return;
      const gid = it.id as number;
      if (alt) {
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
      if (!alt || !it.url) {
        await chrome.sessions?.restore(it.id as string).catch(() => undefined);
        return;
      }
    // ⇧↵ on a closed tab: open its page in a new window, like a bookmark
    // falls through
    case 'bookmark':
    case 'history':
      if (alt) await chrome.windows.create({ url: it.url, focused: true });
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
