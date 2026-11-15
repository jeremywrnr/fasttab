export interface KeyLike {
  key: string;
  code: string;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

/** Parse "Alt+K", "Ctrl+Shift+P", "Command+P", "MacCtrl+K" or "⌥⇧K" into a matcher. */
export function shortcutMatcher(sc: string): ((e: KeyLike) => boolean) | null {
  const parts = sc.includes('+') ? sc.split('+') : [...sc];
  const key = parts.pop()?.toUpperCase();
  if (!key || key.length !== 1) return null;
  const has = (...names: string[]) => parts.some((p) => names.includes(p));
  const alt = has('Alt', '⌥');
  const shift = has('Shift', '⇧');
  const meta = has('Command', '⌘');
  const ctrl = has('Ctrl', 'MacCtrl', '⌃');
  const code = /[A-Z]/.test(key) ? 'Key' + key : /[0-9]/.test(key) ? 'Digit' + key : '';
  return (e) =>
    (code ? e.code === code : e.key.toUpperCase() === key) &&
    e.altKey === alt &&
    e.shiftKey === shift &&
    e.metaKey === meta &&
    e.ctrlKey === ctrl;
}

/** The one command fasttab registers (manifest "commands"). */
export const COMMAND = 'open-switcher';

/** Mirrors manifest suggested_key: ⌃K on macOS, Alt+K elsewhere. */
export const DEFAULT_SHORTCUT = (): string => (navigator.platform.startsWith('Mac') ? 'MacCtrl+K' : 'Alt+K');

/** Display form: "MacCtrl+K" → "⌃K" on macOS; empty → the default. */
export function prettyShortcut(sc: string): string {
  const s = sc || DEFAULT_SHORTCUT();
  if (!navigator.platform.startsWith('Mac')) return s;
  return s
    .replace(/(MacCtrl|Ctrl)\+/g, '⌃')
    .replace(/Alt\+/g, '⌥')
    .replace(/Shift\+/g, '⇧')
    .replace(/Command\+/g, '⌘');
}
