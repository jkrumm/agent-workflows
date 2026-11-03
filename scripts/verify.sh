#!/bin/zsh
# agent-workflows verify (`make verify`): exit 0 only if the deployed host is healthy, runs origin/master, and a real
# `agw smoke ping` (the installed CLI, the real bearer) produced a done run with a trace id and priced usage in the
# journal, and a direct `agw llm title` call left a done `cap.llm.title` run with priced usage. The audio process must be
# healthy at the same sha, `agw audio ping` (routed to it by AGW_PROCESSES) must leave a done run, and its door must
# refuse an unauthenticated request (401) and answer an authenticated one with a bad body with the legacy 400.
# The host's image door (/door/image/generate) must do the same: 401 without a token, the studio's 400 envelope on a bad body.
# The pinned OpenCode build of the deployed release must be installed (scripts/pins.sh check).
# The gateway must be healthy at the recorded build (data/gateway-build), and three real Haiku calls through it must behave
# and be recorded: a credit-pool call, the same call again that reads the cache, and a Claude-Code-shaped one that goes to
# IU; their `usage.records` rows (billing api_credit, api_credit, api_key/personal) and `usage.gateway_picks` rows must
# appear within 120 s. A fourth Haiku call with the `agw-opencode` door token (the token the host hands OpenCode)
# must land lane agw_workflow. agw holds no provider key, so the smoke run's and the cap.llm.title run's model calls are
# the gateway's: each run needs `source='gateway'` rows, every one qualifying (lane agw_workflow, workflow and step in
# lane_detail, a priced cost, billing api_credit on a pool /health names or api_key personal, never api_credit with no
# eligible pool), and, once the host outbox synced the run's usage steps, no `source='agent-workflows'` row, within the
# same 120 s. It never waits on the Anthropic cost API (it lags 20-70 min).
# Last, a smoke review on the hidden transport (review v4): `agw review request` on a throwaway fixture repo (one planted
# defect, light tier) inside the factory's repo roots; the software factory runs the reviewer session and submits its
# reply, `agw review status` is polled (up to 900 s) until submitted, and REVIEW_OUTPUT v4 (tier light, a valid outcome)
# must come back. A factory that is unreachable or holds the spawn is a SKIP with the reason, not a failure.
# Prints the run ids, the gateway's request ids and the review's job id.

set -u

ROOT="${AGW_ROOT:-$HOME/.agent-workflows}"
REPO_DIR="$ROOT/repo"
SHA_FILE="$ROOT/data/deployed-sha"
HEALTH_URL="http://127.0.0.1:7791/health"
AUDIO_URL="http://127.0.0.1:7792"
IMAGE_DOOR_URL="http://127.0.0.1:7791/door/image"
API_SECRET_REF="op://mini/agent-workflows/API_SECRET"
PG_PASSWORD_REF="op://mini/vps-dev/AGENT_WORKFLOWS_DB_PASSWORD"
SCHEMA="${AGW_PG_SCHEMA:-agw}"
GATEWAY_URL="${AGW_GATEWAY_URL:-http://127.0.0.1:7794}"
GATEWAY_BUILD_FILE="$ROOT/data/gateway-build"
DOOR_TOKENS_FILE="$ROOT/data/door-tokens"
AGW_ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/agw/env"
USAGE_PG_PASSWORD_REF="op://mini/vps-dev/SHARED_USAGE_DB_PASSWORD"
GATEWAY_POLL_SECS="${GATEWAY_POLL_SECS:-120}"

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

fail() { print -u2 "verify: FAIL: $*"; exit 1; }
ok() { print "verify: ok: $*"; }
skip() { print "verify: SKIP: $*"; }

for tool in git curl jq psql secrets-run agw; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool not found on PATH"
done

