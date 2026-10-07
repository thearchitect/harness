#!/usr/bin/env bash
# harness workflow dependencies: check and update.
#
#   deps.sh check              report installed / pinned / latest versions
#   deps.sh update <id|all>    update one component (or every outdated one)
#   deps.sh install-pinned     install the pinned codegraph/lightpanda if missing
#
# Components: harness, pi, magic-context, codegraph, lightpanda, herdr.
#
# Two modes, detected from where this checkout lives:
# - installed: a pi git package (<agent-dir>/git/..., or tmp/extensions for
#   `pi -e`). pi owns the checkout and
#   resets it on update, so nothing here is written. deps.lock.json pins come
#   with harness releases; codegraph/lightpanda are only installed at the
#   pinned version. "harness" updates through `pi update <source>`.
# - dev: any other checkout (folder / submodule). Updating codegraph or
#   lightpanda bumps deps.lock.json (commit it); "harness" is a git checkout.
#
# Output is human-readable. Lines starting with "ACTION <id> <label>" list the
# actions the /deps dialog offers; "NOTICE ..." lines are follow-ups.
# Updates run strictly one at a time (concurrent `bun x` installs of the same
# package corrupt each other).
set -uo pipefail

EXT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
LOCK="$EXT_DIR/deps.lock.json"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/harness"
LP_ROOT="$DATA_DIR/lightpanda"
LP_ASSET="lightpanda-x86_64-linux"
MC_SOURCE="npm:@cortexkit/pi-magic-context"
MC_PKG_JSON="$AGENT_DIR/npm/node_modules/@cortexkit/pi-magic-context/package.json"
CODEGRAPH_PKG="@colbymchenry/codegraph"
HARNESS_REPO="thearchitect/harness"
COMPONENTS=(harness pi magic-context codegraph lightpanda herdr)

# pi-managed: <agent-dir>/git (pi install) or <agent-dir>/tmp/extensions (pi -e).
AGENT_REAL="$(readlink -f "$AGENT_DIR")"
case "$EXT_DIR/" in
  "$AGENT_REAL/git/"* | "$AGENT_REAL/tmp/extensions/"* | "$AGENT_DIR/git/"* | "$AGENT_DIR/tmp/extensions/"*) MODE=installed ;;
  *) MODE=dev ;;
esac

export DO_NOT_TRACK=1 CODEGRAPH_NO_UPDATE_CHECK=1 LIGHTPANDA_DISABLE_TELEMETRY=true

say() { printf '%s\n' "$*"; }
step() { printf '  · %s\n' "$*"; }
fail() { printf '  ✗ %s\n' "$*"; return 1; }

