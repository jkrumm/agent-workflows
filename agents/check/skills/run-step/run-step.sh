#!/bin/sh
# run-step.sh <working-directory> <idle-seconds> <command>
#
# Runs <command> (a shell command line) in <working-directory> under an idle watchdog: it is killed only after
# <idle-seconds> without a new byte of output, never on elapsed time. Prints the last 200 lines of output, then one
# marker line, and exits with the command's exit code (124 when the watchdog killed it).
# The group kill below needs job control (`set -m`) and `kill -- -PGID`; dash (Debian/Ubuntu `sh`) has neither without a
# tty, so the kill would silently reach nothing. Run under bash wherever this was started from.
[ -n "$BASH_VERSION" ] || exec bash "$0" "$@"
dir=$1
idle=$2
cmd=$3
if [ -z "$dir" ] || [ -z "$idle" ] || [ -z "$cmd" ]; then
  echo "usage: run-step.sh <working-directory> <idle-seconds> <command>"
  exit 2
fi
cd "$dir" || { echo "run-step: cannot enter $dir"; exit 127; }

out=$(mktemp) || exit 127
trap 'rm -f "$out"' EXIT
set -m # the command leads its own process group, so the kill below reaches what it started
sh -c "$cmd" >"$out" 2>&1 </dev/null &
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
echo "run-step: exit $code"
exit "$code"
