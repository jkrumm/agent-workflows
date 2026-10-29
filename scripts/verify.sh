#!/bin/zsh
# agent-workflows verify (`make verify`): exit 0 only if the deployed host is healthy, runs origin/master, and a real
# `agw smoke ping` (the installed CLI, the real bearer) produced a done run with a trace id and priced usage in the
# journal, and a direct `agw llm title` call left a done `cap.llm.title` run with priced usage. The audio process must be
# healthy at the same sha, `agw audio ping` (routed to it by AGW_PROCESSES) must leave a done run, and its door must
# refuse an unauthenticated request (401) and answer an authenticated one with a bad body with the legacy 400.
# Prints the run ids.

set -u

ROOT="${AGW_ROOT:-$HOME/.agent-workflows}"
REPO_DIR="$ROOT/repo"
SHA_FILE="$ROOT/data/deployed-sha"
HEALTH_URL="http://127.0.0.1:7791/health"
AUDIO_URL="http://127.0.0.1:7792"
API_SECRET_REF="op://mini/agent-workflows/API_SECRET"
PG_PASSWORD_REF="op://mini/vps-dev/AGENT_WORKFLOWS_DB_PASSWORD"
SCHEMA="${AGW_PG_SCHEMA:-agw}"

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

fail() { print -u2 "verify: FAIL: $*"; exit 1; }
ok() { print "verify: ok: $*"; }

for tool in git curl jq psql secrets-run agw; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool not found on PATH"
done

# 1. health
health=$(curl -fsS --max-time 5 "$HEALTH_URL") || fail "no answer from $HEALTH_URL"
[[ "$(print -r -- "$health" | jq -r '.status')" == "ok" ]] || fail "/health is not ok: $health"
version=$(print -r -- "$health" | jq -r '.version')
ok "/health ok (version ${version[1,12]})"
# The friction job's state is informational: it is printed, never a failure (an older host reports none).
friction=$(print -r -- "$health" | jq -r '.friction.state // "not reported"')
print "verify: info: friction job: $friction"

# 2. the deployed build is origin/master, and it is the one serving
deployed=$(cat "$SHA_FILE" 2>/dev/null) || fail "$SHA_FILE missing: nothing was deployed"
remote=$(git -C "$REPO_DIR" ls-remote origin refs/heads/master | awk '{print $1}')
[[ -n "$remote" ]] || fail "cannot read origin/master from $REPO_DIR (run make deploy first)"
[[ "$deployed" == "$remote" ]] || fail "deployed ${deployed[1,12]} is not origin/master ${remote[1,12]}"
[[ "$version" == "$deployed" ]] || fail "the running host reports ${version[1,12]}, deployed is ${deployed[1,12]}"
ok "deployed sha is origin/master (${deployed[1,12]})"

password=$(secrets-run read "$PG_PASSWORD_REF" 2>/dev/null)
[[ -n "$password" ]] || fail "cannot read $PG_PASSWORD_REF through secrets-run"
psql_err=$(mktemp -t agw-verify) || fail "cannot create a temp file"
agw_err=$(mktemp -t agw-verify) || fail "cannot create a temp file"
trap 'rm -f "$psql_err" "$agw_err"' EXIT
# One journal query; the SQL goes on stdin (psql interpolates :'var' there, not in -c), extra args are -v bindings.
journal() {
  local sql=$1; shift
  PGPASSWORD="$password" psql -h 127.0.0.1 -U agent_workflows -d agent_workflows -AtF '|' -v ON_ERROR_STOP=1 "$@" \
    2>"$psql_err" <<< "$sql" || fail "journal query failed: $(<"$psql_err")"
}

# 3. a real run through the installed CLI. The answer is the JSON on stdout; stderr is kept apart and shown on failure.
# `out` is set by agw_json: a non-zero exit or output that is not JSON is its own failure, not a missing field.
agw_json() {
  out=$(AGW_PURPOSE=verify agw "$@" 2>"$agw_err")
  local rc=$?
  (( rc == 0 )) || fail "agw $* exited $rc: ${out:-$(<"$agw_err")}"
  print -r -- "$out" | jq -e . >/dev/null 2>&1 || fail "agw $* printed output that is not JSON: $out $(<"$agw_err")"
}
agw_json smoke ping
run_id=$(print -r -- "$out" | jq -r '.runId // empty' 2>/dev/null)
title=$(print -r -- "$out" | jq -r '.output.title // empty' 2>/dev/null)
[[ -n "$run_id" ]] || fail "agw smoke ping printed no runId: $out"
[[ -n "$title" ]] || fail "run $run_id has no output title: $out"
ok "agw smoke ping: run $run_id, title \"$title\""

# 4. its row in the journal: the run answer holds up to 5 s for the run record. One slow runPost or a database blip
# can outlast that (`costPending`), so ask again, 4 times 5 s plus a pause, before calling it a failure.
for attempt in {1..4}; do
  [[ "$(print -r -- "$out" | jq -r '.costPending // false')" == "true" ]] || break
  sleep 2
  agw_json run wait "$run_id"