# 0. the pinned OpenCode build the OpenCode host execs exists where it is looked for
pins=$("${0:A:h}/pins.sh" check "$ROOT/current" 2>&1) || fail "$pins"
ok "$pins"

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
psql_err=$(mktemp "${TMPDIR:-/tmp}/agw-verify.XXXXXX") || fail "cannot create a temp file"
agw_err=$(mktemp "${TMPDIR:-/tmp}/agw-verify.XXXXXX") || fail "cannot create a temp file"
review_dir=""
trap 'rm -f "$psql_err" "$agw_err"; [[ -z "$review_dir" ]] || { rm -rf "$review_dir"; rmdir "${review_dir:h}" 2>/dev/null; }' EXIT
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
door_body=$(mktemp "${TMPDIR:-/tmp}/agw-verify.XXXXXX") || fail "cannot create a temp file"
trap 'rm -f "$psql_err" "$agw_err" "$door_body"' EXIT
door_status=$(print -r -- "header = \"authorization: Bearer $secret\"" | curl -sS --max-time 30 -K - -o "$door_body" \
  -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'x-agw-purpose: verify' --data '{}' \
  "$AUDIO_URL/v1/audio/speech") || fail "no answer from the door"
[[ "$door_status" == "400" ]] || fail "an authenticated door request with a bad body got $door_status, not 400: $(<"$door_body")"
[[ "$(jq -r '.error.type // empty' "$door_body" 2>/dev/null)" == "invalid_request_error" ]] \
  || fail "the door's 400 is not the legacy envelope: $(<"$door_body")"
ok "door: 401 without a caller token, legacy 400 on a bad body"

