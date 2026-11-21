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

then rebuild. On macOS also run `harness-setup` on home-manager activation (the Finder item
"Harness" and Ghostty's settings; snippet in README.md "Install"). Upgrade with
`nix flake update harness` and a rebuild. Imperative alternative:
`nix profile add github:thearchitect/harness`.

## After installing
- Act on the script's warnings, with the user's consent: an older `pi` earlier on PATH,
  harness-bundled packages still in `~/.pi/agent/settings.json`, an old
  `~/.pi/agent/extensions/harness` checkout.
- Optional host settings: `HARNESS_BROWSER` (your own Chrome/Chromium executable, used
  instead of the bundled one by the `browser` and playwright servers) and
  `HARNESS_BROWSER_USER_DATA_DIR` (its profile, for chromium-devtools).
- The bundle puts `node`/`npm`/`npx`/`bun`/`bunx` on PATH at a low priority; to leave them
  out, install `packages.<system>.default.override { withRuntimes = false; }`.
- macOS: the script runs `harness-setup`: right-click a folder in Finder → **Harness** opens pi
  in a new Ghostty window there (the first time macOS asks to allow controlling Ghostty). A
  Ghostty of the user's own (1.3 or later) is used instead of the bundled one.
- Verify: `pi --version`; inside pi, `Ctrl+\` → *dependencies* lists the bundled versions.
