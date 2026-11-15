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
