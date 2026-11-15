// "⌃K everywhere" (Firefox): pages like Google Docs swallow the shortcut
// before the browser sees it. With the optional <all_urls> host permission
// granted, src/hotkey runs at document_start in every frame and catches it
// first. The permission *is* the setting: granted = on, removed = off.

export const SHORTCUT_KEY = 'ft_shortcut';
const SCRIPT_ID = 'ft-hotkey';
export const ALL_SITES = { origins: ['<all_urls>'] };

export function captureEnabled(): Promise<boolean> {
  return chrome.permissions.contains(ALL_SITES).catch(() => false);
}

/** Must be called synchronously from a click (Firefox drops the prompt otherwise). */
export function requestCapture(): Promise<boolean> {
  return chrome.permissions.request(ALL_SITES).catch(() => false);
}

export async function disableCapture(): Promise<void> {
  await chrome.permissions.remove(ALL_SITES).catch(() => false);
  await syncCapture();
}

async function register(): Promise<boolean> {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] }).catch(() => []);
  if (existing.length) return false;
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
  return true;
}

/** Keep the content script registration in step with the permission (background). */
export async function syncCapture(): Promise<void> {
  if (!(await captureEnabled())) {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => undefined);
    return;
  }
  if (!(await register())) return;
  // Newly on: pages already open won't get the registered script until reload, so add it now.
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map((t) =>
      t.id === undefined
        ? undefined
        : chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['hotkey.js'] }).catch(() => undefined),
    ),
  );
}
