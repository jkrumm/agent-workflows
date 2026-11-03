#!/bin/zsh
# The nightly review-ground-truth labelling job (LaunchAgent com.jkrumm.agent-workflows-eval-mine, `make eval-mine-job`):
# `agw eval mine review --auto --yes` sizes the run itself (eval credit, IU line, bug-case target; packages/eval/README.md
# §Ground truth miner), this script starts it under a per-day idempotency key, waits for it, and appends one line to
# ~/Library/Logs/agent-workflows-eval-mine.log. A second trigger on the same UTC day adopts the same run. At the target
# (state target-reached) the job removes its own LaunchAgent, so it never runs again.
#
# Runs from ~/.agent-workflows/current/scripts/ with launchd's minimal environment. Exit 0: the run is done (whatever its
# state: no-credit and iu-line are normal nights). Non-zero: the run failed or the host could not be asked, one log line says why.

set -euo pipefail

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

LABEL="com.jkrumm.agent-workflows-eval-mine"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/agent-workflows-eval-mine.log"
# The wait for a run that outlives the night: the run itself is never cancelled, only this script stops waiting.
WAIT_LIMIT_S="${EVAL_MINE_WAIT_LIMIT_S:-10800}"
EXIT_PENDING=10

mkdir -p "${LOG:h}"
log() { print -r -- "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }
fail() { log "FAILED: $*"; print -u2 "eval-mine-daily: $*"; exit 1; }

for tool in agw jq; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool not found on PATH ($PATH)"
done

key="eval-mine-daily-$(date -u +%Y-%m-%d)"
errfile="$(mktemp -t eval-mine-daily)"
trap 'rm -f "$errfile"' EXIT

# One agw call: stdout is the run's JSON state; the exit code is agw's (10: still running).
rc=0
out="$(AGW_PURPOSE=eval agw eval mine review --auto --yes --commit --format json --idempotency-key "$key" 2>"$errfile")" || rc=$?

deadline=$(( SECONDS + WAIT_LIMIT_S ))
while (( rc == EXIT_PENDING )); do
  run_id="$(print -r -- "$out" | jq -r '.runId // empty' 2>/dev/null || true)"
  [[ -n "$run_id" ]] || fail "agw said pending but printed no run id: $(head -c 300 "$errfile")"
  (( SECONDS < deadline )) || fail "run $run_id still going after ${WAIT_LIMIT_S}s; it keeps running (agw run wait $run_id)"
  rc=0
  out="$(agw run wait "$run_id" --format json 2>"$errfile")" || rc=$?
done

# The state of the run, when agw printed one (a failed run prints its state and exits 1).
run_status="$(print -r -- "$out" | jq -r '.status // empty' 2>/dev/null || true)"
run_id="$(print -r -- "$out" | jq -r '.runId // empty' 2>/dev/null || true)"
if (( rc != 0 )) || [[ "$run_status" != "done" ]]; then
  reason="$(print -r -- "$out" | jq -r '.error.message // empty' 2>/dev/null || true)"
  [[ -n "$reason" ]] || reason="$(tail -n 1 "$errfile" | head -c 400)"
  fail "agw exit $rc, run ${run_id:-none} status ${run_status:-unknown}: ${reason:-no reason given}"
fi

state="$(print -r -- "$out" | jq -r '.output.auto.state // empty')"
[[ -n "$state" ]] || fail "run $run_id is done but its output has no auto record: $(print -r -- "$out" | head -c 300)"

line="$(print -r -- "$out" | jq -r '
  .output as $o | $o.auto as $a
  | def usd: if . == null then "n/a" else (. * 1000 | round / 1000 | tostring) end;
    "bug cases \($a.bugCasesAfter)/\($a.target) (dev \($o.summary.cases.dev.bug), test \($o.summary.cases.test.bug))"
    + "; labelled \($o.labelledThisRun) (+\($o.thirdSeatThisRun) third seat), accepted +\($a.bugCasesAfter - $a.bugCasesBefore)"
    + "; credit available \($a.creditAvailableUsd | usd), run cost \(.cost | usd)"
    + "; IU \($a.iuSpentUsd | usd) of \($a.iuLineUsd | usd) before the run"
    + "; planned \($a.planned); state \($a.state)"
    + (if $o.stopped then "; stopped: \($o.stopped | .[0:120])" else "" end)
    + "; run \(.runId)"')"
log "$line"

if [[ "$state" == "target-reached" ]]; then
  log "target reached: removing $LABEL"
  rm -f "$PLIST"
  # Last: bootout ends this very job's process.
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
fi
