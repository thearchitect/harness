#!/usr/bin/env bash
# The event log of the hub or of a user's node (~/.harness/log/node-<name>.jsonl of its user),
# filtered locally with jq:
#
#   cage run @root - ./logs.sh [--node hub|NAME] [--since 24h|7d] [--event PREFIX]
#
# One JSON event per line: {at, event, ...}.
set -euo pipefail
: "${FLY_APP:?run through cage run with ops:fly.env}" "${FLY_API_TOKEN:?run through cage run with ops:fly.env}"

node="hub" since="24h" event=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --node) node="$2"; shift 2 ;;
    --since) since="$2"; shift 2 ;;
    --event) event="$2"; shift 2 ;;
    *) echo "usage: logs.sh [--node hub|NAME] [--since 24h|7d] [--event PREFIX]" >&2; exit 2 ;;
  esac
done
case "$since" in
  *h) seconds=$(( ${since%h} * 3600 )) ;;
  *d) seconds=$(( ${since%d} * 86400 )) ;;
  *) echo "logs.sh: --since takes hours (24h) or days (7d)" >&2; exit 2 ;;
esac
from="$(date -u -d "@$(( $(date +%s) - seconds ))" +%Y-%m-%dT%H:%M:%S)"
user="$([[ "$node" == hub ]] && echo harness || echo "$node")"
file="/data/home/$user/.harness/log/node-$node.jsonl"

flyctl ssh console -a "$FLY_APP" -q -C "sh -c 'cat $file.1 $file 2>/dev/null'" \
  | jq -c --arg from "$from" --arg event "$event" '
      select(.at >= $from)
      | select($event == "" or (.event | startswith($event)))'
