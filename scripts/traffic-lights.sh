#!/usr/bin/env bash
#
# traffic-lights.sh — pose the Stream Deck traffic-light keys for a screenshot.
#
# A THROWAWAY DEBUG UTILITY. Not a shipped feature, and deliberately independent
# of the repo's TypeScript sources: it talks to the plugin's HTTP state server
# over the wire, exactly as the OpenCode plugin does.
#
# WHY REPEATING IS THE DEFAULT, NOT A CONVENIENCE
#
# The Stream Deck plugin runs a staleness sweeper (streamdeck/src/plugin.ts) that
# forces any instance silent for more than STALE_MS = 6000ms back to GREEN, so
# that a key is never stranded on a colour from a client that has gone away. That
# is correct behaviour, and it is exactly wrong for a screenshot: a script that
# posts once and exits has its keys yanked back to green within ~6 seconds, and
# the shot is ruined. So `hold` -- which re-posts every 2000ms, comfortably
# inside the window, and matching the plugin's own HEARTBEAT_MS -- is the default
# mode. `once` exists for smoke-testing the wiring, not for posing keys.
#
# REQUIRES: a POSIX shell with curl. On Windows, run under Git Bash or WSL.
# No jq; the JSON is built with printf.
#
# Wire contract (see shared/contract.ts and streamdeck/src/plugin.ts):
#   POST http://127.0.0.1:8765/state
#   Content-Type: application/json   <- mandatory, the server answers 415 without
#   {"instance": <non-negative int>, "state": "green"|"yellow"|"red"}
# `ts` and `seq` are accepted as diagnostics only and do not affect behaviour.

set -euo pipefail

# Mirrors shared/contract.ts, and honours the same env override names.
HOST="${OPENCODE_SD_HOST:-127.0.0.1}"
PORT="${OPENCODE_SD_PORT:-8765}"

RED_INSTANCE=1
YELLOW_INSTANCE=2
GREEN_INSTANCE=3
INTERVAL=2000
MODE=hold
COUNT=0
SHOW_HEADER=1

# The server's own sweep threshold, mirrored here only to warn about it.
readonly STALE_MS=6000

usage() {
  cat <<EOF
traffic-lights.sh — pose the traffic-light keys on a Stream Deck for a screenshot

USAGE
  traffic-lights.sh [options]

MODES
  --mode once     Post each state once and exit. Note: the plugin forces any
                  instance silent for ${STALE_MS}ms back to green, so keys posted this
                  way will revert to green within ~6s. For posing, use hold.
  --mode hold     Post all three states, then re-post every --interval ms until
                  Ctrl-C. DEFAULT, and what you want for a screenshot.
  --mode flash    Cycle red -> yellow -> green across the instances repeatedly.

OPTIONS
  --host <host>             default ${HOST}
  --port <port>             default ${PORT}
  --red-instance <n>        default ${RED_INSTANCE}
  --yellow-instance <n>     default ${YELLOW_INSTANCE}
  --green-instance <n>      default ${GREEN_INSTANCE}
  --interval <ms>           default ${INTERVAL}. Must stay below ${STALE_MS}.
  --count <n>               In hold/flash, exit after n cycles (0 = forever).
  --no-header               Silence the per-request status lines.
  -h, --help                This help.

EXAMPLES
  # Pose 3 keys and hold them while you compose the shot.
  scripts/traffic-lights.sh

  # Red on the first key only, repeating.
  scripts/traffic-lights.sh --red-instance 1 --yellow-instance 1 --green-instance 1

  # Cycle for an action shot, then stop on its own after 10 cycles.
  scripts/traffic-lights.sh --mode flash --count 10
EOF
}

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

need_value() {
  # $1 = flag name, $2 = number of remaining args
  [ "$2" -ge 2 ] || die "$1 needs a value"
}

is_uint() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host) need_value "$1" $#; HOST="$2"; shift 2 ;;
    --port) need_value "$1" $#; PORT="$2"; shift 2 ;;
    --red-instance) need_value "$1" $#; RED_INSTANCE="$2"; shift 2 ;;
    --yellow-instance) need_value "$1" $#; YELLOW_INSTANCE="$2"; shift 2 ;;
    --green-instance) need_value "$1" $#; GREEN_INSTANCE="$2"; shift 2 ;;
    --interval) need_value "$1" $#; INTERVAL="$2"; shift 2 ;;
    --count) need_value "$1" $#; COUNT="$2"; shift 2 ;;
    --mode) need_value "$1" $#; MODE="$2"; shift 2 ;;
    --no-header) SHOW_HEADER=0; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

