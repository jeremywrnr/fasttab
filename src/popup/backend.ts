// What the switcher UI needs from the browser, in one interface with two
// implementations: the toolbar popup calls the APIs directly; the in-page
// overlay frame has no tabs/storage API in Firefox, so it asks the background
// (which answers only for the overlay's one-time token).

import type { RawItem } from '../core/types.ts';
import {
  currentShortcut,
  loadBookmarks,
  loadRecentHistory,
  openShortcutSettings,
  performAction,
  searchHistory,
  type ActItem,
} from '../shared/actions.ts';
import { captureEnabled, requestCapture } from '../shared/capture.ts';
import type { Msg } from '../shared/messages.ts';

export interface Backend {
  bookmarks(): Promise<RawItem[]>;
  recent(): Promise<RawItem[]>;
  history(text: string): Promise<RawItem[]>;
  shortcut(): Promise<string>;
  capture(): Promise<boolean>;
  /** Turn on "shortcut everywhere"; call straight from the click. Resolves to whether it is on now. */
  fixCapture(): Promise<boolean>;
  openSettings(): void;
  act(it: ActItem, win: number, mod: boolean, shift: boolean): Promise<void>;
  closeTab(id: number): Promise<void>;
}

export const send = (m: Msg): Promise<unknown> => chrome.runtime.sendMessage(m).catch(() => undefined);

export const direct: Backend = {
  bookmarks: () => loadBookmarks(),
  recent: loadRecentHistory,
  history: searchHistory,
  shortcut: currentShortcut,
  capture: captureEnabled,
  fixCapture: requestCapture,
  openSettings: openShortcutSettings,
  async act(it, win, mod, shift) {
    const url = await performAction(it, win, mod, shift).catch(() => undefined);
    if (url) void send({ t: 'visit', url });
  },
  async closeTab(id) {
    await chrome.tabs.remove(id).catch(() => undefined);
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
    capture: () => ov({ t: 'ov:capture' }, true),
    // A framed page can't ask for permissions; the setup page can.
    fixCapture: () => ov({ t: 'ov:setup' }, false).then(() => false),
    openSettings: () => void ov({ t: 'ov:settings' }, true),
    act: (it, win, mod, shift) => ov({ t: 'ov:act', it, win, mod, shift }, true).then(() => undefined),
    closeTab: (id) => ov({ t: 'ov:closeTab', id }, true).then(() => undefined),
  };
  return api;
}
