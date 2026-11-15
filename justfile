default:
    @just --list

# Build dist/chrome and dist/firefox
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

# Zip both builds for upload
zip: build
    cd dist/chrome && zip -qr ../../fasttab-chrome.zip .
    npx web-ext build --source-dir dist/firefox --artifacts-dir . --filename fasttab-firefox.zip --overwrite-dest

check: typecheck test build
