#!/usr/bin/env bash
# Bumps every pinned component of the bundle to its latest release:
#   - nix/npm/package.json + package-lock.json (pi, pi packages, npm MCP servers)
#   - nix/sources.json (prebuilt release binaries: lightpanda, agent-lsp)
#   - flake.lock (nixpkgs: codegraph, herdr, gopls, typescript-language-server, pnpm, nodejs)
#
#   nix/update.sh            update everything
#   nix/update.sh --no-flake skip `nix flake update`
#
# Prints one "<component> <old> -> <new>" line per change on stdout (used as
# the PR body by .github/workflows/update.yml). Requires: node/npm, jq, curl,
# nix. Never edit package-lock.json or sources.json by hand.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
NPM_DIR="$ROOT/nix/npm"
SOURCES="$ROOT/nix/sources.json"
SYSTEMS=(x86_64-linux aarch64-linux aarch64-darwin)
UPDATE_FLAKE=1
[[ "${1-}" == "--no-flake" ]] && UPDATE_FLAKE=0

log() { printf '%s\n' "$*" >&2; }
changed() { printf '%s %s -> %s\n' "$1" "$2" "$3"; }

gh_api() {
  local auth=()
  [[ -n "${GITHUB_TOKEN-}" ]] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  curl -fsSL "${auth[@]}" "https://api.github.com/$1"
}

# sha256 of a URL as an SRI hash, without touching the nix store.
sri_of_url() {
  local tmp
  tmp="$(mktemp)"
  curl -fsSL -o "$tmp" "$1"
  nix hash file --type sha256 --sri "$tmp"
  rm -f "$tmp"
}

# ---------------------------------------------------------------------------
# npm
# ---------------------------------------------------------------------------
update_npm() {
  local pkg old new tmp
  for pkg in $(jq -r '.dependencies | keys[]' "$NPM_DIR/package.json"); do
    old="$(jq -r --arg p "$pkg" '.dependencies[$p]' "$NPM_DIR/package.json")"
    new="$(npm view "$pkg" version)"
    [[ -n "$new" ]] || { log "npm: cannot resolve $pkg"; return 1; }
    if [[ "$old" != "$new" ]]; then
      tmp="$(mktemp)"
      jq --arg p "$pkg" --arg v "$new" '.dependencies[$p] = $v' "$NPM_DIR/package.json" >"$tmp"
      mv "$tmp" "$NPM_DIR/package.json"
      changed "$pkg" "$old" "$new"
    fi
  done
  log "npm: regenerating package-lock.json"
  (cd "$NPM_DIR" && rm -f package-lock.json && npm install --package-lock-only --ignore-scripts --no-audit --no-fund >&2)
}

# ---------------------------------------------------------------------------
# release binaries
# ---------------------------------------------------------------------------
asset_lightpanda() {
  case "$1" in
    x86_64-linux) echo lightpanda-x86_64-linux ;;
    aarch64-linux) echo lightpanda-aarch64-linux ;;
    aarch64-darwin) echo lightpanda-aarch64-macos ;;
  esac
}
asset_agent_lsp() {
  case "$1" in
    x86_64-linux) echo agent-lsp_linux_amd64.tar.gz ;;
    aarch64-linux) echo agent-lsp_linux_arm64.tar.gz ;;
    aarch64-darwin) echo agent-lsp_darwin_arm64.tar.gz ;;
  esac
}

latest_lightpanda() {
  gh_api "repos/lightpanda-io/browser/releases?per_page=30" |
    jq -r '[.[] | select(.prerelease | not) | select(.tag_name | test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))][0].tag_name'
}
latest_agent_lsp() {
  gh_api "repos/blackwell-systems/agent-lsp/releases/latest" | jq -r '.tag_name | ltrimstr("v")'
}

# update_release <id> <repo> <tag-prefix> <latest-fn> <asset-fn>
update_release() {
  local id="$1" repo="$2" prefix="$3" version old system asset url hash tmp
  version="$("$4")"
  [[ -n "$version" && "$version" != null ]] || { log "$id: cannot resolve latest release"; return 1; }
  old="$(jq -r --arg id "$id" '.[$id].version // ""' "$SOURCES")"
  [[ "$old" == "$version" ]] && return 0
  local entry
  entry="$(jq -n --arg v "$version" '{version: $v, assets: {}}')"
  for system in "${SYSTEMS[@]}"; do
    asset="$("$5" "$system")"
    url="https://github.com/$repo/releases/download/$prefix$version/$asset"
    log "$id: hashing $url"
    hash="$(sri_of_url "$url")"
    entry="$(jq --arg s "$system" --arg u "$url" --arg h "$hash" '.assets[$s] = {url: $u, hash: $h}' <<<"$entry")"
  done
  tmp="$(mktemp)"
  jq --arg id "$id" --argjson e "$entry" '.[$id] = $e' "$SOURCES" >"$tmp"
  mv "$tmp" "$SOURCES"
  changed "$id" "${old:-none}" "$version"
}

[[ -f "$SOURCES" ]] || echo '{}' >"$SOURCES"
update_npm
update_release lightpanda lightpanda-io/browser "" latest_lightpanda asset_lightpanda
update_release agent-lsp blackwell-systems/agent-lsp "v" latest_agent_lsp asset_agent_lsp

if ((UPDATE_FLAKE)); then
  old="$(jq -r '.nodes.nixpkgs.locked.rev // "none"' "$ROOT/flake.lock" 2>/dev/null || echo none)"
  nix flake update --flake "$ROOT" >&2
  new="$(jq -r '.nodes.nixpkgs.locked.rev' "$ROOT/flake.lock")"
  [[ "$old" == "$new" ]] || changed nixpkgs "${old:0:12}" "${new:0:12}"
fi
