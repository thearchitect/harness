#!@runtimeShell@
# harness-open [DIRECTORY...]: a new Ghostty window running harness (pi) in each
# directory (default: the current one); the window closes when pi exits. The
# Finder Quick Action "Harness" runs it with the selected folders.
set -euo pipefail
source @macosLib@

die() {
  printf 'harness-open: %s\n' "$*" >&2
  exit 1
}

# Absolute directories, checked before anything starts.
directories=()
for argument in "${@:-$PWD}"; do
  if [[ -d "$argument" ]]; then
    directories+=("$(cd "$argument" && pwd)")
  else
    die "not a directory: $argument"
  fi
done

# Ghostty: the user's own (AppleScript since 1.3), else the bundled one.
ghostty="$(own_ghostty)"
if [[ -z "$ghostty" ]]; then
  ghostty=@ghostty@
else
  version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ghostty/Contents/Info.plist")"
  IFS=. read -r major minor _ <<<"$version"
  if [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] && ((major < 1 || (major == 1 && minor < 3))); then
    die "$ghostty is Ghostty $version; harness needs Ghostty 1.3 or later: update it"
  else
    : # 1.3 or later, or a tip build (its version is a commit)
  fi
fi

# pi through the user's login shell, interactive: the PATH of their terminal
# (the projects' toolchains), not the bare one of GUI apps.
shell="$(dscl . -read "/Users/$(id -un)" UserShell)"
shell="${shell#UserShell: }"
if [[ -x "$shell" ]]; then
  printf -v command '%q -l -i -c %q' "$shell" "exec @pi@"
else
  die "no login shell for $(id -un) (dscl UserShell: $shell)"
fi

exec osascript @openScript@ "$ghostty" "$command" "${directories[@]}" >/dev/null
