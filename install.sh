#!/usr/bin/env bash
# harness installer for Linux and macOS (Apple Silicon).
#
#   curl -fsSL https://raw.githubusercontent.com/thearchitect/harness/master/install.sh | bash
#
# Installs the harness bundle (the `harness` command: nodes, the TUI, agents on
# pi with the bundled packages and pinned tools) into the user's Nix profile, or
# upgrades it when already installed. Never changes the system silently: when
# Nix is missing it asks first on a terminal, and without a terminal (an agent
# running it) it stops and prints what a human has to approve.
set -euo pipefail

FLAKE="github:thearchitect/harness"
NIX_INSTALLER="https://nixos.org/nix/install"

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
PROFILE_HARNESS="$HOME/.nix-profile/bin/harness"
[[ -x "$PROFILE_HARNESS" ]] || PROFILE_HARNESS="${XDG_STATE_HOME:-$HOME/.local/state}/nix/profile/bin/harness"

# macOS: the Finder Quick Action "Harness" and Ghostty's settings (macos/).
if [[ "$(uname -s)" == Darwin ]]; then
  "$(dirname "$PROFILE_HARNESS")/harness-setup" ||
    warn "the macOS integration (Finder's Harness item, Ghostty) failed; rerun it: harness-setup"
else
  : # no host integration on Linux
fi

found_harness="$(command -v harness 2>/dev/null || true)"
if [[ -z "$found_harness" ]]; then
  warn "harness is not on PATH yet: open a new shell (Nix profile: $PROFILE_HARNESS)."
elif [[ "$(readlink -f "$found_harness")" != "$(readlink -f "$PROFILE_HARNESS" 2>/dev/null)" ]]; then
  warn "another harness comes first on PATH: $found_harness."
fi

# harness keeps its data in ~/.harness (pi's ~/.pi/agent is not read): carry provider logins over once.
HOME_DIR="${HARNESS_HOME:-$HOME/.harness}"
if [[ -f "$HOME/.pi/agent/auth.json" && ! -e "$HOME_DIR/auth.json" ]]; then
  warn "your provider logins are in ~/.pi/agent/auth.json; harness reads $HOME_DIR/auth.json: copy it (install -Dm600 ~/.pi/agent/auth.json $HOME_DIR/auth.json) or log in again (harness auth login)."
fi

say "Done. Start it with: harness   (Ctrl+T new session, Ctrl+O open one, Ctrl+\\ the harness panel)"
