#!/usr/bin/env bash
# thearchitect.pi workflow dependencies: check and update.
#
#   deps.sh check              report installed / pinned / latest versions
#   deps.sh update <id|all>    update one component (or every outdated one)
#
# Components: pi, magic-context, codegraph, lightpanda, herdr.
# codegraph and lightpanda are pinned in ../deps.lock.json (the extension
# registers their MCP servers from it); the rest track their own installs.
#
# Output is human-readable. Lines starting with "ACTION <id> <label>" list the
# actions the /deps dialog offers; "NOTICE ..." lines are follow-ups.
# Updates run strictly one at a time (concurrent `bun x` installs of the same
# package corrupt each other).
set -uo pipefail

EXT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
LOCK="$EXT_DIR/deps.lock.json"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
LP_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/thearchitect.pi/lightpanda"
LP_ASSET="lightpanda-x86_64-linux"
MC_SOURCE="npm:@cortexkit/pi-magic-context"
MC_PKG_JSON="$AGENT_DIR/npm/node_modules/@cortexkit/pi-magic-context/package.json"
CODEGRAPH_PKG="@colbymchenry/codegraph"
COMPONENTS=(pi magic-context codegraph lightpanda herdr)

export DO_NOT_TRACK=1 CODEGRAPH_NO_UPDATE_CHECK=1 LIGHTPANDA_DISABLE_TELEMETRY=true

say() { printf '%s\n' "$*"; }
step() { printf '  · %s\n' "$*"; }
fail() { printf '  ✗ %s\n' "$*"; return 1; }

locked() { jq -r --arg id "$1" '.[$id].version // empty' "$LOCK" 2>/dev/null; }
set_locked() {
  local tmp; tmp="$(mktemp "$LOCK.XXXXXX")" || return 1
  jq --arg id "$1" --arg v "$2" '.[$id].version = $v' "$LOCK" >"$tmp" && mv "$tmp" "$LOCK"
}
npm_latest() { npm view "$1" version 2>/dev/null; }
lp_stable_latest() {
  curl -fsSL "https://api.github.com/repos/lightpanda-io/browser/releases?per_page=30" 2>/dev/null |
    jq -r '[.[] | select(.prerelease | not) | select(.tag_name | test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))][0].tag_name // empty'
}
herdr_latest() {
  curl -fsSI -o /dev/null -w '%{redirect_url}' https://github.com/herdrdev/herdr/releases/latest 2>/dev/null |
    sed -E 's|.*/tag/v?||'
}
lp_bin() { printf '%s/%s/lightpanda' "$LP_ROOT" "$1"; }

# MCP stdio handshake: prints serverInfo.name, or nothing on failure.
mcp_server_name() {
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deps.sh","version":"0"}}}' |
    timeout 60 "$@" 2>/dev/null | head -n 1 | jq -r '.result.serverInfo.name // empty' 2>/dev/null
}

# ---------------------------------------------------------------------------
# check: one "id|current|latest|state|detail" record per component
# state: ok | outdated | broken | unknown
# ---------------------------------------------------------------------------
check_pi() {
  local cur latest
  cur="$(pi --version 2>/dev/null | tail -n 1)"
  latest="$(npm_latest @earendil-works/pi-coding-agent)"
  [[ -z "$cur" ]] && { echo "pi|-|$latest|broken|pi not found"; return; }
  [[ -z "$latest" ]] && { echo "pi|$cur|?|unknown|npm registry unreachable"; return; }
  [[ "$cur" == "$latest" ]] && echo "pi|$cur|$latest|ok|" || echo "pi|$cur|$latest|outdated|"
}

check_magic_context() {
  local cur latest
  cur="$(jq -r .version "$MC_PKG_JSON" 2>/dev/null)"
  latest="$(npm_latest @cortexkit/pi-magic-context)"
  [[ -z "$cur" ]] && { echo "magic-context|-|$latest|broken|package not installed"; return; }
  [[ -z "$latest" ]] && { echo "magic-context|$cur|?|unknown|npm registry unreachable"; return; }
  [[ "$cur" == "$latest" ]] && echo "magic-context|$cur|$latest|ok|" || echo "magic-context|$cur|$latest|outdated|"
}

