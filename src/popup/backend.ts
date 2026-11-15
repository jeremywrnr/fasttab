// What the switcher UI needs from the browser, in one interface with two
// implementations: the toolbar popup calls the APIs directly; the in-page
// overlay frame has no tabs/storage API in Firefox, so it asks the background
// (which answers only for the overlay's one-time token).

import type { RawItem } from '../core/types.ts';
import { currentShortcut, loadBookmarks, loadRecentHistory, performAction, searchHistory, type ActItem } from '../shared/actions.ts';
import type { Msg } from '../shared/messages.ts';
import { FAVICONS, type FaviconMap } from '../shared/raw.ts';

export interface Backend {
  bookmarks(): Promise<RawItem[]>;
  recent(): Promise<RawItem[]>;
  history(text: string): Promise<RawItem[]>;
  shortcut(): Promise<string>;
  /** host → favicon (Firefox/Safari; empty on Chrome, which draws its own) */
  favicons(): Promise<FaviconMap>;
  /** fasttab's own settings page */
  openSettings(): void;
  /** ↵ (or ⇧↵ with `alt`) on an item */
  act(it: ActItem, win: number, alt: boolean): Promise<void>;
}

export const send = (m: Msg): Promise<unknown> => chrome.runtime.sendMessage(m).catch(() => undefined);

export const direct: Backend = {
  bookmarks: () => loadBookmarks(),
  recent: loadRecentHistory,
  history: searchHistory,
  shortcut: currentShortcut,
  favicons: () => chrome.storage.session.get(FAVICONS).then((r) => (r[FAVICONS] as FaviconMap | undefined) ?? {}, () => ({})),
  openSettings: () => void chrome.runtime.openOptionsPage(),
  async act(it, win, alt) {
    const url = await performAction(it, win, alt).catch(() => undefined);
    if (url) void send({ t: 'visit', url });
  },
};

type OvReq = Msg extends infer M ? (M extends { token: string } ? Omit<M, 'token'> : never) : never;

export function viaBackground(token: string) {
  const ov = <T>(m: OvReq, fallback: T): Promise<T> =>
    chrome.runtime.sendMessage({ ...m, token }).then(
      (r) => (r ?? fallback) as T,
      () => fallback,
    );
  const api: Backend & { init(): Promise<{ items: RawItem[]; win: number } | null> } = {
    init: () => ov({ t: 'ov:init' }, null),
    bookmarks: () => ov({ t: 'ov:bookmarks' }, []),
    recent: () => ov({ t: 'ov:recent' }, []),
    history: (text) => ov({ t: 'ov:history', text }, []),
    shortcut: () => ov({ t: 'ov:shortcut' }, ''),
    favicons: () => ov<FaviconMap>({ t: 'ov:favicons' }, {}),
    openSettings: () => void ov({ t: 'ov:settings' }, true),
    act: (it, win, alt) => ov({ t: 'ov:act', it, win, alt }, true).then(() => undefined),
  };
  return api;
}
