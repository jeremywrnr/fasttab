#!/usr/bin/env bash
# Wrap dist/safari in the macOS container app Safari needs, build it, and
# zip the .app. Ad-hoc signed: run it locally with Safari → Develop →
# "Allow Unsigned Extensions" (resets each Safari launch). Set TEAM_ID to sign
# with your Apple Developer team for a build that loads without that.
set -euo pipefail
cd "$(dirname "$0")/.."

out=build/safari
rm -rf "$out"
mkdir -p "$out"

xcrun safari-web-extension-converter dist/safari \
  --project-location "$out" \
  --app-name fasttab \
  --bundle-identifier com.jeremywrnr.fasttab \
  --swift --macos-only --copy-resources \
  --no-open --no-prompt --force >/dev/null

proj=$(find "$out" -name '*.xcodeproj' -maxdepth 3 | head -1)
sign=(CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER=)
[[ -n "${TEAM_ID:-}" ]] && sign=(DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic)

xcodebuild -project "$proj" -scheme fasttab -configuration Release \
  -derivedDataPath "$out/dd" "${sign[@]}" -quiet build

app=$(find "$out/dd/Build/Products/Release" -name 'fasttab.app' -maxdepth 1)
rm -rf dist/fasttab-safari.app fasttab-safari.zip
cp -R "$app" dist/fasttab-safari.app
ditto -c -k --keepParent dist/fasttab-safari.app fasttab-safari.zip
echo "dist/fasttab-safari.app"
echo "fasttab-safari.zip"