check_codegraph() {
  local cur latest
  cur="$(locked codegraph)"
  latest="$(npm_latest "$CODEGRAPH_PKG")"
  [[ -z "$cur" ]] && { echo "codegraph|-|$latest|broken|not pinned in deps.lock.json"; return; }
  [[ -z "$latest" ]] && { echo "codegraph|$cur|?|unknown|npm registry unreachable"; return; }
  [[ "$cur" == "$latest" ]] && echo "codegraph|$cur|$latest|ok|" || echo "codegraph|$cur|$latest|outdated|"
}

check_lightpanda() {
  local cur latest
  cur="$(locked lightpanda)"
  latest="$(lp_stable_latest)"
  if [[ -z "$cur" ]]; then echo "lightpanda|-|$latest|broken|not pinned in deps.lock.json"; return; fi
  if [[ ! -x "$(lp_bin "$cur")" ]]; then echo "lightpanda|$cur|${latest:-?}|broken|binary missing"; return; fi
  [[ -z "$latest" ]] && { echo "lightpanda|$cur|?|unknown|GitHub API unreachable"; return; }
  [[ "$cur" == "$latest" ]] && echo "lightpanda|$cur|$latest|ok|" || echo "lightpanda|$cur|$latest|outdated|"
}

check_herdr() {
  local cur latest integration
  cur="$(herdr --version 2>/dev/null | awk '{print $2}')"
  latest="$(herdr_latest)"
  integration="$(herdr integration status 2>/dev/null | sed -n 's/^pi: \([a-z ]*\).*/\1/p' | sed 's/ *$//')"
  [[ -z "$cur" ]] && { echo "herdr|-|$latest|broken|herdr not found"; return; }
  if [[ "$integration" != "current" ]]; then echo "herdr|$cur|${latest:-?}|outdated|pi integration: ${integration:-unknown}"; return; fi
  [[ -z "$latest" ]] && { echo "herdr|$cur|?|unknown|GitHub unreachable"; return; }
  [[ "$cur" == "$latest" ]] && echo "herdr|$cur|$latest|ok|" || echo "herdr|$cur|$latest|outdated|"
}

check_one() { "check_${1//-/_}"; }

cmd_check() {
  say "Checking workflow dependencies…"
  local records=() id record
  for id in "${COMPONENTS[@]}"; do
    step "$id"
    record="$(check_one "$id")"
    records+=("$record")
  done
  say ""
  printf '%-15s %-12s %-12s %s\n' COMPONENT CURRENT LATEST STATE
  local actionable=0 cur latest state detail mark
  for record in "${records[@]}"; do
    IFS='|' read -r id cur latest state detail <<<"$record"
    case "$state" in ok) mark="✓ up to date" ;; outdated) mark="↑ update available" ;; broken) mark="✗ broken" ;; *) mark="? unknown" ;; esac
    printf '%-15s %-12s %-12s %s%s\n' "$id" "$cur" "$latest" "$mark" "${detail:+ ($detail)}"
  done
  say ""
  for record in "${records[@]}"; do
    IFS='|' read -r id cur latest state detail <<<"$record"
    case "$state" in
      outdated) say "ACTION update:$id Update $id ${cur} → ${latest}${detail:+ ($detail)}"; actionable=$((actionable + 1)) ;;
      broken) say "ACTION update:$id Repair $id${detail:+ ($detail)}"; actionable=$((actionable + 1)) ;;
    esac
  done
  ((actionable > 1)) && say "ACTION update:all Update everything"
  ((actionable == 0)) && say "Everything is up to date."
  return 0
}

# ---------------------------------------------------------------------------
# update
# ---------------------------------------------------------------------------
update_pi() {
  step "pi update --self"
  pi update --self || return 1
  say "NOTICE pi updated: restart pi to use the new version."
}

