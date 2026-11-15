// Convert browser API objects to serializable RawItems. Shared by the
// background (snapshot builder) and the popup (cold-start fallback, bookmarks,
// history).

import { lookup, type FrecMap } from '../core/frecency.ts';
import type { RawItem } from '../core/types.ts';

export const SNAP_TOP = 'ft_top';
export const SNAP_FULL = 'ft_full';
/** host → favicon url (Firefox/Safari), kept out of the snapshot and written only on change */
export const FAVICONS = 'ft_fav';
export const TOP_N = 30;
const UNNAMED_GROUP = 'Unnamed group';

export interface Snapshot {
  v: number;
  /** last focused normal window */
  win: number;
  items: RawItem[];
}

export type GroupInfo = { title?: string; color?: string; collapsed?: boolean; windowId?: number; id: number };

export const hasGroups = (): boolean => typeof chrome !== 'undefined' && !!chrome.tabGroups;

export function tabToRaw(
  t: chrome.tabs.Tab,
  groups: Map<number, GroupInfo>,
  frec: FrecMap,
  now: number,
  la: number | undefined,
): RawItem {
  const url = t.url || t.pendingUrl || '';
  const r: RawItem = { k: 'tab', id: t.id!, title: t.title || url, url, win: t.windowId };
  const gid = t.groupId ?? -1;
  if (gid >= 0) {
    const g = groups.get(gid);
    r.gid = gid;
    r.gt = g?.title || UNNAMED_GROUP;
    if (g?.color) r.gc = g.color;
  }
  if (t.active) r.act = 1;
  if (t.pinned) r.pin = 1;
  if (t.audible) r.aud = 1;
  if (t.discarded) r.disc = 1;
  const last = la ?? (t as { lastAccessed?: number }).lastAccessed;
  if (last) r.la = Math.round(last);
  const fr = lookup(frec, url, now);
  if (fr > 0.05) r.fr = Math.round(fr * 100) / 100;
  return r;
}

export function groupsToRaw(groups: Map<number, GroupInfo>, tabs: RawItem[]): RawItem[] {
  const agg = new Map<number, { n: number; mru: number; la: number }>();
  for (const t of tabs) {
    if (t.gid === undefined) continue;
    const a = agg.get(t.gid) ?? { n: 0, mru: t.id as number, la: 0 };
    a.n++;
    if ((t.la ?? 0) >= a.la) {
      a.la = t.la ?? 0;
      a.mru = t.id as number;
    }
    agg.set(t.gid, a);
  }
  const out: RawItem[] = [];
  for (const g of groups.values()) {
    const a = agg.get(g.id);
    if (!a) continue;
    const r: RawItem = {
      k: 'group',
      id: g.id,
      title: g.title || UNNAMED_GROUP,
      url: '',
      win: g.windowId,
      n: a.n,
      mru: a.mru,
      la: a.la,
    };
    if (g.color) r.gc = g.color;
    if (g.collapsed) r.col = 1;
    out.push(r);
  }
  return out;
}

const ms = (t: number | undefined) => (!t ? 0 : t < 1e12 ? t * 1000 : t); // Chrome: seconds, Firefox: ms

export function closedToRaw(sessions: chrome.sessions.Session[]): RawItem[] {
  const out: RawItem[] = [];
  for (const s of sessions) {
    if (s.tab?.sessionId) {
      const url = s.tab.url || '';
      out.push({ k: 'closed', id: s.tab.sessionId, title: s.tab.title || url, url, la: ms(s.lastModified) });
    } else if (s.window?.sessionId) {
      const tabs = s.window.tabs ?? [];
      const names = tabs
        .slice(0, 3)
        .map((t) => t.title)
        .filter(Boolean)
        .join(', ');
      out.push({
        k: 'closed',
        id: s.window.sessionId,
        title: `Window (${tabs.length} tabs)${names ? ': ' + names : ''}`,
        url: '',
        la: ms(s.lastModified),
        n: tabs.length,
      });
    }
  }
  return out;
}

export function flattenBookmarks(nodes: chrome.bookmarks.BookmarkTreeNode[], frec: FrecMap, now: number): RawItem[] {
  const out: RawItem[] = [];
  const walk = (ns: chrome.bookmarks.BookmarkTreeNode[], folder: string) => {
    for (const n of ns) {
      if (n.url) {
        if (n.url.startsWith('javascript:')) continue;
        const r: RawItem = { k: 'bookmark', id: n.id, title: n.title || n.url, url: n.url, la: n.dateAdded };
        if (folder) r.gt = folder;
        const fr = lookup(frec, n.url, now);
        if (fr > 0.05) r.fr = fr;
        out.push(r);
      } else if (n.children) {
        // Skip the root folder names ("Bookmarks Bar", "Other Bookmarks"); keep user folders.
        walk(n.children, n.parentId && n.parentId !== '0' && n.parentId !== 'root________' ? n.title : folder);
      }
    }
  };
  walk(nodes, '');
  return out;
}

export function historyToRaw(items: chrome.history.HistoryItem[], now: number): RawItem[] {
  const out: RawItem[] = [];
  for (const h of items) {
    if (!h.url) continue;
    // Chrome's visitCount is lifetime; decay it by last visit as a cheap frecency.
    const age = Math.max(0, now - (h.lastVisitTime ?? 0));
    const fr = (h.visitCount ?? 1) * Math.pow(2, -age / (14 * 864e5));
    out.push({ k: 'history', id: h.url, title: h.title || h.url, url: h.url, la: h.lastVisitTime, fr: Math.min(fr, 50) });
  }
  return out;
}

/** MRU order with the active tab of the focused window last (alt-tab). */
export function topOf(items: RawItem[], win: number, n = TOP_N): RawItem[] {
  return items
    .filter((r) => r.k === 'tab')
    .sort((a, b) => {
      const ca = a.act && a.win === win ? 1 : 0;
      const cb = b.act && b.win === win ? 1 : 0;
      return ca - cb || (b.la ?? 0) - (a.la ?? 0);
    })
    .slice(0, n);
}

/** Every snapshot item: tabs, then their groups, then recently closed. */
export function buildRaw(
  tabs: Iterable<chrome.tabs.Tab>,
  groups: Map<number, GroupInfo>,
  closed: chrome.sessions.Session[],
  frec: FrecMap,
  now: number,
  lastAct?: Map<number, number>,
): RawItem[] {
  const tabItems: RawItem[] = [];
  for (const t of tabs) if (t.id !== undefined) tabItems.push(tabToRaw(t, groups, frec, now, lastAct?.get(t.id)));
  return tabItems.concat(groupsToRaw(groups, tabItems), closedToRaw(closed));
}
