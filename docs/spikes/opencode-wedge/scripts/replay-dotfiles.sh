#!/usr/bin/env bash
# Replays the dotfiles spike script (scripts/dotfiles-opencode_probe.sh, an unmodified copy of
# dotfiles docs/factory/spikes/06-telemetry/scripts/opencode_probe.sh) against the installed 2.0.32.
#   replay-dotfiles.sh verbatim|nowatch [n]
# `nowatch` is the same script with ONE line changed: OPENCODE_DISABLE_FILEWATCHER=1 added to its `env -i` list.
# The script's own ClickHouse read-back (ClickStack is not running) fails at the end and is ignored.
# The script's EXIT trap sends SIGTERM only, which a watcher-on server takes ~30+ s to honour; this wrapper SIGKILLs the pid afterwards.
set -uo pipefail
MODE="${1:?verbatim|nowatch}"; N="${2:-1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/dotfiles-opencode_probe.sh"
SCRIPT="$SRC"
if [[ "$MODE" == nowatch ]]; then
  SCRIPT="${TMPDIR:-/tmp}/ocw-dotfiles-nowatch.sh"
  sed 's|OPENCODE_SERVER_PASSWORD="\$PW"|OPENCODE_DISABLE_FILEWATCHER=1 OPENCODE_SERVER_PASSWORD="$PW"|' "$SRC" > "$SCRIPT"
  cmp -s "$SRC" "$SCRIPT" && { echo "patch did not apply" >&2; exit 1; }
fi
for i in $(seq 1 "$N"); do
  export SPIKE_SCRATCH="${TMPDIR:-/tmp}/ocw-dotfiles-$MODE-$i"
  start=$(date +%s)
  out=$(cd "${TMPDIR:-/tmp}" && timeout 150 bash "$SCRIPT" 2a8b0929528fac02dc21af4749e7ebb3 f881b2a0f881b2a0 --session 2>&1 | grep -E '^(prompt|wait|messages|session):' | tr '\n' ' ')
  secs=$(( $(date +%s) - start ))
  pid="$(cat "$SPIKE_SCRATCH/run/opencode/server.pid" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -KILL "$pid" 2>/dev/null
  printf '%s #%s: %s(%ss)\n' "$MODE" "$i" "$out" "$secs"
  rm -rf "$SPIKE_SCRATCH"
done
