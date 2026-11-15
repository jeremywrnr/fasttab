import { describe, expect, it } from 'vitest';
import { hueOf } from '../src/core/text.ts';
import { flattenBookmarks } from '../src/shared/raw.ts';

type Node = chrome.bookmarks.BookmarkTreeNode;
const bm = (id: string, title: string): Node => ({ id, title, url: `https://example.com/${id}` }) as Node;
const folder = (id: string, parentId: string, title: string, children: Node[]): Node => ({ id, parentId, title, children }) as Node;

describe('bookmark folder colors', () => {
  it('hueOf is stable and spreads different strings', () => {
    expect(hueOf('Recipes')).toBe(hueOf('Recipes'));
    expect(hueOf('Recipes')).toBeGreaterThanOrEqual(0);
    expect(hueOf('Recipes')).toBeLessThan(360);
    expect(new Set(['jobs', 'oakland', 'health', 'Recipes', 'Travel'].map(hueOf)).size).toBe(5);
  });

  it('shows the nearest folder but colors by the whole path', () => {
    const tree = [
      folder('0', '', '', [
        folder('1', '0', 'Bookmarks Bar', [
          bm('a', 'top-level'),
          folder('f1', '1', 'Bread', [bm('b', 'loaf')]),
          folder('f2', '1', 'Recipes', [folder('f3', 'f2', 'Bread', [bm('c', 'sourdough')])]),
        ]),
      ]),
    ];
    const byId = Object.fromEntries(flattenBookmarks(tree, {}, 0).map((r) => [r.id, r]));
    expect(byId.a.gt).toBeUndefined(); // only the browser's root folder above it
    expect(byId.b.gt).toBe('Bread');
    expect(byId.c.gt).toBe('Bread');
    expect(byId.b.gh).toBe(hueOf('Bread'));
    expect(byId.c.gh).toBe(hueOf('Recipes/Bread'));
    expect(byId.b.gh).not.toBe(byId.c.gh);
  });
});
