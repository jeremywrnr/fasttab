import { describe, expect, it } from 'vitest';
import { shortcutMatcher, type KeyLike } from '../src/shared/shortcut.ts';

const ev = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: '˚', code, altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, ...mods,
});

describe('shortcutMatcher', () => {
  it('matches by physical key so macOS Option characters still match', () => {
    const m = shortcutMatcher('Alt+K')!;
    expect(m(ev('KeyK', { altKey: true }))).toBe(true);
    expect(m(ev('KeyK'))).toBe(false);
    expect(m(ev('KeyK', { altKey: true, shiftKey: true }))).toBe(false);
    expect(m(ev('KeyJ', { altKey: true }))).toBe(false);
  });
  it('understands Chrome symbol form and Firefox names', () => {
    expect(shortcutMatcher('⌥⇧P')!(ev('KeyP', { altKey: true, shiftKey: true }))).toBe(true);
    expect(shortcutMatcher('Command+P')!(ev('KeyP', { metaKey: true }))).toBe(true);
    expect(shortcutMatcher('MacCtrl+Shift+1')!(ev('Digit1', { ctrlKey: true, shiftKey: true }))).toBe(true);
  });
  it('rejects junk', () => {
    expect(shortcutMatcher('')).toBeNull();
    expect(shortcutMatcher('Alt+Space')).toBeNull();
  });
});
