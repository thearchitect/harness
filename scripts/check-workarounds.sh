#!/usr/bin/env bash
# Runs the removal checks documented in workarounds.ts.
# W1 is checked automatically; W2 prints the matching lines of the installed
# pi's API, docs and changelog for manual review.
#
# Usage: scripts/check-workarounds.sh [model]   (default: $PI_CHECK_MODEL or pi's default)
set -uo pipefail

MODEL="${1:-${PI_CHECK_MODEL:-}}"
PI_BIN="$(command -v pi)" || { echo "pi not found in PATH" >&2; exit 2; }
PI_PKG="$(cd "$(dirname "$(readlink -f "$PI_BIN")")/../.." && pwd)"
MC_PKG="${MC_PKG:-$HOME/.pi/agent/npm/node_modules/@cortexkit/pi-magic-context}"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/check-workarounds-XXXXXX")"

echo "pi package: $PI_PKG ($(node -p "require('$PI_PKG/package.json').version" 2>/dev/null))"
echo "MC package: $MC_PKG ($(node -p "require('$MC_PKG/package.json').version" 2>/dev/null))"
echo "full output: $OUT"
echo

model_args=()
[[ -n "$MODEL" ]] && model_args=(--model "$MODEL")
prompt='Do not call any tools. If your system prompt contains an <mcp_servers> section, reply exactly MCP_SERVERS_PRESENT, otherwise reply exactly MCP_SERVERS_ABSENT.'
base=(--no-extensions -e builtin:mcp -e builtin:codemode -e builtin:tool-search "${model_args[@]}")

echo "== W1: <mcp_servers> with magic-context"
(cd "$HOME" && timeout 300 pi -p "${base[@]}" "$prompt") >"$OUT/w1-baseline.log" 2>&1
(cd "$HOME" && timeout 300 pi -p "${base[@]}" -e "$MC_PKG" "$prompt") >"$OUT/w1-mc.log" 2>&1
if ! grep -q MCP_SERVERS_PRESENT "$OUT/w1-baseline.log"; then
  echo "   INCONCLUSIVE: baseline without MC has no <mcp_servers> (see w1-baseline.log)"
elif grep -q MCP_SERVERS_PRESENT "$OUT/w1-mc.log"; then
  echo "   CAN BE REMOVED: MC keeps <mcp_servers>"
else
  echo "   STILL NEEDED: MC drops <mcp_servers>"
fi
echo

review() {
  local id="$1" pattern="$2"; shift 2
  echo "== $id: review matches (remove when pi provides a public replacement)"
  for f in "$@"; do
    [[ -f "$PI_PKG/$f" ]] || continue
    grep -n -i -E "$pattern" "$PI_PKG/$f" >"$OUT/$id-$(basename "$f").log" 2>&1 &&
      sed 's/^/   /' "$OUT/$id-$(basename "$f").log" | cut -c1-200 | sed "s|^|   $f:|" | head -20
  done
  echo
}
review W2 "hideThinkingBlock|thinking\.toggle" docs/settings.md docs/keybindings.md CHANGELOG.md