# 7. the host's image door: refused without a caller token, the studio's error envelope on a bad body
door_status=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  --data '{}' "$IMAGE_DOOR_URL/generate") || fail "no answer from the image door"
[[ "$door_status" == "401" ]] || fail "an unauthenticated image door request got $door_status, not 401"
door_status=$(print -r -- "header = \"authorization: Bearer $secret\"" | curl -sS --max-time 30 -K - -o "$door_body" \
  -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{}' "$IMAGE_DOOR_URL/generate") \
  || fail "no answer from the image door"
[[ "$door_status" == "400" && "$(jq -r '.error.type // empty' "$door_body" 2>/dev/null)" == "invalid_request_error" ]] \
  || fail "the image door's bad-body answer is not the studio's 400 envelope ($door_status): $(<"$door_body")"
ok "image door: 401 without a caller token, studio 400 envelope on a bad body"

# 8. the gateway: healthy at the recorded build, three real calls, their usage rows
gw_health=$(curl -fsS --max-time 5 "$GATEWAY_URL/health") || fail "no answer from $GATEWAY_URL/health"
[[ "$(print -r -- "$gw_health" | jq -r '.status')" == "ok" ]] || fail "gateway /health is not ok: $gw_health"
gw_build=$(tr -d '[:space:]' < "$GATEWAY_BUILD_FILE" 2>/dev/null)
[[ -n "$gw_build" ]] || fail "$GATEWAY_BUILD_FILE missing: no gateway build was recorded"
[[ "$(print -r -- "$gw_health" | jq -r '.build')" == "$gw_build" ]] \
  || fail "the running gateway reports build $(print -r -- "$gw_health" | jq -r '.build'), $GATEWAY_BUILD_FILE says $gw_build"
ok "gateway /health ok (build $gw_build)"

gw_secret=$(sed -n 's/^AGW_API_SECRET=//p' "$AGW_ENV_FILE" 2>/dev/null | head -n 1)
[[ -n "$gw_secret" ]] || fail "AGW_API_SECRET not found in $AGW_ENV_FILE (make deploy writes it)"
# The OpenCode caller's door token (the line launch.sh hands the host as AGW_GATEWAY_TOOL_TOKEN), never printed.
oc_token=$(awk '{ sub(/\r$/, ""); eq = index($0, "="); if (eq == 0) next
  name = substr($0, 1, eq - 1); gsub(/^[ \t]+|[ \t]+$/, "", name); if (name != "agw-opencode") next
  token = substr($0, eq + 1); gsub(/^[ \t]+|[ \t]+$/, "", token); print token; exit }' "$DOOR_TOKENS_FILE" 2>/dev/null)
[[ -n "$oc_token" ]] || fail "no agw-opencode token in $DOOR_TOKENS_FILE (make deploy adds it)"
gw_key=$gw_secret

# A constant system block of well over the 512 tokens Haiku caches from, so the second call can read the cache.
gw_system=""
for _ in {1..60}; do
  gw_system+="The verify probe is a fixed block of text whose only job is to be long enough for prompt caching to apply. "
done
gw_body=$(jq -n --arg system "$gw_system" '{
  model: "haiku", max_tokens: 8,
  system: [{type: "text", text: $system, cache_control: {type: "ephemeral"}}],
  messages: [{role: "user", content: "Reply with OK."}]
}')
gw_session="verify-$(date +%s)"
gw_head=$(mktemp "${TMPDIR:-/tmp}/agw-verify.XXXXXX") || fail "cannot create a temp file"
gw_resp=$(mktemp "${TMPDIR:-/tmp}/agw-verify.XXXXXX") || fail "cannot create a temp file"
trap 'rm -f "$psql_err" "$agw_err" "$door_body" "$gw_head" "$gw_resp"' EXIT

# One POST through the gateway as the caller whose key is $gw_key; the key goes to curl on stdin, never the command line.
# Sets gw_status, gw_id, gw_pool.
gateway_call() {  # $@ extra curl args (headers)
  gw_status=$(print -r -- "header = \"x-api-key: $gw_key\"" | curl -sS --max-time 120 -K - -D "$gw_head" -o "$gw_resp" \
    -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
    -H 'x-agw-purpose: verify' -H "x-agw-session: $gw_session" "$@" --data "$gw_body" "$GATEWAY_URL/anthropic/v1/messages") \
    || fail "no answer from the gateway's /anthropic/v1/messages"
  gw_id=$(awk -F': *' 'tolower($1) == "x-agw-request-id" { gsub(/\r/, "", $2); print $2 }' "$gw_head" | tail -n 1)
  gw_pool=$(awk -F': *' 'tolower($1) == "x-agw-pool" { gsub(/\r/, "", $2); print $2 }' "$gw_head" | tail -n 1)
}

gateway_call
[[ "$gw_status" == "200" ]] || fail "gateway call 1 (credit pool) got $gw_status: $(head -c 400 "$gw_resp")"
[[ -n "$gw_id" ]] || fail "gateway call 1 answered without x-agw-request-id"
id1=$gw_id; pool=$gw_pool
[[ -n "$pool" && "$pool" != "iu-api" ]] || fail "gateway call 1 was not paid from a credit pool (x-agw-pool '${pool:-missing}')"
ok "gateway call 1: 200, credit pool $pool, request $id1"

gateway_call
[[ "$gw_status" == "200" ]] || fail "gateway call 2 (repeat) got $gw_status: $(head -c 400 "$gw_resp")"
[[ -n "$gw_id" ]] || fail "gateway call 2 answered without x-agw-request-id"
id2=$gw_id
[[ "$gw_pool" == "$pool" ]] || fail "gateway call 2 went to '${gw_pool:-missing}', call 1 to $pool (the session must stay on its pool)"
cache_read=$(jq -r '.usage.cache_read_input_tokens // 0' "$gw_resp" 2>/dev/null)
(( ${cache_read:-0} > 0 )) || fail "gateway call 2 read no cache (usage.cache_read_input_tokens '${cache_read:-null}'): $(head -c 400 "$gw_resp")"
ok "gateway call 2: 200, pool $pool, $cache_read cache-read tokens, request $id2"

gateway_call -H 'x-app: cli'
[[ "$gw_status" == "200" ]] || fail "gateway call 3 (Claude-Code-shaped) got $gw_status: $(head -c 400 "$gw_resp")"
[[ -n "$gw_id" ]] || fail "gateway call 3 answered without x-agw-request-id"
id3=$gw_id
[[ "$gw_pool" == "iu-api" ]] || fail "gateway call 3 (Claude-Code-shaped) went to '${gw_pool:-missing}', not iu-api"
ok "gateway call 3: 200, pool iu-api, request $id3"

# The OpenCode caller: its own session, the agw-opencode token instead of the API secret.
gw_key=$oc_token
gw_session="verify-oc-$(date +%s)"
gateway_call
gw_key=$gw_secret
[[ "$gw_status" == "200" ]] || fail "gateway call 4 (agw-opencode) got $gw_status: $(head -c 400 "$gw_resp")"
[[ -n "$gw_id" ]] || fail "gateway call 4 answered without x-agw-request-id"
id4=$gw_id
ok "gateway call 4: 200 as agw-opencode, pool ${gw_pool:-none}, request $id4"

usage_password=$(secrets-run read "$USAGE_PG_PASSWORD_REF" 2>/dev/null)
[[ -n "$usage_password" ]] || fail "cannot read $USAGE_PG_PASSWORD_REF through secrets-run"
# One usage query (role usage, database shared); the SQL on stdin, the ids bound as comma-separated -v variables.
usage_q() {  # $1 sql, $@ psql -v bindings
  local sql=$1; shift
  PGPASSWORD="$usage_password" psql -h 127.0.0.1 -U usage -d shared -AtF '|' -v ON_ERROR_STOP=1 "$@" \
    2>"$psql_err" <<< "$sql" || fail "usage query failed: $(<"$psql_err")"
}
gw_ids="ids=$id1,$id2,$id3,$id4"
rows_sql="select source_id, billing, coalesce(account, ''), coalesce(api_key, ''), coalesce(cost_usd::text, ''), cache_read_tokens, cache_write_5m_tokens, lane, coalesce(lane_detail->>'caller', '') from usage.records
  where source = 'gateway' and source_id = any(string_to_array(:'ids', ',')) order by source_id"
picks_sql="select count(distinct request_id) from usage.gateway_picks where request_id = any(string_to_array(:'ids', ','))"
rows=""; picks=0
for (( waited = 0; waited <= GATEWAY_POLL_SECS; waited += 5 )); do
  rows=$(usage_q "$rows_sql" -v "$gw_ids") || exit 1
  picks=$(usage_q "$picks_sql" -v "$gw_ids") || exit 1
  (( $(print -r -- "$rows" | grep -c .) == 4 && ${picks:-0} == 4 )) && break
  (( waited < GATEWAY_POLL_SECS )) && sleep 5
done
row_of() { print -r -- "$rows" | awk -F'|' -v id="$1" '$1 == id'; }
for id in $id1 $id2 $id3 $id4; do
  [[ -n "$(row_of "$id")" ]] || fail "no usage.records row (source 'gateway') for request $id within ${GATEWAY_POLL_SECS}s"
done
(( ${picks:-0} == 4 )) || fail "usage.gateway_picks has ${picks:-0} of 4 request ids within ${GATEWAY_POLL_SECS}s"
for id in $id1 $id2; do
  IFS='|' read -r _ g_billing g_account g_key g_cost g_read g_write _ <<< "$(row_of "$id")"
  [[ "$g_billing" == "api_credit" ]] || fail "request $id: billing '$g_billing', expected api_credit"
  [[ "$g_account" == "$pool" ]] || fail "request $id: account '$g_account', expected the pool $pool"
  [[ -n "$g_cost" ]] && (( g_cost > 0 )) || fail "request $id: cost_usd '${g_cost:-null}', expected > 0"
  if [[ "$id" == "$id2" ]]; then
    (( ${g_read:-0} > 0 )) || fail "request $id: cache_read_tokens '${g_read:-null}', expected > 0 (the repeat reads the cache)"
  else
    (( ${g_write:-0} + ${g_read:-0} > 0 )) || fail "request $id: cache_write_5m_tokens '${g_write:-null}' + cache_read_tokens '${g_read:-null}', expected > 0"
  fi
done
IFS='|' read -r _ g_billing g_account g_key g_cost _ <<< "$(row_of "$id3")"
[[ "$g_billing" == "api_key" ]] || fail "request $id3: billing '$g_billing', expected api_key"
[[ "$g_key" == "personal" ]] || fail "request $id3: api_key '$g_key', expected personal"
IFS='|' read -r _ _ _ _ _ _ _ g_lane g_caller _ <<< "$(row_of "$id4")"
[[ "$g_lane" == "agw_workflow" ]] || fail "request $id4 (agw-opencode): lane '$g_lane', expected agw_workflow"
[[ "$g_caller" == "agw-opencode" ]] || fail "request $id4: lane_detail.caller '$g_caller', expected agw-opencode"
ok "gateway usage: $id1 and $id2 api_credit on $pool (priced, cache columns set), $id3 api_key personal, $id4 agw_workflow as agw-opencode; 4 gateway_picks rows"

# 9. the runs' own model calls went through the gateway: agw holds no provider key, so the smoke run and the
# cap.llm.title run each have gateway rows, every one of them qualifying, and agw recorded none of its own for them. The
# absence is judged only once the host outbox has synced the run's usage steps (`argo_synced_at` on every ended step
# with usage, the steps it would write a row for), so it cannot pass before agw would have written one. The billing
# depends on the wire and the pools: cheap.title is an anthropic-wire route, paid from a credit pool while one is
# eligible; a drained pool answers 402 (no row) and the route's GPT fallback goes to IU. So api_credit must name a pool
# /health lists and needs an eligible one, api_key must be the personal key.
eligible=$(print -r -- "$gw_health" | jq -r '[.pools[]? | select(.eligible == true) | .id] | join(",")')
pool_ids=$(print -r -- "$gw_health" | jq -r '[.pools[]?.id] | join(",")')
runs_sql="select run_id, source, lane, billing, coalesce(account, ''), coalesce(api_key, ''), coalesce(lane_detail->>'workflow', ''), coalesce(lane_detail->>'step', ''), coalesce(cost_usd::text, '') from usage.records
  where run_id = any(string_to_array(:'runs', ',')) and source in ('gateway', 'agent-workflows') order by run_id, source_id"
# The outbox's view of one run: its ended steps with usage, how many are not synced yet, how many failed to sync.
synced_sql="select count(*), count(*) filter (where argo_synced_at is null and argo_error is null), count(*) filter (where argo_error is not null)
  from \"$SCHEMA\".steps where run_id = :'id' and status in ('done', 'failed', 'cancelled')
  and (tokens_input > 0 or tokens_output > 0 or tokens_cache_read > 0 or tokens_cache_write > 0 or tokens_reasoning > 0 or cost > 0)"
# The first problem of one gateway row, or nothing.
row_problem() {  # $1 lane, $2 billing, $3 account, $4 api_key, $5 workflow, $6 step, $7 cost
  [[ "$1" == "agw_workflow" ]] || { print -r -- "lane '$1', expected agw_workflow"; return; }
  case "$2" in
    api_credit)
      [[ -n "$eligible" ]] || { print -r -- "billing api_credit (account '$3'), but /health names no eligible pool"; return; }
      [[ ",$pool_ids," == *",$3,"* ]] || { print -r -- "billing api_credit on account '$3', not a pool /health lists (${pool_ids:-none})"; return; }
      ;;
    api_key) [[ "$4" == "personal" ]] || { print -r -- "billing api_key with api_key '$4', expected personal"; return; } ;;
    *) print -r -- "billing '$2', expected api_credit or api_key"; return ;;
  esac
  [[ -n "$5" ]] || { print -r -- "lane_detail.workflow is not set"; return; }
  [[ -n "$6" ]] || { print -r -- "lane_detail.step is not set"; return; }
  [[ -n "$7" ]] && (( $7 > 0 )) || print -r -- "cost_usd '${7:-null}', expected > 0"
}
# Sets run_state and run_why for one run from $run_rows and its outbox state: good (synced, gateway rows, all qualify),
# agw-row or bad-row (final), pending (not synced yet, or no gateway row yet).
check_run() {  # $1 run id
  local r_run r_source r_lane r_billing r_account r_key r_workflow r_step r_cost problem rows=0 summary=""
  local steps unsynced errored
  while IFS='|' read -r r_run r_source r_lane r_billing r_account r_key r_workflow r_step r_cost; do
    [[ "$r_run" == "$1" ]] || continue
    if [[ "$r_source" == "agent-workflows" ]]; then
      run_state=agw-row; run_why="run $1 has a source 'agent-workflows' row: agw recorded a model call the gateway records"
      return
    fi
    problem=$(row_problem "$r_lane" "$r_billing" "$r_account" "$r_key" "$r_workflow" "$r_step" "$r_cost")
    if [[ -n "$problem" ]]; then
      run_state=bad-row; run_why="run $1: a gateway row does not qualify: $problem"
      return
    fi
    rows=$(( rows + 1 ))
    [[ -n "$summary" ]] || summary="$r_billing${r_account:+ on $r_account}${r_key:+ $r_key}, $r_workflow/$r_step, cost $r_cost"
  done <<< "$run_rows"
  IFS='|' read -r steps unsynced errored <<< "$(journal "$synced_sql" -v "id=$1")"
  if (( ${errored:-0} > 0 )); then
    run_state=bad-row; run_why="run $1: $errored usage step(s) failed to sync (argo_error in $SCHEMA.steps)"
    return
  fi
  run_state=pending
  if (( ${steps:-0} == 0 )); then run_why="run $1 has no ended step with usage in $SCHEMA.steps"; return; fi
  if (( ${unsynced:-0} > 0 )); then run_why="run $1: $unsynced of $steps usage step(s) not synced by the host outbox"; return; fi
  if (( rows == 0 )); then run_why="no usage.records row (source 'gateway') for run $1"; return; fi
  run_state=good; run_why="$rows gateway row(s), all qualify ($summary)"
}
run_rows=""
for (( waited = 0; waited <= GATEWAY_POLL_SECS; waited += 5 )); do
  run_rows=$(usage_q "$runs_sql" -v "runs=$run_id,$cap_id") || exit 1
  check_run "$run_id"; smoke_state=$run_state
  check_run "$cap_id"
  [[ "$smoke_state" != pending && "$run_state" != pending ]] && break
  (( waited < GATEWAY_POLL_SECS )) && sleep 5
