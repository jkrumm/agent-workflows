#!/bin/zsh
# agent-workflows verify (`make verify`): exit 0 only if the deployed host is healthy, runs origin/master, and a real
# `agw smoke ping` (the installed CLI, the real bearer) produced a done run with a trace id and priced usage in the
# journal. Prints the run id.

set -u

ROOT="${AGW_ROOT:-$HOME/.agent-workflows}"
APP_DIR="$ROOT/app"
SHA_FILE="$ROOT/data/deployed-sha"
HEALTH_URL="http://127.0.0.1:7791/health"
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

# 2. the deployed build is origin/master, and it is the one serving
deployed=$(cat "$SHA_FILE" 2>/dev/null) || fail "$SHA_FILE missing: nothing was deployed"
remote=$(git -C "$APP_DIR" ls-remote origin refs/heads/master | awk '{print $1}')
[[ -n "$remote" ]] || fail "cannot read origin/master from $APP_DIR"
[[ "$deployed" == "$remote" ]] || fail "deployed ${deployed[1,12]} is not origin/master ${remote[1,12]}"
[[ "$version" == "$deployed" ]] || fail "the running host reports ${version[1,12]}, deployed is ${deployed[1,12]}"
ok "deployed sha is origin/master (${deployed[1,12]})"

# 3. a real run through the installed CLI
out=$(AGW_PURPOSE=verify agw smoke ping 2>&1)
rc=$?
(( rc == 0 )) || fail "agw smoke ping exited $rc: $out"
run_id=$(print -r -- "$out" | jq -r '.runId // empty' 2>/dev/null)
title=$(print -r -- "$out" | jq -r '.output.title // empty' 2>/dev/null)
[[ -n "$run_id" ]] || fail "agw smoke ping printed no runId: $out"
[[ -n "$title" ]] || fail "run $run_id has no output title: $out"
ok "agw smoke ping: run $run_id, title \"$title\""

# 4. its row in the journal (the run record lands in runPost, a moment after the run ends)
password=$(secrets-run read "$PG_PASSWORD_REF" 2>/dev/null)
[[ -n "$password" ]] || fail "cannot read $PG_PASSWORD_REF through secrets-run"
row=""
psql_err=$(mktemp -t agw-verify) || fail "cannot create a temp file"
trap 'rm -f "$psql_err"' EXIT
for _ in {1..20}; do
  # The query goes on stdin: psql interpolates :'id' there, not in -c. stderr stays out of the row.
  row=$(PGPASSWORD="$password" psql -h 127.0.0.1 -U agent_workflows -d agent_workflows -AtF '|' -v ON_ERROR_STOP=1 -v "id=$run_id" 2>"$psql_err" \
    <<< "select status, coalesce(trace_id, ''), coalesce(cost::text, ''), coalesce(tokens_input, 0) from \"$SCHEMA\".runs where id = :'id'") \
    || fail "journal query failed: $(<"$psql_err")"
  IFS='|' read -r run_status trace cost tokens <<< "$row"
  [[ "$run_status" == "done" && -n "${trace:-}" && -n "${cost:-}" ]] && break
  sleep 1
done
[[ "${run_status:-}" == "done" ]] || fail "run $run_id is '${run_status:-missing}' in $SCHEMA.runs, not done"
[[ -n "${trace:-}" ]] || fail "run $run_id has no trace id"
[[ -n "${cost:-}" ]] && (( cost > 0 )) || fail "run $run_id has no priced usage (cost '${cost:-null}')"
(( ${tokens:-0} > 0 )) || fail "run $run_id recorded no input tokens"
ok "journal: done, trace $trace, cost $cost, $tokens input tokens"

print "verify: PASS run $run_id"