locked() { jq -r --arg id "$1" '.[$id].version // empty' "$LOCK" 2>/dev/null; }
set_locked() {
  [[ "$MODE" == dev ]] || fail "deps.lock.json is read-only in an installed harness" || return 1
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
cg_installed() { bun x --no-install "$CODEGRAPH_PKG@$1" --version >/dev/null 2>&1; }

# The harness source as configured in pi's settings (git:..., https://...).
harness_source() {
  jq -r --arg repo "$HARNESS_REPO" \
    '.packages // [] | map(if type == "object" then .source else . end) | map(select(test($repo))) | .[0] // empty' \
    "$AGENT_DIR/settings.json" 2>/dev/null
}

# MCP stdio handshake: prints serverInfo.name, or nothing on failure.
mcp_server_name() {
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deps.sh","version":"0"}}}' |
    timeout 60 "$@" 2>/dev/null | head -n 1 | jq -r '.result.serverInfo.name // empty' 2>/dev/null
}

# ---------------------------------------------------------------------------
# check: one "id|current|latest|state|detail" record per component
# state: ok | outdated | broken | unknown
# ---------------------------------------------------------------------------
check_harness() {
  local head remote
  head="$(git -C "$EXT_DIR" rev-parse --short HEAD 2>/dev/null)"
  [[ -z "$head" ]] && { echo "harness|-|?|unknown|not a git checkout"; return; }
  if [[ "$MODE" == installed ]]; then
    remote="$(git -C "$EXT_DIR" ls-remote origin HEAD 2>/dev/null | cut -c1-7)"
    [[ -z "$remote" ]] && { echo "harness|$head|?|unknown|remote unreachable (installed)"; return; }
    [[ "$remote" == "$head" ]] && echo "harness|$head|$remote|ok|installed" || echo "harness|$head|$remote|outdated|installed"
    return
  fi
  git -C "$EXT_DIR" fetch -q origin 2>/dev/null
  local counts ahead behind dirty="" detail
  counts="$(git -C "$EXT_DIR" rev-list --left-right --count 'HEAD...@{upstream}' 2>/dev/null)"
  read -r ahead behind <<<"${counts:-0 0}"
  [[ -n "$(git -C "$EXT_DIR" status --porcelain 2>/dev/null)" ]] && dirty=", uncommitted changes"
  remote="$(git -C "$EXT_DIR" rev-parse --short '@{upstream}' 2>/dev/null || echo '?')"
  detail="dev, ahead $ahead, behind $behind$dirty"
  if ((behind > 0)) && ((ahead == 0)) && [[ -z "$dirty" ]]; then
    echo "harness|$head|$remote|outdated|$detail"
  else
    echo "harness|$head|$remote|ok|$detail"
  fi
}

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

# Pinned components: missing pinned version -> broken; newer upstream is
# actionable only in dev mode (installed harness gets new pins with releases).
pinned_record() {
  local id="$1" cur="$2" latest="$3" present="$4"
  [[ -z "$cur" ]] && { echo "$id|-|$latest|broken|not pinned in deps.lock.json"; return; }
  [[ "$present" != yes ]] && { echo "$id|$cur|${latest:-?}|broken|pinned $cur not installed"; return; }
  [[ -z "$latest" ]] && { echo "$id|$cur|?|unknown|upstream unreachable"; return; }
  if [[ "$cur" == "$latest" ]]; then echo "$id|$cur|$latest|ok|"
  elif [[ "$MODE" == dev ]]; then echo "$id|$cur|$latest|outdated|"
  else echo "$id|$cur|$latest|ok|pinned by harness"; fi
}

check_codegraph() {
  local cur present=no
  cur="$(locked codegraph)"
  [[ -n "$cur" ]] && cg_installed "$cur" && present=yes
  pinned_record codegraph "$cur" "$(npm_latest "$CODEGRAPH_PKG")" "$present"
}

check_lightpanda() {
  local cur present=no
  cur="$(locked lightpanda)"
  [[ -n "$cur" && -x "$(lp_bin "$cur")" ]] && present=yes
  pinned_record lightpanda "$cur" "$(lp_stable_latest)" "$present"
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
  say "Checking workflow dependencies ($MODE harness at $EXT_DIR)…"
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
# install / update
# ---------------------------------------------------------------------------
install_codegraph() {
  local v="$1" name
  step "installing $CODEGRAPH_PKG@$v into the bun cache"
  bun x "$CODEGRAPH_PKG@$v" --version || fail "codegraph $v does not run" || return 1
  step "MCP handshake"
  name="$(mcp_server_name bun x "$CODEGRAPH_PKG@$v" serve --mcp)"
  [[ "$name" == codegraph ]] || fail "codegraph $v MCP handshake failed"
}

install_lightpanda() {
  local v="$1" dir bin tmp name
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
  [[ "$name" == lightpanda ]] || fail "lightpanda $v MCP handshake failed"
}

# Keep the given versions (current + rollback), remove other lightpanda installs.
prune_lightpanda() {
  local d
  for d in "$LP_ROOT"/*/; do
    [[ -d "$d" ]] || continue
    d="${d%/}"
    case " $* " in *" ${d##*/} "*) continue ;; esac
    step "removing old lightpanda ${d##*/}"; rm -rf -- "$d"
  done
}

update_harness() {
  if [[ "$MODE" == dev ]]; then
    step "git pull --ff-only"
    git -C "$EXT_DIR" pull --ff-only || return 1
  else
    local src; src="$(harness_source)"
    [[ -n "$src" ]] || fail "harness package source not found in $AGENT_DIR/settings.json" || return 1
    step "pi update $src"
    pi update "$src" || return 1
  fi
  step "installing pinned dependencies of the new harness"
  "$EXT_DIR/scripts/deps.sh" install-pinned || return 1
  say "NOTICE harness updated: run /reload (or restart pi)."
}

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
  local v
  if [[ "$MODE" == dev ]]; then
    v="$(npm_latest "$CODEGRAPH_PKG")"; [[ -n "$v" ]] || fail "cannot resolve latest $CODEGRAPH_PKG" || return 1
  else
    v="$(locked codegraph)"; [[ -n "$v" ]] || fail "codegraph is not pinned" || return 1
  fi
  install_codegraph "$v" || return 1
  [[ "$MODE" == dev ]] && { set_locked codegraph "$v" || return 1; say "  ✓ codegraph pinned to $v (commit deps.lock.json)"; }
  return 0
}

update_lightpanda() {
  local v prev
  prev="$(locked lightpanda)"
  if [[ "$MODE" == dev ]]; then
    v="$(lp_stable_latest)"; [[ -n "$v" ]] || fail "cannot resolve latest lightpanda release" || return 1
  else
    v="$prev"; [[ -n "$v" ]] || fail "lightpanda is not pinned" || return 1
  fi
  install_lightpanda "$v" || return 1
  [[ "$MODE" == dev ]] && { set_locked lightpanda "$v" || return 1; say "  ✓ lightpanda pinned to $v (commit deps.lock.json)"; }
  prune_lightpanda "$v" "$prev"
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
    harness | pi | magic-context | codegraph | lightpanda | herdr) update_one "$target" || rc=1 ;;
    *) say "usage: deps.sh update <$(IFS='|'; echo "${COMPONENTS[*]}")|all>"; return 2 ;;
  esac
  return "$rc"
}

cmd_install_pinned() {
  local v rc=0
  v="$(locked codegraph)"
  if [[ -n "$v" ]] && ! cg_installed "$v"; then install_codegraph "$v" || rc=1; fi
  v="$(locked lightpanda)"
  if [[ -n "$v" && ! -x "$(lp_bin "$v")" ]]; then install_lightpanda "$v" || rc=1; fi
  return "$rc"
}

main() {
  case "${1:-}" in
    check) cmd_check ;;
    update) shift; cmd_update "$@" ;;
    install-pinned) cmd_install_pinned ;;
    *) say "usage: deps.sh check | update <id|all> | install-pinned"; return 2 ;;
  esac
}
# Fully parsed before running: safe even if `pi update` replaces this file.
main "$@"
exit
