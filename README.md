# fasttab

A fast, keyboard-first tab switcher for Chrome and Firefox, built for hundreds or thousands of tabs across many tab groups. Inspired by [omni](https://github.com/alyssaxuu/omni) and Alfred: press **⌃K** (Control-K; Alt+K on Windows/Linux) and a single search bar floats near the top-center of the page; results appear as you type.

**How it opens.** The shortcut injects a small transparent frame into the current page, only when pressed: no content script runs on pages otherwise, and the `activeTab` + `scripting` permissions carry no install-time warning. The frame is the extension's own page, so the site can't read it. Data and actions go through the background worker, and every request carries a one-time token, so a page that frames fasttab itself gets nothing. Where browsers forbid injection (new tab, `about:`/`chrome://` pages, the add-on stores) it opens the same UI as the toolbar popup.

## Install (dev)

```sh
npm install
just build          # dist/chrome and dist/firefox
```

- **Chrome:** go to `chrome://extensions`, turn on Developer mode, then **Load unpacked** and pick `dist/chrome`.
- **Firefox:** run `just run-firefox`, or load `dist/firefox/manifest.json` as a temporary add-on from `about:debugging`.

## Shortcut

The default is **⌃K** on macOS and **Alt+K** on Windows/Linux, in both Chrome and Firefox. Ctrl+K isn't the default off macOS because there both browsers use it for web search: Chrome refuses browser keys as an extension default (it did the same with ⌘P), which would leave fasttab with no shortcut. In Chrome you can still bind Ctrl+K yourself at `chrome://extensions/shortcuts`, and a key you set there takes priority over the browser's own. If another extension already holds the key, fasttab is left without a shortcut. Its options page (and the footer link in the popup) open the shortcut settings so you can pick another key.

**Sites that grab the shortcut (Firefox).** Some pages handle the key themselves and stop it before the browser sees it. In Google Docs, ⌃K deletes to the end of the line, and Firefox gives you no setting to stop that for extension shortcuts. fasttab's options page has an opt-in **Capture the shortcut on every page** switch. It asks for access to all websites, then adds a tiny listener to every page and frame at load. The listener catches only the fasttab shortcut, before the site's own code runs, and opens fasttab. With the switch off, nothing runs in pages until you press the shortcut.

You can change the key at `chrome://extensions/shortcuts` (in Firefox, `about:addons` → Manage Extension Shortcuts). Chrome won't let an extension claim **⌘P** as its default, but a ⌘P you set there does take priority over Print, which was checked on Chrome 156.

## Using it

| Key | Action |
| --- | --- |
| type | fuzzy search (fzf syntax) |
| ↑ ↓ · Ctrl+N/P · Ctrl+J/K · Tab | move |
| ↵ | switch to tab, focus group, restore closed tab, open bookmark or history entry in a new tab |
| ⇧↵ on a group | expand it and collapse the other groups in that window |
| ⌘↵ on a bookmark or history entry | open it in the current tab |
| ⌘⌫ | close the selected tab and stay in the switcher |
| Esc, ⌃K again, or click outside | close |

**Minimal first:** only the search bar shows until you type, with a hint of where ↵ goes. **⌃K then ↵** switches to your previous tab, like alt-tab. ↓ on an empty query shows the recent-tabs list.

**Query syntax** follows fzf:

| Syntax | Meaning |
| --- | --- |
| `a b` | AND |
| `a \| b` | OR |
| `'exact` | exact match |
| `^prefix` | prefix of the title or host |
| `suffix$` | suffix |
| `!not` | exclude |

An uppercase letter makes that term case-sensitive.

**Scope prefixes** narrow the search:

| Prefix | Searches |
| --- | --- |
| `t:` | tabs |
| `w:` | tabs in this window |
| `g:` | tab groups |
| `c:` | recently closed |
| `b:` | bookmarks |
| `h:` | history |

## How it stays fast

- **Matching:** `src/core/fzf.ts` is a port of fzf's FuzzyMatchV2 and exact/prefix/suffix matchers. `test/fzf.test.ts` checks that it ranks a 600-line fixture exactly as `fzf --filter` does, for 38 queries.
- **Prefilter:** each item has a 64-bit character mask, so items missing a query character are skipped before any scoring.
- **Incremental narrowing:** when a query only extends the previous one, only the previous matches are rescored. A 32-entry LRU makes backspace free.
- **Ranking:** a hit's rank is its fzf score plus a precomputed static rank:
  - a boost by kind (tab, group, closed, bookmark, history)
  - frecency
  - how recently the tab was used
  - a penalty for the current tab

  Rank, length and ordinal are packed into one float64 per hit and sorted with the native `Float64Array.sort`, with no comparator and no per-hit objects.
- **Staged loading:**
  1. The background keeps a live index from tab, group and session events, and writes a snapshot to `storage.session` after changes settle (debounced 100 ms, capped at 400 ms).
  2. The popup paints from the small `ft_top` key (30 MRU tabs) and enables search when `ft_full` arrives. It never waits on the background worker.
  3. Bookmarks and the last 30 days of history load when the browser is idle. Older history is fetched with `history.search` as you type, debounced.
- **Frecency:** a zoxide-style decayed score per URL with a 3-day half-life. Each tab activation that lasts over 1 s counts 1, and each pick from the popup counts 2 more.
- **UI:** a vanilla DOM virtual list with recycled rows. Searches run once per animation frame, highlights are computed only for visible rows, and favicons load lazily.

## Numbers

These were measured on an M-series Mac with Node 24, typing queries one character at a time (`just bench`):

| Items | Index build | p50 per keystroke | p99 per keystroke |
| --- | --- | --- | --- |
| 1,000 | 2 ms | 0.1 ms | 0.35 ms |
| 5,000 | 3 ms | 0.5 ms | 2.2 ms |
| 20,000 | 18 ms | 1.9 ms | 9.4 ms |

In Chrome 156 with 2,000 tabs in 30 groups, search plus render took 2–6 ms per keystroke. That run used the real popup with mocked APIs, via `scripts/harness.mjs`.

Real-browser checks, with 300 tabs in 12 groups:

| | Chrome 156 (unpacked) | Firefox 160 (`web-ext run`) |
| --- | --- | --- |
| Shortcut | ⌥K default; ⌘P when set by hand (wins over Print) | ⌥K default (`Alt+K` reported by `commands.getAll`) |
| Popup opened to first rows | 77 ms | 11 ms |
| Search + render per keystroke | 2–6 ms | 0.5–4.6 ms |
| Switch, group solo (⇧↵), empty-query ↵ → previous tab | ✓ | ✓ |

## Development

| Command | Does |
| --- | --- |
| `just test` | runs vitest; the fzf parity tests are skipped if `fzf` isn't installed |
| `just bench` | runs the search benchmark |
| `just watch chrome` | rebuilds on change, unminified |
| `just lint-firefox` | runs `web-ext lint` |
| `just zip` | packages both builds |
