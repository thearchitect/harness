#!/usr/bin/env bash
# Builds the image of the committed tree and deploys it:
#   cage run @root - ./deploy.sh        (operator, inside `nix develop`)
#   cage run @ci-deploy - ./deploy.sh   (CI)
# Needs FLY_APP and FLY_API_TOKEN (ops:fly.env).
set -euo pipefail
cd "$(dirname "$0")"
: "${FLY_APP:?run through cage run with ops:fly.env}" "${FLY_API_TOKEN:?run through cage run with ops:fly.env}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "deploy: the tree has uncommitted changes; commit them first" >&2
  exit 1
fi
tag="$(git rev-parse --short HEAD)"
image="registry.fly.io/$FLY_APP:$tag"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

nix build .#image -o "$work/image"
"$work/image" >"$work/image.tar"
printf '%s' "$FLY_API_TOKEN" | skopeo login --authfile "$work/auth.json" -u x --password-stdin registry.fly.io
skopeo copy --dest-authfile "$work/auth.json" "docker-archive:$work/image.tar" "docker://$image"
flyctl deploy -a "$FLY_APP" --image "$image"
