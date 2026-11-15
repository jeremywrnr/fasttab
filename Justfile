# fasttab: fzf-style tab switcher for Firefox, Chrome and Safari.
# `just` lists recipes; most take an optional browser target.

set shell := ["bash", "-euo", "pipefail", "-c"]
set dotenv-load

# chrome-dev host for `just run-chrome`; set it in a git-ignored .env (FASTTAB_CHROME_HOST=…)
chrome_host := env("FASTTAB_CHROME_HOST", "")

default:
    @just --list --unsorted

# ---------------------------------------------------------------- setup

# Install dependencies from the lockfile
setup:
    npm ci

# ---------------------------------------------------------------- build

# Build extensions into dist/<target>: all (default), chrome, firefox or safari
build target="all":
    node scripts/build.mjs {{ if target == "all" { "" } else { "--target " + target } }}

# Rebuild one target on change (unminified, inline sourcemaps)
watch target="firefox":
    node scripts/build.mjs --watch --target {{target}}

# Remove build output and packages
clean:
    rm -rf dist build fasttab-*.zip

# ---------------------------------------------------------------- quality

# Unit tests (fzf parity tests run when fzf is installed)
test:
    npx vitest run

# Tests in watch mode
test-watch:
    npx vitest

typecheck:
    npx tsc --noEmit

# web-ext lint on the Firefox build
lint: (build "firefox")
    npx web-ext lint --source-dir dist/firefox

# Per-keystroke search latency on synthetic 1k/5k/20k tab sets
bench:
    node --experimental-strip-types bench/search.bench.ts

# Everything CI should run
check: typecheck test lint build

# ---------------------------------------------------------------- run

# Firefox with fasttab in a throwaway profile (auto-reloads on rebuild)
run-firefox: (build "firefox")
    npx web-ext run --source-dir dist/firefox

# Your own Firefox: open about:debugging and copy the manifest path, then click Reload (or Load Temporary Add-on, ⌘⇧G ⌘V)
firefox-dev: (build "firefox")
    printf '%s' "$PWD/dist/firefox/manifest.json" | pbcopy
    open -a Firefox 'about:debugging#/runtime/this-firefox'
    @echo "manifest path copied: $PWD/dist/firefox/manifest.json"

# Chrome for Testing on $FASTTAB_CHROME_HOST with fasttab loaded (restarts that browser)
run-chrome: (build "chrome")
    @test -n "{{chrome_host}}" || { echo "set FASTTAB_CHROME_HOST to the machine running Chrome for Testing"; exit 1; }
    chrome-dev --host {{chrome_host}} --ext dist/chrome --restart

# Build the Safari app and open it so Safari registers the extension
run-safari: package-safari
    open dist/fasttab-safari.app
    @echo "Safari: Develop → Allow Unsigned Extensions, then Settings → Extensions → fasttab"

# Build dist/harness.js: the real popup with a mocked browser API and N fake tabs, to evaluate in any about:blank page
harness tabs="2000": (build "chrome")
    node scripts/harness.mjs dist/chrome dist/harness.js {{tabs}}

# ---------------------------------------------------------------- package

# All packages: fasttab-chrome.zip, fasttab-firefox.zip, fasttab-safari.zip
package: package-chrome package-firefox package-safari
    @ls -lh fasttab-chrome.zip fasttab-firefox.zip fasttab-safari.zip

# Chrome Web Store upload zip
package-chrome: (build "chrome")
    rm -f fasttab-chrome.zip
    cd dist/chrome && zip -qr -X ../../fasttab-chrome.zip .

# addons.mozilla.org upload zip
package-firefox: (build "firefox")
    npx web-ext build --source-dir dist/firefox --artifacts-dir . --filename fasttab-firefox.zip --overwrite-dest

# Safari macOS app via Xcode (ad-hoc signed; TEAM_ID=<id> signs with your developer team)
package-safari: (build "safari")
    ./scripts/package-safari.sh

# Sign the Firefox build as an unlisted add-on so it installs permanently (needs AMO_JWT_ISSUER / AMO_JWT_SECRET)
sign-firefox: (build "firefox")
    npx web-ext sign --source-dir dist/firefox --channel unlisted --artifacts-dir dist/signed --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET"
    @ls dist/signed
