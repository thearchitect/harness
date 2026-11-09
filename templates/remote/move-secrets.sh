#!/usr/bin/env bash
# Moves secrets a user set in Telegram (/secrets: their ~/.cage on the server)
# into this repository's cage (<name>:user.env, env user-<name>), commits and
# pushes; CI deploys. The gateway of the new deployment removes the moved
# names from the user's own store before any of their agents starts: a
# variable lives in one place at a time.
#
#   cage run @root - ./move-secrets.sh <name> [KEY...]     (inside `nix develop`)
#
# Without KEYs every variable of the user's store moves. Values go from the
# server straight into `cage import`: never to the terminal, a file or a log.
set -euo pipefail
cd "$(dirname "$0")"
: "${FLY_APP:?run through cage run with ops:fly.env}" "${FLY_API_TOKEN:?run through cage run with ops:fly.env}"
name="${1:?usage: move-secrets.sh <name> [KEY...]}"
shift
keys=("$@")
file="$name:user.env"
home="/data/home/$name"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "move-secrets: the tree has uncommitted changes; commit them first" >&2
  exit 1
elif ! yq -e ".users[] | select(.name == \"$name\")" remote.yaml >/dev/null; then
  echo "move-secrets: $name is not a user of remote.yaml" >&2
  exit 1
elif ! yq -e ".envs.\"user-$name\"" .cage/cage.yaml >/dev/null; then
  echo "move-secrets: .cage/cage.yaml has no env user-$name" >&2
  exit 1
else
  : # a configured user with a deployment env
fi
for key in "${keys[@]}"; do
  [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || { echo "move-secrets: $key is not a variable name" >&2; exit 1; }
done

# The machine sleeps when idle; ssh needs it running.
machine="$(flyctl machine list -a "$FLY_APP" --json | jq -r '.[0].id')"
flyctl machine start "$machine" -a "$FLY_APP" >/dev/null 2>&1 || true

# The user's store, decrypted by the user's own process on the server, keys
# filtered there: KEY=VALUE lines into cage import (which creates the file).
filter="cat"
if [[ ${#keys[@]} -gt 0 ]]; then
  filter="grep -E '^($(IFS='|'; echo "${keys[*]}"))='"
fi
# The script travels base64-encoded: no quoting survives ssh, sh and setpriv intact.
script="$(printf 'exec setpriv --reuid=%s --regid=%s --clear-groups env -i HOME=%s PATH=/bin sh -c %q' "$name" "$name" "$home" "cd \"\$HOME\" && cage dump -o /dev/stdout @harness | $filter" | base64 -w0)"
cage import "$file" - flyctl ssh console -a "$FLY_APP" -q -C "sh -c 'echo $script | base64 -d | sh'"

# The env of the user's agents carries the file from now on.
if ! yq -e ".envs.\"user-$name\".files[] | select(. == \"$file\")" .cage/cage.yaml >/dev/null; then
  yq -i ".envs.\"user-$name\".files += [\"$file\"]" .cage/cage.yaml
  cage encrypt
else
  : # listed already (an earlier move)
fi

moved="$(cage inspect "$file" | awk 'NR > 1 { print $2 }' | paste -sd, -)"
git add .cage
git commit -qm "secrets of $name moved to the deployment: $moved"
git push -q
echo "moved: $moved; the deploy removes them from $name's own store"
