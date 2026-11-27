#!/usr/bin/env bash
# The hub's event log (~/.harness/log/node-default.jsonl of its user), filtered locally with jq:
#
#   cage run @root - ./logs.sh [--since 24h|7d] [--event PREFIX]
#
# One JSON event per line: {at, event, ...}.
set -euo pipefail
: "${FLY_APP:?run through cage run with ops:fly.env}" "${FLY_API_TOKEN:?run through cage run with ops:fly.env}"

since="24h" event=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --since) since="$2"; shift 2 ;;
    --event) event="$2"; shift 2 ;;
    *) echo "usage: logs.sh [--since 24h|7d] [--event PREFIX]" >&2; exit 2 ;;
  esac
done
case "$since" in
  *h) seconds=$(( ${since%h} * 3600 )) ;;
  *d) seconds=$(( ${since%d} * 86400 )) ;;
  *) echo "logs.sh: --since takes hours (24h) or days (7d)" >&2; exit 2 ;;
esac
from="$(date -u -d "@$(( $(date +%s) - seconds ))" +%Y-%m-%dT%H:%M:%S)"
file="$(yq -r '"/data/home/" + .user.name + "/.harness/log/node-default.jsonl"' remote.yaml)"

flyctl ssh console -a "$FLY_APP" -q -C "sh -c 'cat $file.1 $file 2>/dev/null'" \
  | jq -c --arg from "$from" --arg event "$event" '
      select(.at >= $from)
      | select($event == "" or (.event | startswith($event)))'
