---
name: install-harness
description: Install or upgrade harness (the multi-session agent platform on pi, with its bundled packages and tools) on NixOS, Linux or macOS.
---

# Install harness

Supported: x86_64/aarch64 Linux, Apple Silicon macOS. Delivered through Nix (flakes).

## Linux / macOS
    curl -fsSL https://raw.githubusercontent.com/thearchitect/harness/master/install.sh | bash
Rerunning it upgrades. If Nix is missing, the script exits with code 2 and prints the Nix
install command: ask the user to approve it (it uses sudo and creates /nix), run it, then
rerun the script in a new shell.

## NixOS / home-manager
Add the flake input `harness.url = "github:thearchitect/harness";` and the package
`inputs.harness.packages.${pkgs.stdenv.hostPlatform.system}.default` to `home.packages`
(or `environment.systemPackages`), then rebuild. On macOS also run `harness-setup` on
home-manager activation (the Finder item "Harness" and Ghostty's settings). Upgrade with
`nix flake update harness` and a rebuild. Nodes as services: `nixosModules.default`
(docs/operations/nixos.md). Imperative alternative: `nix profile add github:thearchitect/harness`.

## After installing
- Act on the script's warnings, with the user's consent: another `harness` earlier on PATH;
  provider logins still only in `~/.pi/agent/auth.json` (harness reads `~/.harness`).
- Optional host settings: `HARNESS_BROWSER` (your own Chrome/Chromium executable, used
  instead of the bundled one by the `browser` and playwright servers),
  `HARNESS_BROWSER_USER_DATA_DIR` (its profile, for chromium-devtools), `HARNESS_HOME`.
- macOS: the script runs `harness-setup`: right-click a folder in Finder → **Harness** opens
  harness in a new Ghostty window there (the first time macOS asks to allow controlling
  Ghostty). A Ghostty of the user's own (1.3 or later) is used instead of the bundled one.
- Verify: `harness --version`; `harness` opens the TUI.
