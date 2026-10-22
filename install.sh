#!/usr/bin/env bash
# harness installer for Linux and macOS (Apple Silicon).
#
#   curl -fsSL https://raw.githubusercontent.com/thearchitect/harness/master/install.sh | bash
#
# Installs the harness bundle (the `pi` launcher with the harness extension,
# bundled pi packages and pinned MCP tools) into the user's Nix profile, or
# upgrades it when already installed. Never changes the system silently: when
# Nix is missing it asks first on a terminal, and without a terminal (an agent
# running it) it stops and prints what a human has to approve.
set -euo pipefail

FLAKE="github:thearchitect/harness"
NIX_INSTALLER="https://nixos.org/nix/install"
# Binary cache published by CI (GitHub Releases). Without it Nix builds locally.
CACHE_URL="https://github.com/thearchitect/harness/releases/download/nix-cache"
CACHE_KEY="" # filled in once CI publishes signed builds

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
interactive() { [[ -t 1 ]] && { true </dev/tty; } 2>/dev/null; }
confirm() {
  local answer
  read -r -p "$1 [y/N] " answer </dev/tty
  [[ "$answer" == y || "$answer" == Y || "$answer" == yes ]]
}

# --- platform -----------------------------------------------------------------
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64 | Linux/aarch64 | Darwin/arm64) ;;
  *) die "unsupported platform $(uname -s)/$(uname -m): harness supports x86_64/aarch64 Linux and Apple Silicon macOS" ;;
esac

# --- Nix ----------------------------------------------------------------------
load_nix_env() {
  local f
  for f in /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh "$HOME/.nix-profile/etc/profile.d/nix.sh"; do
    # shellcheck disable=SC1090
    [[ -r "$f" ]] && . "$f"
  done
  return 0
}

if ! command -v nix >/dev/null 2>&1; then
  load_nix_env
fi
if ! command -v nix >/dev/null 2>&1; then
  if ! interactive; then
    say "Nix is not installed. harness needs Nix (it installs the pinned bundle)."
    say "Ask the user to approve installing Nix (uses sudo, creates /nix), then run:"
    say "  sh <(curl -fsSL $NIX_INSTALLER) --daemon"
    say "and rerun this installer in a new shell."
    exit 2
  fi
  say "harness needs Nix. The official installer will create /nix and ask for sudo."
  confirm "Install Nix now?" || die "Nix is required; aborted"
  sh <(curl -fsSL "$NIX_INSTALLER") --daemon </dev/tty
  load_nix_env
  command -v nix >/dev/null 2>&1 || die "Nix was installed but is not on PATH; open a new shell and rerun"
fi

NIX=(nix --extra-experimental-features "nix-command flakes")

# --- binary cache ---------------------------------------------------------------
if [[ -n "$CACHE_KEY" ]]; then
  if "${NIX[@]}" config show trusted-public-keys 2>/dev/null | grep -qF "$CACHE_KEY"; then
    :
  elif [[ "$("${NIX[@]}" config show trusted-users 2>/dev/null)" =~ (^|[[:space:]])($USER|root|\*)([[:space:]]|$) ]] || [[ $EUID -eq 0 ]]; then
    NIX+=(--option extra-substituters "$CACHE_URL" --option extra-trusted-public-keys "$CACHE_KEY")
  else
    warn "the harness binary cache is not trusted by this Nix installation, so the bundle will be built locally (a few minutes)."
    warn "to use the cache, add to /etc/nix/nix.conf and restart nix-daemon:"
    warn "  extra-substituters = $CACHE_URL"
    warn "  extra-trusted-public-keys = $CACHE_KEY"
  fi
fi

# --- install / upgrade -------------------------------------------------------------
if "${NIX[@]}" profile list --json 2>/dev/null | grep -q '"harness"'; then
  say "Upgrading harness…"
  "${NIX[@]}" profile upgrade harness
else
  say "Installing harness…"
  if "${NIX[@]}" profile add --help >/dev/null 2>&1; then
    "${NIX[@]}" profile add "$FLAKE"
  else
    "${NIX[@]}" profile install "$FLAKE"
  fi
fi

# --- post-install checks -------------------------------------------------------------
PROFILE_PI="$HOME/.nix-profile/bin/pi"
[[ -x "$PROFILE_PI" ]] || PROFILE_PI="${XDG_STATE_HOME:-$HOME/.local/state}/nix/profile/bin/pi"
found_pi="$(command -v pi 2>/dev/null || true)"
if [[ -z "$found_pi" ]]; then
  warn "pi is not on PATH yet: open a new shell (Nix profile: $PROFILE_PI)."
elif [[ "$(readlink -f "$found_pi")" != "$(readlink -f "$PROFILE_PI" 2>/dev/null)" ]]; then
  warn "another pi comes first on PATH: $found_pi (e.g. an npm install). Remove it: npm uninstall -g @earendil-works/pi-coding-agent"
fi

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
if [[ -f "$AGENT_DIR/settings.json" ]]; then
  for pkg in npm:@cortexkit/pi-magic-context npm:pi-ask-user npm:pi-ollama-cloud npm:pi-deepseek-search thearchitect/harness; do
    if grep -qF "$pkg" "$AGENT_DIR/settings.json"; then
      warn "$AGENT_DIR/settings.json still lists $pkg, which the bundle already provides; remove it (pi remove <source>) to avoid loading it twice."
    fi
  done
fi
[[ -e "$AGENT_DIR/extensions/harness" ]] &&
  warn "$AGENT_DIR/extensions/harness is an old harness checkout; remove it (the bundle loads harness itself)."
[[ -f "$AGENT_DIR/mcp.json" ]] && grep -q "locked-exec" "$AGENT_DIR/mcp.json" &&
  warn "$AGENT_DIR/mcp.json runs servers through harness's removed locked-exec.mjs; switch them to \"command\": \"pnpm\", \"args\": [\"--silent\", \"dlx\", \"<pkg>@<version>\", ...] (playwright and chromium-devtools are bundled now: delete those entries)."

say "Done. Start pi with: pi   (inside pi, /deps shows bundled versions)"
