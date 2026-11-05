#!/bin/sh
# run-step.sh <working-directory> <idle-seconds> <command> [slot]
#
# Runs <command> (a shell command line) in <working-directory> under an idle watchdog: it is killed only after
# <idle-seconds> without a new byte of output, never on elapsed time. Prints the last 200 lines of output, then one
# marker line, and exits with the command's exit code (124 when the watchdog killed it).
# With a fourth argument `slot` (the heavy steps: typecheck, tests) and `factory` on PATH, the command runs inside
# `factory slot run`, the machine's shared test slots, with test-runner workers capped to half the cores. The wait for a
# slot writes nothing, so the idle window grows by FACTORY_SLOT_WAIT_MS (default 45 min). No slot within that wait is
# `run-step: MACHINE_BUSY` and exit 75: the command did not run, which is not a failure of the repo.
# The group kill below needs job control (`set -m`) and `kill -- -PGID`; dash (Debian/Ubuntu `sh`) has neither without a
# tty, so the kill would silently reach nothing. Run under bash wherever this was started from.
[ -n "$BASH_VERSION" ] || exec bash "$0" "$@"
dir=$1
idle=$2
cmd=$3
slot=$4
if [ -z "$dir" ] || [ -z "$idle" ] || [ -z "$cmd" ]; then
  echo "usage: run-step.sh <working-directory> <idle-seconds> <command> [slot]"
  exit 2
fi
cd "$dir" || { echo "run-step: cannot enter $dir"; exit 127; }

slotted=0
if [ "$slot" = slot ] && command -v factory >/dev/null 2>&1; then
  slotted=1
  repo=$(basename "$(printf '%s' "$PWD" | sed 's|/\.claude/worktrees/.*||')")
  cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)
  workers=$((cores / 2))
  [ "$workers" -ge 1 ] || workers=1
  export VITEST_MAX_WORKERS=$workers
  wait_ms=${FACTORY_SLOT_WAIT_MS:-2700000}
  case $wait_ms in '' | *[!0-9]*) wait_ms=2700000 ;; esac
  idle=$((idle + wait_ms / 1000))
fi

out=$(mktemp) || exit 127
trap 'rm -f "$out"' EXIT
set -m # the command leads its own process group, so the kill below reaches what it started
if [ "$slotted" -eq 1 ]; then
  factory slot run --name "agw-check:$repo" -- sh -c "$cmd" >"$out" 2>&1 </dev/null &
else
  sh -c "$cmd" >"$out" 2>&1 </dev/null &
fi
pid=$!
last=-1
stalled=0
killed=0
while kill -0 "$pid" 2>/dev/null; do
  sleep 1
  size=$(wc -c <"$out")
  if [ "$size" != "$last" ]; then
    last=$size
    stalled=0
  else
    stalled=$((stalled + 1))
  fi
  if [ "$stalled" -ge "$idle" ]; then
    kill -9 -- "-$pid" 2>/dev/null
    kill -9 "$pid" 2>/dev/null
    killed=1
    break
  fi
done
wait "$pid" 2>/dev/null
code=$?
tail -n 200 "$out"
if [ "$killed" -eq 1 ]; then
  echo "run-step: IDLE_TIMEOUT no output for ${idle}s"
  exit 124
fi
if [ "$slotted" -eq 1 ] && [ "$code" -eq 75 ] && grep -q 'factory: no test slot within' "$out"; then
  echo "run-step: MACHINE_BUSY no test slot, the command did not run"
  exit 75
fi
echo "run-step: exit $code"
exit "$code"
