#!/usr/bin/env bash
# Runs the removal checks documented in workarounds.ts: prints the matching
# lines of the installed pi's docs and changelog for manual review.
set -uo pipefail

PI_BIN="$(command -v pi)" || { echo "pi not found in PATH" >&2; exit 2; }
# The harness bundle: bin/pi + share/harness/manifest.json.
MANIFEST="$(dirname "$(readlink -f "$PI_BIN")")/../share/harness/manifest.json"
[[ -f "$MANIFEST" ]] || { echo "$PI_BIN is not the harness bundle launcher ($MANIFEST missing)" >&2; exit 2; }
PI_PKG="$(jq -r '.packages.pi' "$MANIFEST")"

echo "pi package: $PI_PKG ($(node -p "require('$PI_PKG/package.json').version" 2>/dev/null))"
echo

review() {
  local id="$1" pattern="$2"; shift 2
  echo "== $id: review matches (remove when pi provides a public replacement)"
  for f in "$@"; do
    [[ -f "$PI_PKG/$f" ]] || continue
    grep -n -i -E "$pattern" "$PI_PKG/$f" | cut -c1-200 | sed "s|^|   $f:|" | head -20
  done
  echo
}
review W2 "hideThinkingBlock|thinking\.toggle" docs/settings.md docs/keybindings.md CHANGELOG.md
