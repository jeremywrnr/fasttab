// Setup / options page. Opened once on install in Firefox (#setup) to offer
// "⌃K everywhere", and from about:addons → Preferences any time.
// Chrome's commands.getAll() can report an empty shortcut even when the
// suggested key is active, so the shortcut card always offers the settings link.

import { captureEnabled, disableCapture, requestCapture } from '../shared/capture.ts';
import { currentShortcut, openShortcutSettings } from '../shared/actions.ts';
import { prettyShortcut } from '../shared/shortcut.ts';

declare const __FIREFOX__: boolean;
declare const __SAFARI__: boolean;

const DEFAULT = prettyShortcut('');
const $ = (id: string) => document.getElementById(id)!;

function showKey(sc: string): void {
  for (const el of document.querySelectorAll('#key, #key2, .k')) el.textContent = prettyShortcut(sc);
}

$('why').textContent = `The default is ${DEFAULT}. If another extension already holds it or you'd like a different key, change it in the browser's shortcut settings:`;
const steps = __SAFARI__
  ? ['Safari has no setting for extension shortcuts, so fasttab always uses ⌃K there. You can also click the fasttab button in the toolbar.']
  : __FIREFOX__
  ? ['Click “Change shortcut” (about:addons → ⚙ → Manage Extension Shortcuts).', 'Find fasttab and click its shortcut box.', 'Press the keys you want.']
  : ['Click “Change shortcut”.', 'Find fasttab → “Open fasttab” and click the pencil.', 'Press the keys you want (⌘P works, and wins over Print).'];
for (const s of steps) {
  const li = document.createElement('li');
  li.textContent = s;
  $('list').appendChild(li);
}

async function check(): Promise<void> {
  const sc = await currentShortcut();
  $('current').textContent = sc ? prettyShortcut(sc) : 'none';
  $('ok').hidden = !sc;
  showKey(sc);
  if (__FIREFOX__) {
    const on = await captureEnabled();
    $('capture-off').hidden = on;
    $('capture-on').hidden = !on;
  }
}

$('open').addEventListener('click', () => openShortcutSettings());
if (__SAFARI__) $('open').hidden = true;

if (__FIREFOX__) {
  $('capture-card').hidden = false;
  $('capture-on-btn').addEventListener('click', () => {
    // No await before this: Firefox only shows the prompt straight from the click.
    void requestCapture().then(check);
  });
  $('capture-off-link').addEventListener('click', (e) => {
    e.preventDefault();
    void disableCapture().then(check);
  });
}

// Re-check when the user comes back from the settings tab or answers the prompt.
document.addEventListener('visibilitychange', () => void check());
window.addEventListener('focus', () => void check());
setInterval(() => void check(), 2000);
void check();
