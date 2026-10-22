---
name: install-harness
description: Install or upgrade the harness pi bundle (pi + harness extension + pi packages + MCP tools) on NixOS, Linux or macOS.
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
(or `environment.systemPackages`) and the binary cache (otherwise Nix builds locally):

    nix.settings.extra-substituters = [ "https://github.com/thearchitect/harness/releases/download/nix-cache" ];
    nix.settings.extra-trusted-public-keys = [ "harness-1:YE1emDZFHptBwqvSGZIoVkGgCUwvCrBxoMFA+zps0Dg=" ];

then rebuild. Upgrade with
`nix flake update harness` and a rebuild. Imperative alternative:
`nix profile add github:thearchitect/harness`.

## After installing
- Act on the script's warnings, with the user's consent: an older `pi` earlier on PATH,
  harness-bundled packages still in `~/.pi/agent/settings.json`, an old
  `~/.pi/agent/extensions/harness` checkout.
- Optional host settings: `HARNESS_BROWSER` (browser executable) and
  `HARNESS_BROWSER_USER_DATA_DIR` (its profile) for the playwright / chromium-devtools servers.
- Verify: `pi --version`; inside pi, `/deps` lists the bundled versions.
