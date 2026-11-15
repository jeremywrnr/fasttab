// Opt-in (Firefox): catches the fasttab shortcut inside pages that swallow it
// (Google Docs, Figma, code editors), which otherwise stops the browser from
// ever seeing it. Registered at document_start in every frame, so this
// capture listener runs before the page's own handlers.

import { DEFAULT_SHORTCUT, shortcutMatcher } from '../shared/shortcut.ts';
import { SHORTCUT_KEY } from '../shared/capture.ts';

const w = window as Window & { __fasttabHotkey?: true };
if (!w.__fasttabHotkey) {
  w.__fasttabHotkey = true;
  let match = shortcutMatcher(DEFAULT_SHORTCUT());
  const load = (sc: unknown) => {
    const m = typeof sc === 'string' && sc ? shortcutMatcher(sc) : null;
    if (m) match = m;
  };
  chrome.storage.local.get(SHORTCUT_KEY).then((r) => load(r[SHORTCUT_KEY]), () => undefined);
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch[SHORTCUT_KEY]) load(ch[SHORTCUT_KEY].newValue);
  });
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || !match?.(e)) return;
      // Swallowing it here also stops the browser's own command from firing,
      // so the switcher opens exactly once.
      e.preventDefault();
      e.stopImmediatePropagation();
      chrome.runtime.sendMessage({ t: 'hotkey' }).catch(() => undefined);
    },
    true,
  );
}
