#!/usr/bin/env bash
# Builds release/stash.app and release/stash.dmg from the SwiftPM package.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f stash.secret.json ]]; then
  echo "error: stash.secret.json is missing. Create it as described in README.md." >&2
  exit 1
fi

swift build -c release --arch arm64 -Xswiftc -warnings-as-errors
bin="$(swift build -c release --arch arm64 --show-bin-path)/Stash"

app=release/stash.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/stash"
cp Info.plist "$app/Contents/Info.plist"
cp Resources/*.png Resources/AppIcon.icns "$app/Contents/Resources/"
cp stash.secret.json "$app/Contents/Resources/"

codesign --force --sign - --timestamp=none "$app"
hdiutil create -volname stash -srcfolder "$app" -ov -format UDZO release/stash.dmg

du -sh "$app"
