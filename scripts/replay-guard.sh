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

# macOS has no setsid; perl's setpgrp gives the run its own process group so
# the watchdog can kill every shard with one signal.
perl -e 'setpgrp(0,0); exec @ARGV or die $!' pnpm tsx scripts/replay-orders.ts "$@" &
PGID=$!

# Two stops: a wall-clock deadline, and the session's five-hour rate limit.
# The limit is the one that matters — once Claude Code is cut off nobody can
# stop the shards, and they keep spending API balance until it resets. The
# status line is the only place that figure appears, so statusline-command.sh
# writes it to /tmp/claude-rate-limit-pct on every render and this reads it.
KILL_AT_PCT="${REPLAY_KILL_AT_PCT:-90}"
PCT_FILE=/tmp/claude-rate-limit-pct

stop_run() {
  echo "[replay-guard] $1 — killing process group $PGID" >&2
  kill -TERM -"$PGID" 2>/dev/null
  sleep 10
  kill -KILL -"$PGID" 2>/dev/null
}

(
  DEADLINE=$(( $(date +%s) + MINUTES * 60 ))
  while kill -0 "$PGID" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
      stop_run "${MINUTES}m deadline hit"
      break
    fi
    if [ -r "$PCT_FILE" ]; then
      PCT=$(cat "$PCT_FILE" 2>/dev/null)
      case "$PCT" in
        ''|*[!0-9.]*) ;;
        *)
          if [ "$(printf '%.0f' "$PCT" 2>/dev/null || echo 0)" -ge "$KILL_AT_PCT" ]; then
            stop_run "session rate limit at ${PCT}% (>= ${KILL_AT_PCT}%)"
            break
          fi
          ;;
      esac
    fi
    sleep 20
  done
) &
WATCHDOG=$!

wait "$PGID"
STATUS=$?
kill "$WATCHDOG" 2>/dev/null
exit "$STATUS"