done
[[ "$(print -r -- "$out" | jq -r '.recordFailed // false')" == "false" ]] || fail "run $run_id: the runtime gave up on its post hooks (recordFailed): $out"
[[ "$(print -r -- "$out" | jq -r '.costPending // false')" == "false" ]] || fail "run $run_id has no run record after ~30 s (costPending): $out"
answer_cost=$(print -r -- "$out" | jq -r '.cost // empty' 2>/dev/null)
[[ -n "$answer_cost" ]] && (( answer_cost > 0 )) || fail "run $run_id answered without priced usage (cost '${answer_cost:-null}'): $out"
row=$(journal "select status, coalesce(trace_id, ''), coalesce(cost::text, ''), coalesce(tokens_input, 0) from \"$SCHEMA\".runs where id = :'id'" -v "id=$run_id") || exit 1
IFS='|' read -r run_status trace cost tokens <<< "$row"
[[ "${run_status:-}" == "done" ]] || fail "run $run_id is '${run_status:-missing}' in $SCHEMA.runs, not done"
[[ -n "${trace:-}" ]] || fail "run $run_id has no trace id"
[[ -n "${cost:-}" ]] && (( cost > 0 )) || fail "run $run_id has no priced usage (cost '${cost:-null}')"
# the answer prints a JSON number, the journal a numeric: the same value to a relative 1e-6, not the same text
awk -v a="$answer_cost" -v b="$cost" 'BEGIN { d = a - b; if (d < 0) d = -d; m = (a > b ? a : b); exit !(d <= m * 1e-6) }' \
  || fail "run $run_id: the answer's cost $answer_cost differs from the journal's $cost"
(( ${tokens:-0} > 0 )) || fail "run $run_id recorded no input tokens"
ok "journal: done, trace $trace, cost $cost (as answered), $tokens input tokens"

# 5. a direct capability call is a run of its own (cap.<id>), recorded like any other
since=$(journal "select now()") || exit 1
out=$(AGW_PURPOSE=verify agw llm title "make verify checks that a direct capability call is recorded" 2>&1)
rc=$?
(( rc == 0 )) || fail "agw llm title exited $rc: $out"
[[ -n "$out" ]] || fail "agw llm title printed no title"
ok "agw llm title: \"$out\""
cap_rows=()
for _ in {1..20}; do
  cap_rows=("${(@f)$(journal "select id, status, coalesce(cost::text, ''), coalesce(tokens_input, 0) from \"$SCHEMA\".runs where workflow = 'cap.llm.title' and purpose = 'verify' and created_at >= :'since'::timestamptz order by id" -v "since=$since")}") || exit 1
  cap_rows=(${cap_rows:#})
  (( ${#cap_rows} > 1 )) && fail "expected one cap.llm.title verify run since $since, found ${#cap_rows}: ${(j:, :)${(@)cap_rows%%|*}}"
  IFS='|' read -r cap_id cap_status cap_cost cap_tokens <<< "${cap_rows[1]:-}"
  [[ "${cap_status:-}" == "done" && -n "${cap_cost:-}" ]] && break
  sleep 1
done
[[ -n "${cap_id:-}" ]] || fail "agw llm title left no cap.llm.title run in $SCHEMA.runs"
[[ "${cap_status:-}" == "done" ]] || fail "cap.llm.title run $cap_id is '${cap_status:-missing}', not done"
[[ -n "${cap_cost:-}" ]] && (( cap_cost > 0 )) || fail "cap.llm.title run $cap_id has no priced usage (cost '${cap_cost:-null}')"
(( ${cap_tokens:-0} > 0 )) || fail "cap.llm.title run $cap_id recorded no input tokens"
ok "journal: cap.llm.title run $cap_id done, cost $cap_cost, $cap_tokens input tokens"

# 6. the audio process: the same release, a run recorded through the CLI's process routing, and the door's auth
audio_health=$(curl -fsS --max-time 5 "$AUDIO_URL/health") || fail "no answer from $AUDIO_URL/health"
[[ "$(print -r -- "$audio_health" | jq -r '.status + " " + .version')" == "ok $deployed" ]] \
  || fail "audio /health is not ok at ${deployed[1,12]}: $audio_health"
ok "audio /health ok (version ${deployed[1,12]})"

agw_json audio ping
audio_run=$(print -r -- "$out" | jq -r '.runId // empty' 2>/dev/null)
[[ -n "$audio_run" && "$(print -r -- "$out" | jq -r '.output.pong // empty')" == "true" ]] || fail "agw audio ping did not answer pong: $out"
audio_status=$(journal "select status from \"$SCHEMA\".runs where id = :'id' and workflow = 'audio.ping'" -v "id=$audio_run") || exit 1
[[ "$audio_status" == "done" ]] || fail "audio.ping run $audio_run is '${audio_status:-missing}' in $SCHEMA.runs, not done"
ok "agw audio ping: run $audio_run done"

door_status=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  --data '{}' "$AUDIO_URL/v1/audio/speech") || fail "no answer from the door"
[[ "$door_status" == "401" ]] || fail "an unauthenticated door request got $door_status, not 401"
secret=$(secrets-run read "$API_SECRET_REF" 2>/dev/null)
[[ -n "$secret" ]] || fail "cannot read $API_SECRET_REF through secrets-run"
# The bearer goes through curl's config on stdin, never the command line (ps would show it).
door_body=$(mktemp -t agw-verify) || fail "cannot create a temp file"
trap 'rm -f "$psql_err" "$agw_err" "$door_body"' EXIT
door_status=$(print -r -- "header = \"authorization: Bearer $secret\"" | curl -sS --max-time 30 -K - -o "$door_body" \
  -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'x-agw-purpose: verify' --data '{}' \
  "$AUDIO_URL/v1/audio/speech") || fail "no answer from the door"
[[ "$door_status" == "400" ]] || fail "an authenticated door request with a bad body got $door_status, not 400: $(<"$door_body")"
[[ "$(jq -r '.error.type // empty' "$door_body" 2>/dev/null)" == "invalid_request_error" ]] \
  || fail "the door's 400 is not the legacy envelope: $(<"$door_body")"
ok "door: 401 without a caller token, legacy 400 on a bad body"

print "verify: PASS run $run_id, cap run $cap_id, audio run $audio_run"
