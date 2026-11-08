#!/usr/bin/env bash
# Smoke tests of a built bundle (CI and local):
#   nix/smoke.sh [bundle-dir]     (default: ./result)
# Runs in a throwaway HOME, so it never touches the user's pi configuration.
set -uo pipefail

BUNDLE="$(readlink -f "${1:-result}")"
MANIFEST="$BUNDLE/share/harness/manifest.json"
PI="$BUNDLE/bin/pi"
WORK="$(mktemp -d)"
export HOME="$WORK/home" PI_OFFLINE=1
mkdir -p "$HOME"
failures=0

pass() { printf '  ok    %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n' "$1"
  [[ -n "${2-}" && -f "$2" ]] && sed 's/^/        /' "$2" | tail -n 20
  failures=$((failures + 1))
}
bin() { jq -r --arg id "$1" '.bin[$id]' "$MANIFEST"; }

# mcp_tools <log> <command...>: initialize + tools/list over stdio; prints tool names.
mcp_tools() {
  local log="$1"
  shift
  {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"harness-smoke","version":"0"}}}'
    sleep 3
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
    sleep 10
  } | (cd "$WORK" && timeout 90 "$@") 2>"$log" | jq -r 'select(.id == 2) | .result.tools[].name' 2>>"$log"
}

# check_mcp <id> <expected tool> <command...>
check_mcp() {
  local id="$1" expected="$2" log="$WORK/$1.log"
  shift 2
  if mcp_tools "$log" "$@" | grep -qx "$expected"; then pass "mcp $id lists $expected"; else fail "mcp $id lists $expected" "$log"; fi
}

echo "bundle: $BUNDLE"
[[ -f "$MANIFEST" ]] || { echo "no manifest at $MANIFEST" >&2; exit 1; }

# pi itself
if [[ "$("$PI" --version 2>"$WORK/version.log" | tail -n 1)" == "$(jq -r .versions.pi "$MANIFEST")" ]]; then
  pass "pi --version matches the manifest"
else
  fail "pi --version matches the manifest" "$WORK/version.log"
fi
# Loads the harness extension and every bundled package (pi exits non-zero on
# "Failed to load extension").
if "$PI" --help >"$WORK/help.log" 2>&1 && ! grep -q "Failed to load extension" "$WORK/help.log"; then
  pass "pi --help loads the bundled extensions"
else
  fail "pi --help loads the bundled extensions" "$WORK/help.log"
fi
# Profiles: the server profile (Telegram gateway) loads no ask_user; both load
# the bundled skills.
# rpc_commands <log> [env...]: the command names pi reports over RPC.
rpc_commands() {
  local log="$1"
  shift
  printf '%s\n' '{"id":"c","type":"get_commands"}' \
    | (cd "$WORK" && env "$@" timeout 90 "$PI" --mode rpc --no-session) 2>"$log" \
    | jq -r 'select(.id == "c") | .data.commands[].name' 2>>"$log"
}
desktop_commands="$(rpc_commands "$WORK/rpc-desktop.log" HARNESS_PROFILE=)"
server_commands="$(rpc_commands "$WORK/rpc-server.log" HARNESS_PROFILE=server)"
if grep -qx 'skill:ask-user' <<<"$desktop_commands" && grep -qx 'skill:cage' <<<"$desktop_commands" && grep -qx 'madness' <<<"$desktop_commands" && ! grep -qx 'skill:server' <<<"$desktop_commands"; then
  pass "desktop profile: ask-user and cage skills, madness, no server skill"
else
  fail "desktop profile: ask-user and cage skills, madness, no server skill" "$WORK/rpc-desktop.log"
fi
if ! grep -qx 'skill:ask-user' <<<"$server_commands" && ! grep -qx 'madness' <<<"$server_commands" && grep -qx 'skill:cage' <<<"$server_commands" && grep -qx 'skill:server' <<<"$server_commands" && grep -qx 'deps' <<<"$server_commands"; then
  pass "server profile: no ask-user, no madness, cage and server skills, harness loaded"
else
  fail "server profile: no ask-user, no madness, cage and server skills, harness loaded" "$WORK/rpc-server.log"
