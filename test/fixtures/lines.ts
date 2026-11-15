// Deterministic synthetic tab haystacks (title + url + group), ASCII only so
// fzf's latin normalization never changes the comparison.
const SITES = [
  ['github.com', ['Pull requests', 'Issues', 'fzf/src/algo/algo.go at master', 'alyssaxuu/omni: Supercharge Chrome', 'Actions · build', 'Notifications']],
  ['docs.google.com', ['Q4 Planning Doc', 'Meeting Notes - Weekly Sync', 'Design Review: FastTab', 'Budget 2026']],
  ['developer.chrome.com', ['chrome.tabs API', 'chrome.tabGroups', 'Manifest V3 migration', 'chrome.commands']],
  ['developer.mozilla.org', ['Array.prototype.sort() - JavaScript | MDN', 'IntersectionObserver - Web APIs | MDN', 'tabGroups - Mozilla | MDN']],
  ['news.ycombinator.com', ['Hacker News', 'Show HN: a fast tab switcher', 'Ask HN: How do you manage 500 tabs?']],
  ['mail.google.com', ['Inbox (1,204) - Gmail', 'Re: Offsite logistics', 'Your order has shipped']],
  ['youtube.com', ['Lofi beats to code to', 'Rust in 100 Seconds', 'CppCon 2025: Fast fuzzy matching']],
  ['stackoverflow.com', ['How to debounce in TypeScript', 'Why is my service worker restarting?', 'Int32Array vs Array performance']],
  ['linear.app', ['FT-123 Implement frecency', 'FT-88 Popup first paint under 16ms', 'Cycle 42 - Board']],
  ['localhost:5173', ['Vite + React', 'Storybook', 'Dashboard (dev)']],
];
const GROUPS = ['', '', 'Work', 'Research', 'Reading list', 'fasttab', 'Shopping', 'Infra/oncall'];

export function makeLines(n: number, seed = 7): string[] {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const [host, titles] = SITES[Math.floor(rnd() * SITES.length)] as [string, string[]];
    const title = titles[Math.floor(rnd() * titles.length)];
    const path = ['', '/a/' + i, '/search?q=' + i, '/en-US/docs/Web/' + (i % 97), '/pulls/' + (i * 7) % 1000][Math.floor(rnd() * 5)];
    const g = GROUPS[Math.floor(rnd() * GROUPS.length)];
    out.push(title + '  ' + host + path + (g ? '  ' + g : ''));
  }
  return out;
}

export const QUERIES = [
  'g', 'gh', 'gith', 'fzf', 'algo', 'tab', 'tabgr', 'chrometabs', 'mdn', 'sort',
  'hn', 'showhn', 'inbox', 'gmail', 'rust', 'fuzzy', 'debounce', 'sw', 'ft12', 'ft-88',
  'vite', 'dev', 'local5173', 'work', 'research', 'oncall', 'infra/', 'q4', 'weekly',
  'design rev', 'mdn api', 'pull 7', 'a/1', 'docsweb', 'xyzzy', 'Tab', 'MDN', 'ac b',
];
