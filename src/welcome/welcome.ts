// Options page: shortcut help. Chrome's commands.getAll() can report an empty
// shortcut even when the suggested key is active, so always offer the
// settings link rather than trusting the reported value.

declare const __FIREFOX__: boolean;

const $current = document.getElementById('current')!;
const $ok = document.getElementById('ok')!;
const $steps = document.getElementById('steps')!;
const $why = document.getElementById('why')!;
const $list = document.getElementById('list')!;

$why.textContent = 'The default is ⌥K. If another extension already holds it, or you want a different key (⌘P works in Chrome and wins over Print), set it in the browser shortcut settings:';
const steps = __FIREFOX__
  ? ['Click the button below (or open about:addons → ⚙ → Manage Extension Shortcuts).', 'Find fasttab and click the shortcut box.', 'Press the keys you want.']
  : ['Click the button below.', 'Find fasttab → “Activate the extension” and click the pencil.', 'Press the keys you want.'];
for (const s of steps) {
  const li = document.createElement('li');
  li.textContent = s;
  $list.appendChild(li);
}

async function check(): Promise<void> {
  const cmds = await chrome.commands.getAll();
  const sc = cmds.find((c) => c.name === 'open-switcher')?.shortcut ?? '';
  $current.textContent = sc || '⌥K (default)';
  $ok.hidden = !sc;
}

document.getElementById('open')!.addEventListener('click', () => {
  const open = (chrome.commands as { openShortcutSettings?: () => Promise<void> }).openShortcutSettings;
  if (open) void open();
  else void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// Re-check when the user comes back from the settings tab.
document.addEventListener('visibilitychange', () => void check());
window.addEventListener('focus', () => void check());
setInterval(() => void check(), 2000);
void check();