for pair in "port:${PORT}" "red-instance:${RED_INSTANCE}" \
  "yellow-instance:${YELLOW_INSTANCE}" "green-instance:${GREEN_INSTANCE}" \
  "interval:${INTERVAL}" "count:${COUNT}"; do
  name="${pair%%:*}"
  value="${pair#*:}"
  is_uint "$value" || die "--${name} must be a non-negative integer, got '${value}'"
done

case "$MODE" in
  once | hold | flash) ;;
  *) die "--mode must be once, hold or flash, got '${MODE}'" ;;
esac

command -v curl >/dev/null 2>&1 || die "curl is required but was not found"

if [ "$INTERVAL" -ge "$STALE_MS" ]; then
  printf 'warning: --interval %sms is >= the plugin'"'"'s %sms staleness sweep.\n' \
    "$INTERVAL" "$STALE_MS" >&2
  printf '         The plugin will treat the client as gone and force the keys\n' >&2
  printf '         back to green mid-screenshot. Use something under %sms.\n' \
    "$STALE_MS" >&2
fi

URL="http://${HOST}:${PORT}/state"
SEQ=0

# Post one state to one instance. $3 = label for the status line.
post() {
  instance="$1"
  state="$2"
  SEQ=$((SEQ + 1))
  body="{\"instance\":${instance},\"state\":\"${state}\",\"ts\":$(date +%s000),\"seq\":${SEQ}}"

  if status=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "$URL" \
    -H 'Content-Type: application/json' \
    --data "$body" 2>/dev/null); then
    if [ "$SHOW_HEADER" -eq 1 ]; then
      printf '  instance %s -> %-6s  HTTP %s\n' "$instance" "$state" "$status"
    fi
    return 0
  fi

  # curl exits non-zero on a connection failure, so there is no status to read.
  printf '  instance %s -> %-6s  FAILED (is the Stream Deck plugin running on %s?)\n' \
    "$instance" "$state" "$URL" >&2
  return 1
}

# Ctrl-C should end hold/flash quietly, not as an error.
trap 'printf "\n"; exit 0' INT TERM

pose_all() {
  post "$RED_INSTANCE" red
  post "$YELLOW_INSTANCE" yellow
  post "$GREEN_INSTANCE" green
}

case "$MODE" in
  once)
    pose_all
    printf 'Posted once. The plugin will force these back to green in ~%ss.\n' \
      "$((STALE_MS / 1000))"
    ;;

  hold)
    printf 'Posing 3 keys against %s every %sms (Ctrl-C to stop)\n' "$URL" "$INTERVAL"
    printf 'Instance -> colour:  %s=red  %s=yellow  %s=green\n\n' \
      "$RED_INSTANCE" "$YELLOW_INSTANCE" "$GREEN_INSTANCE"
    cycle=0
    while :; do
      pose_all
      cycle=$((cycle + 1))
      [ "$COUNT" -gt 0 ] && [ "$cycle" -ge "$COUNT" ] && break
      sleep "$(awk "BEGIN {print $INTERVAL / 1000}")"
    done
    printf '\nDone, %s cycle(s).\n' "$cycle"
    ;;

  flash)
    printf 'Flashing across %s every %sms (Ctrl-C to stop)\n' "$URL" "$INTERVAL"
    cycle=0
    while :; do
      post "$RED_INSTANCE" red
      sleep "$(awk "BEGIN {print $INTERVAL / 1000}")"
      post "$YELLOW_INSTANCE" yellow
      sleep "$(awk "BEGIN {print $INTERVAL / 1000}")"
      post "$GREEN_INSTANCE" green
      cycle=$((cycle + 1))
      [ "$COUNT" -gt 0 ] && [ "$cycle" -ge "$COUNT" ] && break
    done
    printf '\nDone, %s cycle(s).\n' "$cycle"
    ;;
esac
