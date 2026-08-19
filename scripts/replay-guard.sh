#!/usr/bin/env bash
# Runs the replay under a hard wall-clock deadline in its own process group,
# so a run can never outlive the session that launched it. If Claude Code hits
# its usage limit mid-round nobody is left to stop the shards, and each one
# keeps spending DeepSeek balance until the limit resets.
#
#   scripts/replay-guard.sh <minutes> [replay-orders.ts args...]
set -uo pipefail

MINUTES="${1:?usage: replay-guard.sh <minutes> [args...]}"
shift

setsid pnpm tsx scripts/replay-orders.ts "$@" &
PGID=$!

(
  sleep $((MINUTES * 60))
  if kill -0 "$PGID" 2>/dev/null; then
    echo "[replay-guard] ${MINUTES}m deadline hit — killing process group $PGID" >&2
    kill -TERM -"$PGID" 2>/dev/null
    sleep 10
    kill -KILL -"$PGID" 2>/dev/null
  fi
) &
WATCHDOG=$!

wait "$PGID"
STATUS=$?
kill "$WATCHDOG" 2>/dev/null
exit "$STATUS"
