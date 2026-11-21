# Shared by harness-open and harness-setup (sourced).

# own_ghostty: the path of the user's own Ghostty.app, or nothing. A Ghostty of
# the user's own wins over the bundled one: both share the bundle id
# com.mitchellh.ghostty (configuration, defaults, LaunchServices), so the user
# keeps one Ghostty, and their own updates itself.
own_ghostty() {
  local candidate
  for candidate in /Applications/Ghostty.app "$HOME/Applications/Ghostty.app"; do
    if [[ -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    else
      : # not installed there
    fi
  done
  return 0
}
