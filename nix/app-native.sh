#!/usr/bin/env bash
# Prepares packages/app for a native build (iOS, Android): its node_modules (the Nix build of its
# lockfile), the fonts (the Nix build, as ttf) and the native projects (`expo prebuild`).
#
#   nix/app-native.sh android|ios
#
# Then: Android — `cd packages/app/android && ./gradlew assembleDebug` (needs the Android SDK:
# ANDROID_HOME); iOS — `xcodebuild` in packages/app/ios on macOS. CI: native-android.yml,
# native-apple.yml.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
PLATFORM="${1:?usage: nix/app-native.sh android|ios}"
APP="$ROOT/packages/app"

modules="$(nix build --no-link --print-out-paths "$ROOT#appModules")"
fonts="$(nix build --no-link --print-out-paths "$ROOT#appFonts")"

# prebuild writes into node_modules' neighbours, not into it: a writable copy is not needed
rm -rf "$APP/node_modules"
ln -s "$modules/node_modules" "$APP/node_modules"
mkdir -p "$APP/assets/fonts"
cp -f "$fonts"/*.ttf "$APP/assets/fonts/"
chmod u+w "$APP/assets/fonts"/*.ttf

cd "$APP"
CI=1 EXPO_NO_TELEMETRY=1 node node_modules/expo/bin/cli prebuild --platform "$PLATFORM" --no-install --clean
