import { describe, expect, it } from 'vitest';
import { hostOf, rootDomain } from '../src/core/text.ts';

describe('rootDomain', () => {
  it.each([
    ['app.plan.io', 'plan.io'],
    ['docs.google.com', 'google.com'],
    ['news.bbc.co.uk', 'bbc.co.uk'],
    ['stellakaval.github.io', 'stellakaval.github.io'],
    ['jeremy.substack.com', 'jeremy.substack.com'],
    ['github.com', 'github.com'],
    ['127.0.0.1', '127.0.0.1'],
    ['localhost', 'localhost'],
  ])('%s → %s', (host, want) => expect(rootDomain(host)).toBe(want));

  it('hostOf drops scheme, www and port', () => {
    expect(hostOf('https://www.example.com:8080/x?y')).toBe('example.com');
    expect(hostOf('about:debugging')).toBe('');
  });
});

import { prepare, siteOf } from '../src/core/prepare.ts';

describe('siteOf', () => {
  const item = (url: string, title = 'T') => prepare({ k: 'tab', id: 1, title, url, win: 1 });
  it('points at the domain, not a repeat of it later in the url', () => {
    const it = item('https://app.plan.io/r?to=plan.io');
    const [site, at] = siteOf(it);
    expect(site).toBe('plan.io');
    expect(it.hay.slice(at, at + site.length)).toBe('plan.io');
    expect(at).toBe(it.uOff + 'app.'.length);
  });
  it('labels extension pages and keeps short forms for other schemes', () => {
    expect(siteOf(item('moz-extension://0e54-uuid/welcome.html'))[0]).toBe('extension');
    expect(siteOf(item('about:debugging#/runtime'))[0]).toBe('about:debugging#/runtime'.split('#')[0]);
  });
});