fi
# The cage skill is cage's own text.
if cmp -s "$(jq -r .skills.cage "$MANIFEST")" <("$(jq -r .bin.cage "$MANIFEST")" skill); then
  pass "cage skill: the output of cage skill"
else
  fail "cage skill: the output of cage skill" /dev/null
fi

# Subcommands bypass the -e flags.
if "$PI" list >"$WORK/list.log" 2>&1; then pass "pi list"; else fail "pi list" "$WORK/list.log"; fi
if "$PI" mcp list >"$WORK/mcp-list.log" 2>&1; then pass "pi mcp list"; else fail "pi mcp list" "$WORK/mcp-list.log"; fi

# MCP servers, as deps.ts launches them
LIGHTPANDA_DISABLE_TELEMETRY=true check_mcp lightpanda goto "$(bin lightpanda)" mcp
check_mcp playwright browser_snapshot "$(bin playwright-mcp)" --extension
check_mcp chromium-devtools take_snapshot "$(bin chrome-devtools-mcp)" --no-usage-statistics

# Language servers run (their behavior: nix/test.sh)
if "$(bin tsgo)" --version >"$WORK/tsgo.log" 2>&1; then pass "tsgo --version"; else fail "tsgo --version" "$WORK/tsgo.log"; fi
if [[ -f "$(jq -r '.packages.typescript' "$MANIFEST")/package.json" ]]; then pass "typescript package"; else fail "typescript package"; fi
if "$(bin gopls)" version >"$WORK/gopls.log" 2>&1; then pass "gopls version"; else fail "gopls version" "$WORK/gopls.log"; fi
if "$(bin rust-analyzer)" --version >"$WORK/rust-analyzer.log" 2>&1; then pass "rust-analyzer --version"; else fail "rust-analyzer --version" "$WORK/rust-analyzer.log"; fi
if "$BUNDLE/bin/pnpm" --version >"$WORK/pnpm.log" 2>&1; then pass "pnpm --version"; else fail "pnpm --version" "$WORK/pnpm.log"; fi
if "$BUNDLE/bin/herdr" --version >"$WORK/herdr.log" 2>&1; then pass "herdr --version"; else fail "herdr --version" "$WORK/herdr.log"; fi
if "$BUNDLE/bin/cage" help >"$WORK/cage.log" 2>&1 && [[ "$(bin cage)" == "$(readlink -f "$BUNDLE/bin/cage")" ]]; then pass "cage help"; else fail "cage help" "$WORK/cage.log"; fi

# herdr's pi integration, loaded by the launcher
herdr_pi="$(grep -o '[^ ]*/share/herdr/integrations/pi/herdr-agent-state.ts' "$PI" | head -n 1)"
if [[ -n "$herdr_pi" && -f "$herdr_pi" ]]; then pass "launcher loads herdr's pi integration"; else fail "launcher loads herdr's pi integration"; fi

# Bundled tools on PATH; telemetry off by default
if "$BUNDLE/bin/lightpanda" version >"$WORK/lightpanda-cli.log" 2>&1; then pass "lightpanda version"; else fail "lightpanda version" "$WORK/lightpanda-cli.log"; fi
if grep -q LIGHTPANDA_DISABLE_TELEMETRY "$BUNDLE/bin/lightpanda"; then pass "lightpanda telemetry off"; else fail "lightpanda telemetry off"; fi
if "$BUNDLE/bin/playwright-mcp" --version >"$WORK/playwright-mcp-cli.log" 2>&1; then pass "playwright-mcp --version"; else fail "playwright-mcp --version" "$WORK/playwright-mcp-cli.log"; fi
if "$BUNDLE/bin/chrome-devtools-mcp" --version >"$WORK/chrome-devtools-mcp-cli.log" 2>&1; then pass "chrome-devtools-mcp --version"; else fail "chrome-devtools-mcp --version" "$WORK/chrome-devtools-mcp-cli.log"; fi
if grep -q CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS "$BUNDLE/bin/chrome-devtools-mcp"; then pass "chrome-devtools-mcp usage statistics off"; else fail "chrome-devtools-mcp usage statistics off"; fi

if ((failures > 0)); then
  echo "$failures smoke test(s) failed (logs: $WORK)"
  exit 1
fi
rm -rf "$WORK"
echo "all smoke tests passed"