update_magic_context() {
  step "pi update --extension $MC_SOURCE"
  pi update --extension "$MC_SOURCE" || return 1
  step "magic-context doctor --force --harness pi"
  (cd "$HOME" && bun x --bun @cortexkit/magic-context@latest doctor --force --harness pi) || return 1
  step "checking workarounds against the new version"
  "$EXT_DIR/scripts/check-workarounds.sh" || true
  say "NOTICE magic-context updated: run /reload (or restart pi)."
}

update_codegraph() {
  local v name
  v="$(npm_latest "$CODEGRAPH_PKG")"; [[ -n "$v" ]] || fail "cannot resolve latest $CODEGRAPH_PKG" || return 1
  step "installing $CODEGRAPH_PKG@$v into the bun cache"
  bun x "$CODEGRAPH_PKG@$v" --version || fail "codegraph $v does not run" || return 1
  step "MCP handshake"
  name="$(mcp_server_name bun x "$CODEGRAPH_PKG@$v" serve --mcp)"
  [[ "$name" == codegraph ]] || fail "codegraph $v MCP handshake failed" || return 1
  set_locked codegraph "$v" || return 1
  say "  ✓ codegraph pinned to $v"
}

update_lightpanda() {
  local v dir bin tmp name prev
  v="$(lp_stable_latest)"; [[ -n "$v" ]] || fail "cannot resolve latest lightpanda release" || return 1
  dir="$LP_ROOT/$v"; bin="$dir/lightpanda"
  if [[ ! -x "$bin" ]]; then
    step "downloading lightpanda $v"
    mkdir -p "$dir" || return 1
    tmp="$(mktemp "$dir/.download.XXXXXX")" || return 1
    curl -fsSL -o "$tmp" "https://github.com/lightpanda-io/browser/releases/download/$v/$LP_ASSET" ||
      { rm -f "$tmp"; fail "download failed"; return 1; }
    chmod +x "$tmp" && mv "$tmp" "$bin" || return 1
  fi
  step "lightpanda version: $("$bin" version 2>&1 | head -n 1)"
  step "MCP handshake"
  name="$(mcp_server_name "$bin" mcp)"
  [[ "$name" == lightpanda ]] || fail "lightpanda $v MCP handshake failed" || return 1
  prev="$(locked lightpanda)"
  set_locked lightpanda "$v" || return 1
  # Keep the new and the previous version (rollback); prune the rest.
  for d in "$LP_ROOT"/*/; do
    d="${d%/}"; [[ "${d##*/}" == "$v" || "${d##*/}" == "$prev" ]] && continue
    step "removing old ${d##*/}"; rm -rf -- "$d"
  done
  say "  ✓ lightpanda pinned to $v"
}

update_herdr() {
  step "herdr update"
  herdr update || return 1
  step "herdr integration install pi"
  herdr integration install pi || return 1
  say "NOTICE herdr updated: the running herdr server keeps the old binary until it restarts (herdr server stop)."
}

update_one() {
  say ""
  say "── update $1 ──"
  if "update_${1//-/_}"; then say "  ✓ $1 done"; else say "  ✗ $1 failed"; return 1; fi
}

cmd_update() {
  local target="${1:-}" id record state rc=0
  case "$target" in
    all)
      for id in "${COMPONENTS[@]}"; do
        record="$(check_one "$id")"; IFS='|' read -r _ _ _ state _ <<<"$record"
        [[ "$state" == outdated || "$state" == broken ]] || continue
        update_one "$id" || rc=1
      done ;;
    pi | magic-context | codegraph | lightpanda | herdr) update_one "$target" || rc=1 ;;
    *) say "usage: deps.sh update <${COMPONENTS[*]// /|}|all>"; return 2 ;;
  esac
  return "$rc"
}

case "${1:-}" in
  check) cmd_check ;;
  update) shift; cmd_update "$@" ;;
  *) say "usage: deps.sh check | deps.sh update <id|all>"; exit 2 ;;
esac
