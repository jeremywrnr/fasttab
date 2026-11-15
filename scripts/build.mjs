// Builds dist/chrome, dist/firefox and dist/safari from one source tree.
//   node scripts/build.mjs [--watch] [--target chrome|firefox|safari]
// dist/safari is the web-extension half; scripts/package-safari.sh wraps it
// in the macOS app Safari requires.
import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIcons } from './icons.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const watch = args.includes('--watch');
const only = args.includes('--target') ? args[args.indexOf('--target') + 1] : null;
const targets = only ? [only] : ['chrome', 'firefox', 'safari'];

function manifest(target) {
  const m = JSON.parse(readFileSync(join(root, 'src/manifest.base.json'), 'utf8'));
  if (target === 'chrome') {
    m.background = { service_worker: 'background.js' };
    m.permissions.push('favicon');
    m.minimum_chrome_version = '127'; // action.openPopup()
  } else if (target === 'safari') {
    m.background = { service_worker: 'background.js' };
    // Safari has no tabGroups, sessions, bookmarks or history APIs; the code feature-detects them.
    m.permissions = m.permissions.filter((p) => !['tabGroups', 'sessions', 'bookmarks', 'history'].includes(p));
    m.browser_specific_settings = { safari: { strict_min_version: '17.0' } };
    delete m.options_ui.open_in_tab; // Safari ignores it and warns
  } else {
    m.background = { scripts: ['background.js'] };
    // Opt-in "capture the shortcut on every page" (options page) asks for this at that moment.
    m.optional_host_permissions = ['<all_urls>'];
    m.browser_specific_settings = {
      gecko: { id: 'fasttab@jeremywrnr', strict_min_version: '140.0', data_collection_permissions: { required: ['none'] } },
    };
  }
  return m;
}

function writeStatic(target, out) {
  mkdirSync(join(out, 'icons'), { recursive: true });
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest(target), null, 2));
  const css = readFileSync(join(root, 'src/popup/popup.css'), 'utf8');
  const html = readFileSync(join(root, 'src/popup/popup.html'), 'utf8').replace('/*INLINE_CSS*/', css);
  writeFileSync(join(out, 'popup.html'), html);
  writeFileSync(join(out, 'welcome.html'), readFileSync(join(root, 'src/welcome/welcome.html'), 'utf8'));
  for (const [size, png] of makeIcons()) writeFileSync(join(out, 'icons', `${size}.png`), png);
}

const staticPlugin = (target, out) => ({
  name: 'static',
  setup(b) {
    b.onEnd(() => writeStatic(target, out));
  },
});

for (const target of targets) {
  const out = join(root, 'dist', target);
  rmSync(out, { recursive: true, force: true });
  const opts = {
    entryPoints: { background: join(root, 'src/background/index.ts'), popup: join(root, 'src/popup/popup.ts'), welcome: join(root, 'src/welcome/welcome.ts'), hotkey: join(root, 'src/hotkey/hotkey.ts') },
    outdir: out,
    bundle: true,
    format: 'iife',
    target: target === 'chrome' ? 'chrome121' : target === 'safari' ? 'safari17' : 'firefox128',
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    legalComments: 'none',
    define: {
      __FIREFOX__: String(target === 'firefox'),
      __CHROME__: String(target === 'chrome'),
      __SAFARI__: String(target === 'safari'),
    },
    plugins: [staticPlugin(target, out)],
    logLevel: 'info',
  };
  if (watch) await (await esbuild.context(opts)).watch();
  else await esbuild.build(opts);
}
