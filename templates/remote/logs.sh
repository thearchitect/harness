#!/usr/bin/env bash
# The gateway's journal (/data/gateway/log/YYYY-MM-DD.jsonl on the volume),
# filtered locally with jq:
#
#   cage run @root - ./logs.sh [--since 24h|7d] [--level info|warn|error] [--user NAME] [--kind PREFIX]
#
# One JSON event per line: {ts, level, kind, user?, chat?, agent?, dir?, ...}.
# Wakes a sleeping machine (ssh needs it running).
set -euo pipefail
: "${FLY_APP:?run through cage run with ops:fly.env}" "${FLY_API_TOKEN:?run through cage run with ops:fly.env}"

since="24h" level="" user="" kind=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --since) since="$2"; shift 2 ;;
    --level) level="$2"; shift 2 ;;
    --user) user="$2"; shift 2 ;;
    --kind) kind="$2"; shift 2 ;;
    *) echo "usage: logs.sh [--since 24h|7d] [--level info|warn|error] [--user NAME] [--kind PREFIX]" >&2; exit 2 ;;
  esac
done
case "$since" in
  *h) seconds=$(( ${since%h} * 3600 )) ;;
  *d) seconds=$(( ${since%d} * 86400 )) ;;
  *) echo "logs.sh: --since takes hours (24h) or days (7d)" >&2; exit 2 ;;
esac
from="$(date -u -d "@$(( $(date +%s) - seconds ))" +%Y-%m-%dT%H:%M:%S)"
days=$(( seconds / 86400 + 1 ))

machine="$(flyctl machine list -a "$FLY_APP" --json | jq -r '.[0].id')"
flyctl machine start "$machine" -a "$FLY_APP" >/dev/null 2>&1 || true
files="$(for i in $(seq "$days" -1 0); do printf '/data/gateway/log/%s.jsonl ' "$(date -u -d "-$i day" +%F)"; done)"
flyctl ssh console -a "$FLY_APP" -q -C "sh -c 'cat $files 2>/dev/null'" \
  | jq -c --arg from "$from" --arg level "$level" --arg user "$user" --arg kind "$kind" '
      select(.ts >= $from)
      | select($level == "" or .level == $level)
      | select($user == "" or .user == $user)
      | select($kind == "" or (.kind | startswith($kind)))'