done
for rid in $run_id $cap_id; do
  check_run "$rid"
  [[ "$run_state" == pending ]] && fail "$run_why (within ${GATEWAY_POLL_SECS}s)"
  [[ "$run_state" == good ]] || fail "$run_why"
  ok "run $rid: steps synced, $run_why; no agent-workflows row"
done

# 10. a smoke review on the hidden transport (review v4): `agw review request` asks the software factory for one reviewer
# session on a throwaway fixture repo (light tier, one planted defect); the factory submits the agent's reply, and
# `agw review status` is polled until the job is submitted. REVIEW_OUTPUT v4 must come back (tier light, a valid
# outcome); the finding count is reported, not required. A factory that is unreachable or holds the spawn (ceiling,
# slots, deep cap, drain) is a SKIP with its reason, never a failure.
# The fixture repo must be inside the factory's FACTORY_REPO_ROOTS after realpath (default $HOME/SourceRoot:$HOME/IuRoot;
# the trust boundary refuses anything else) and is no repo's content: a hidden dir directly under SourceRoot, removed by
# the trap. It is built from scripts/fixtures/smoke-review/{base,change}: base committed, change committed on top.
# The fixture sits beside this file: %x is the sourced file, where $0 would be the shell when a test runs a cut of it.
REVIEW_FIXTURE="${REVIEW_FIXTURE:-${${(%):-%x}:A:h}/fixtures/smoke-review}"
REVIEW_FIXTURE_ROOT="${REVIEW_FIXTURE_ROOT:-$HOME/SourceRoot/.agw-verify}"
REVIEW_WAIT_SECS="${REVIEW_WAIT_SECS:-900}"
REVIEW_POLL_SECS="${REVIEW_POLL_SECS:-10}"
[[ -d "$REVIEW_FIXTURE/base" && -d "$REVIEW_FIXTURE/change" ]] || fail "smoke review fixture missing at $REVIEW_FIXTURE"
mkdir -p "$REVIEW_FIXTURE_ROOT" || fail "smoke review: cannot create $REVIEW_FIXTURE_ROOT"
review_dir=$(mktemp -d "$REVIEW_FIXTURE_ROOT/review.XXXXXX") || fail "cannot create a temp dir"
review_dir=${review_dir:A}
git_fixture() { git -C "$review_dir" -c user.name=verify -c user.email=verify@example.invalid -c commit.gpgsign=false "$@"; }
git -C "$review_dir" init -q -b main 2>"$agw_err" || fail "smoke review: git init failed: $(<"$agw_err")"
cp -R "$REVIEW_FIXTURE/base/." "$review_dir/" || fail "smoke review: cannot copy the fixture base"
git_fixture add -A && git_fixture commit -q -m "base" 2>"$agw_err" || fail "smoke review: cannot commit the fixture base: $(<"$agw_err")"
cp -R "$REVIEW_FIXTURE/change/." "$review_dir/" || fail "smoke review: cannot copy the fixture change"
git_fixture add -A && git_fixture commit -q -m "feat: scores summary" 2>"$agw_err" || fail "smoke review: cannot commit the fixture change: $(<"$agw_err")"

