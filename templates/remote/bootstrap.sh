#!/usr/bin/env bash
# One-time (idempotent) setup of the Fly side, with the operator's own flyctl
# login (`flyctl auth login`), inside `nix develop`:
#   ./bootstrap.sh
# - the app (from fly.toml) and its volume;
# - the machine's cage identity as the Fly secret HARNESS_MACHINE_IDENTITY
#   (base64; fly.toml writes it to /run/harness/machine-identity);
# - a deploy token for CI and deploy.sh, stored with cage in ops:fly.env.
# No secret value is printed.
set -euo pipefail
cd "$(dirname "$0")"

app="$(sed -n 's/^app *= *"\(.*\)"/\1/p' fly.toml)"
region="$(sed -n 's/^primary_region *= *"\(.*\)"/\1/p' fly.toml)"
org="${FLY_ORG:-personal}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if flyctl status -a "$app" >/dev/null 2>&1; then
  echo "app $app exists"
else
  flyctl apps create "$app" --org "$org"
fi

if [[ "$(flyctl volumes list -a "$app" --json | jq length)" == 0 ]]; then
  flyctl volumes create data --size 10 --region "$region" -a "$app" --yes
else
  echo "volume exists"
fi

cage dump -o "$work/identity" ops:fly-machine-identity
printf 'HARNESS_MACHINE_IDENTITY=%s\n' "$(base64 -w0 <"$work/identity")" | flyctl secrets import --stage -a "$app" >/dev/null
echo "machine identity staged"

cage import ops:fly.env - sh -c "printf 'FLY_APP=%s\nFLY_API_TOKEN=%s\n' '$app' \"\$(flyctl tokens create deploy -a '$app')\""
echo "deploy token stored in ops:fly.env"
