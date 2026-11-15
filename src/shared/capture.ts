// "Capture the shortcut on every page" (Firefox, opt-in). Needs the optional
// <all_urls> host permission; registers src/hotkey as a dynamic content script.

export const SHORTCUT_KEY = 'ft_shortcut';
export const CAPTURE_KEY = 'ft_capture';
const SCRIPT_ID = 'ft-hotkey';
const ALL = { origins: ['<all_urls>'] };

export const DEFAULT_SHORTCUT = () => (navigator.platform.startsWith('Mac') ? 'MacCtrl+K' : 'Alt+K');

export async function captureEnabled(): Promise<boolean> {
  const [st, perm] = await Promise.all([chrome.storage.local.get(CAPTURE_KEY), chrome.permissions.contains(ALL)]);
  return !!st[CAPTURE_KEY] && perm;
}

async function register(): Promise<void> {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] }).catch(() => []);
  if (existing.length) return;
  const base = {
    id: SCRIPT_ID,
    matches: ['<all_urls>'],
    js: ['hotkey.js'],
    runAt: 'document_start' as const,
    allFrames: true,
    persistAcrossSessions: true,
  };
  // about:blank / srcdoc editor frames (Google Docs types into one) need the fallback match.
  await chrome.scripting
    .registerContentScripts([{ ...base, matchOriginAsFallback: true }])
    .catch(() => chrome.scripting.registerContentScripts([base]));
}

/** Call from a user gesture (permission prompt). Returns whether it is on. */
export async function enableCapture(): Promise<boolean> {
  const ok = await chrome.permissions.request(ALL).catch(() => false);
  if (!ok) return false;
  await chrome.storage.local.set({ [CAPTURE_KEY]: true });
  await register();
  // Pages already open won't get the registered script until reload.
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map((t) =>
      t.id === undefined
        ? undefined
        : chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['hotkey.js'] }).catch(() => undefined),
    ),
  );
  return true;
}

export async function disableCapture(): Promise<void> {
  await chrome.storage.local.set({ [CAPTURE_KEY]: false });
  await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => undefined);
  // Listeners already in open pages stay until reload; they only message the background, which ignores them now.
}

/** On startup: keep the registration in step with the setting and permission. */
export async function syncCapture(): Promise<void> {
  if (await captureEnabled()) await register();
  else await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => undefined);
}
