#!/usr/bin/env bash
# Exports the bundle's store paths that cache.nixos.org does not have as a
# signed, flat binary cache directory (CI; see .github/workflows):
#   SIGNING_KEY=<secret key> nix/cache-export.sh <result> <out-dir>
#
# The layout is flat (narinfo URL fields point at sibling files, no nar/
# subdirectory) because the cache is served from GitHub release assets, whose
# names cannot contain '/'. The URL field is not covered by the signature.
set -euo pipefail

# A store path, not a flake reference (`nix path-info result` would look up a flake).
RESULT="$(readlink -f "$1")"
OUT="$2"
mkdir -p "$OUT"

if [[ -z "${SIGNING_KEY-}" ]]; then
  echo "::warning::NIX_CACHE_SIGNING_KEY is not set: binary cache export skipped (users will build locally)"
  exit 0
fi

keyfile="$(mktemp)"
trap 'rm -f "$keyfile"' EXIT
printf '%s' "$SIGNING_KEY" >"$keyfile"

paths=()
while read -r path; do
  nix path-info --store https://cache.nixos.org "$path" >/dev/null 2>&1 || paths+=("$path")
done < <(nix path-info --recursive "$RESULT")
echo "exporting ${#paths[@]} store paths not in cache.nixos.org"

nix store sign --key-file "$keyfile" "${paths[@]}"
nix copy --to "file://$(cd "$OUT" && pwd)?compression=zstd" "${paths[@]}"

if [[ -d "$OUT/nar" ]]; then
  mv "$OUT"/nar/* "$OUT"/
  rmdir "$OUT/nar"
fi
for f in "$OUT"/*.narinfo; do
  sed 's|^URL: nar/|URL: |' "$f" >"$f.tmp" && mv "$f.tmp" "$f"
done
rm -rf "$OUT/log" "$OUT/realisations"
ls -la "$OUT"
