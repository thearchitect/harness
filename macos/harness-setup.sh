#!@runtimeShell@
# harness-setup: the bundle's macOS integration. Run by install.sh, after an
# update from the panel and by a home-manager activation; idempotent.
#   - the Finder Quick Action "Harness" (~/Library/Services/Harness.workflow):
#     a copy, macOS does not reliably pick up symlinked services;
#   - Ghostty's self-update (Sparkle) off when the bundled Ghostty is the user's
#     only one: Nix updates it, Sparkle would overwrite the store. A Ghostty of
#     the user's own keeps its settings (they share the defaults domain).
set -euo pipefail
source @macosLib@

workflow=@workflow@
installed="$HOME/Library/Services/Harness.workflow"
if diff -r "$workflow" "$installed" >/dev/null 2>&1; then
  echo "Finder: the Harness Quick Action is up to date"
else
  mkdir -p "$HOME/Library/Services"
  rm -rf "$installed"
  cp -R "$workflow" "$installed"
  chmod -R u+w "$installed"
  /System/Library/CoreServices/pbs -flush
  echo "Finder: the Harness Quick Action is installed (right-click a folder → Harness)"
fi

own="$(own_ghostty)"
if [[ -z "$own" ]]; then
  for key in SUEnableAutomaticChecks SUAutomaticallyUpdate; do
    if defaults read com.mitchellh.ghostty "$key" >/dev/null 2>&1; then
      : # set already: the user's choice stands
    else
      defaults write com.mitchellh.ghostty "$key" -bool false
    fi
  done
  echo "Ghostty: the bundled one, self-update off (Nix updates it)"
else
  echo "Ghostty: your own, $own; its update settings are left as they are"
fi
