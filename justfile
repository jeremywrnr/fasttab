default:
    @just --list

# Build dist/chrome, dist/firefox and dist/safari
build:
    node scripts/build.mjs

# Rebuild on change (unminified, inline sourcemaps)
watch target="chrome":
    node scripts/build.mjs --watch --target {{target}}

test:
    npx vitest run

typecheck:
    npx tsc --noEmit

# Per-keystroke search latency on synthetic 1k/5k/20k tab sets
bench:
    node --experimental-strip-types bench/search.bench.ts

# Lint and run the Firefox build in a temporary profile
run-firefox: build
    npx web-ext run --source-dir dist/firefox

lint-firefox: build
    npx web-ext lint --source-dir dist/firefox

# Package all three: Chrome Web Store zip, Firefox add-on zip, Safari macOS app (+ zip)
package: build
    rm -f fasttab-chrome.zip
    cd dist/chrome && zip -qr -X ../../fasttab-chrome.zip .
    npx web-ext build --source-dir dist/firefox --artifacts-dir . --filename fasttab-firefox.zip --overwrite-dest
    ./scripts/package-safari.sh
    @ls -lh fasttab-chrome.zip fasttab-firefox.zip fasttab-safari.zip

# Safari only (needs Xcode). TEAM_ID=<id> signs with your developer team.
package-safari: build
    ./scripts/package-safari.sh

check: typecheck test build