review_summary=""
review_started=$SECONDS
out=$(AGW_PURPOSE=verify agw review request --cwd "$review_dir" --scope head --commit --format json 2>"$agw_err")
rc=$?
if (( rc != 0 )); then
  reason="$out $(<"$agw_err")"
  # a repo the factory refuses is a broken fixture, not a busy factory
  [[ "$reason" == *FACTORY_REPO_ROOTS* || "$reason" == *"allowed roots"* ]] && fail "smoke review: the factory refused the fixture $review_dir: $reason"
  skip "smoke review: the factory could not take the review (${reason:0:300})"
else
  print -r -- "$out" | jq -e . >/dev/null 2>&1 || fail "smoke review: agw review request printed output that is not JSON: $out"
  [[ "$(print -r -- "$out" | jq -r '.status')" == "requested" ]] || fail "smoke review: agw review request answered '$(print -r -- "$out" | jq -r '.status')', not requested: $out"
  [[ "$(print -r -- "$out" | jq -r '.tier')" == "light" ]] || fail "smoke review: the fixture routed to tier '$(print -r -- "$out" | jq -r '.tier')', not light: $out"
  review_job=$(print -r -- "$out" | jq -r '.jobId // empty')
  [[ -n "$review_job" ]] || fail "smoke review: agw review request printed no jobId: $out"
  # a held spawn: status waiting (no account under the ceiling) or a non-null hold (slots, deep cap, drain), the factory's Spawn contract
  review_hold=$(print -r -- "$out" | jq -r '.spawn | if type == "object" and (.status == "waiting" or .hold != null) then "\(.status): \(.hold // "no account under the ceiling" | if type == "string" then . else tojson end)" else empty end' 2>/dev/null)
  if [[ -n "$review_hold" ]]; then
    # a held review would sit in the factory's queue: cancel it so it never starts later (a failure is reported, never a FAIL)
    cancel_out=$(AGW_PURPOSE=verify agw review cancel "$review_job" --commit --format json 2>&1)
    if (( $? == 0 )); then cancel_note="cancel: $(print -r -- "$cancel_out" | jq -r '.status // "unknown"' 2>/dev/null)"; else cancel_note="cancel failed: ${cancel_out:0:200}"; fi
    skip "smoke review: the factory holds the spawn of $review_job: $review_hold ($cancel_note)"
  else
    review_state=prepared
    while (( SECONDS - review_started < REVIEW_WAIT_SECS )); do
      agw_json review status "$review_job" --format json
      review_state=$(print -r -- "$out" | jq -r '.job.state // empty')
      [[ "$review_state" == prepared ]] || break
      sleep "$REVIEW_POLL_SECS"
    done
    [[ "$review_state" == submitted ]] || fail "smoke review: job $review_job is '${review_state:-unknown}' after $(( SECONDS - review_started )) s, not submitted (is the factory's reviewer session running? factory fleet)"
    review_output=$(print -r -- "$out" | jq -c '.job.output // empty')
    print -r -- "$review_output" | jq -e '.schemaVersion == 4 and .tier == "light" and (.outcome | IN("clean", "actionable", "needs-human")) and (.findings | type == "array")' >/dev/null 2>&1 \
      || fail "smoke review: job $review_job did not submit REVIEW_OUTPUT v4 at tier light: $review_output"
    review_findings=$(print -r -- "$review_output" | jq -r '.findings | length')
    review_account=$(print -r -- "$out" | jq -r '.job.account // "none"')
    review_summary="review job $review_job (light, hidden, account $review_account)"
    ok "agw review request (hidden, light): job $review_job submitted in $(( SECONDS - review_started )) s, outcome $(print -r -- "$review_output" | jq -r '.outcome'), $review_findings finding(s)"
  fi
fi

print "verify: PASS run $run_id, cap run $cap_id, audio run $audio_run, gateway pool $pool requests $id1 $id2 $id3, agw-opencode request $id4, ${review_summary:-smoke review skipped}"
