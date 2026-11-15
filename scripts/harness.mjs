// Dev harness: wraps a built popup (dist/chrome) with a mocked chrome.* API and
// N synthetic tabs, so the real popup.js can be exercised in any browser tab.
//   node scripts/harness.mjs dist/chrome dist/harness.js 2000
// then evaluate dist/harness.js in an about:blank page.
import { readFileSync, writeFileSync } from 'node:fs';
const [, , dist, out, n = '2000'] = process.argv;
const html = readFileSync(dist + '/popup.html', 'utf8');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script'));
const style = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
const js = readFileSync(dist + '/popup.js', 'utf8');
const mock = `
(() => {
const N = ${n};
const HOSTS = ['github.com','docs.google.com','developer.chrome.com','developer.mozilla.org','news.ycombinator.com','mail.google.com','youtube.com','stackoverflow.com','linear.app','localhost:5173'];
const WORDS = ['Pull requests','Issues','Design review','Q4 planning','tabGroups API','Array sort','Show HN','Inbox','Lofi beats','debounce','frecency','first paint','Dashboard','Storybook','oncall runbook','budget'];
const COLORS = ['grey','blue','red','yellow','green','pink','purple','cyan','orange'];
const GN = ['Work','Research','Reading list','fasttab','Shopping','Infra/oncall','Travel','Music','Taxes','Papers'];
let x = 7; const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const now = Date.now();
const items = [];
const groups = [];
for (let g = 0; g < 30; g++) groups.push({ id: 100 + g, title: GN[g % GN.length] + (g >= GN.length ? ' ' + g : ''), color: COLORS[g % 9], collapsed: g % 3 === 0, windowId: 1 + (g % 3) });
for (let i = 0; i < N; i++) {
  const h = HOSTS[Math.floor(rnd() * HOSTS.length)];
  const w = WORDS[Math.floor(rnd() * WORDS.length)];
  const g = rnd() < 0.7 ? groups[Math.floor(rnd() * groups.length)] : null;
  const r = { k: 'tab', id: i + 1, title: w + ' #' + i, url: 'https://' + h + '/p/' + i, win: g ? g.windowId : 1 + (i % 3), la: now - i * 60000, fr: rnd() < 0.1 ? rnd() * 20 : undefined };
  if (g) { r.gid = g.id; r.gt = g.title; r.gc = g.color; }
  if (i === 0) { r.act = 1; r.win = 1; }
  if (i % 7 === 3) r.aud = 1; // some tabs playing audio
  if (i % 13 === 5) r.pin = 1;
  items.push(r);
}
for (const g of groups) { const ts = items.filter(t => t.gid === g.id); items.push({ k: 'group', id: g.id, title: g.title, url: '', win: g.windowId, gc: g.color, n: ts.length, mru: ts[0]?.id, la: ts[0]?.la, col: g.collapsed ? 1 : undefined }); }
items.push({ k: 'closed', id: 's1', title: 'Closed: Rust in 100 seconds', url: 'https://youtube.com/watch?v=x', la: now - 1000 });
const top = items.filter(r => r.k === 'tab').sort((a, b) => (a.act ? 1 : 0) - (b.act ? 1 : 0) || b.la - a.la).slice(0, 30);
const session = { ft_top: { v: 1, at: now, win: 1, items: top }, ft_full: { v: 1, at: now, win: 1, items } };
const calls = (window.__calls = []);
const rec = (name, ret) => (...a) => { calls.push([name, ...a]); return Promise.resolve(typeof ret === 'function' ? ret(...a) : ret); };
const ev = () => ({ addListener() {} });
const delay = (v, ms) => new Promise(r => setTimeout(() => r(v), ms));
const mock = {
  runtime: { getURL: (p) => 'data:,' + p, sendMessage: rec('sendMessage', true), onMessage: ev() },
  storage: {
    session: { get: (k) => delay({ [k]: session[k] }, k === 'ft_top' ? 2 : 8) },
    local: { get: () => Promise.resolve({}) },
    onChanged: ev(),
  },
  tabs: { update: rec('tabs.update', {}), create: rec('tabs.create', {}), remove: rec('tabs.remove'), query: rec('tabs.query', []) },
  windows: { getCurrent: () => Promise.resolve({ id: 1 }), update: rec('windows.update', {}) },
  tabGroups: { query: rec('tabGroups.query', (q) => groups.filter(g => g.windowId === q.windowId)), update: rec('tabGroups.update', {}) },
  sessions: { restore: rec('sessions.restore', {}), getRecentlyClosed: () => Promise.resolve([]) },
  bookmarks: { getTree: () => Promise.resolve([{ id: '0', children: [{ id: '1', parentId: '0', title: 'Bar', children: [{ id: 'b1', parentId: '1', title: 'Rust book', url: 'https://doc.rust-lang.org/book/' }, { id: 'f', parentId: '1', title: 'Recipes', children: [{ id: 'b2', parentId: 'f', title: 'Sourdough', url: 'https://bread.example/sourdough' }] }] }] }]) },
  history: { search: rec('history.search', (q) => q.text ? [{ url: 'https://old.example/' + q.text, title: 'Old page about ' + q.text, visitCount: 3, lastVisitTime: now - 9e9 }] : [{ url: 'https://recent.example/a', title: 'Recently visited A', visitCount: 5, lastVisitTime: now - 3600e3 }]) },
  commands: { getAll: () => Promise.resolve([{ name: '_execute_action', shortcut: '⌘P' }]) },
};
Object.defineProperty(window, 'chrome', { value: mock, configurable: true, writable: true });
window.close = () => calls.push(['window.close']);
})();
`;
const harness = `
document.open(); document.write('<!doctype html><html><head><meta charset="utf-8"><style>' + ${JSON.stringify(style)} + '</style></head><body>' + ${JSON.stringify(body)} + '</body></html>'); document.close();
${mock}
const __s = document.createElement('script'); __s.textContent = ${JSON.stringify(js)}; document.body.appendChild(__s);
"ok";
`;
writeFileSync(out, harness);
