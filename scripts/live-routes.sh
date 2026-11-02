#!/bin/zsh
# agent-workflows live-routes (`make live-routes`): one real call per route, proved by the rows it leaves. The proof
# behind a changed route (a Wave gate), and the same tool for a route table or gateway change.
#
#   scripts/live-routes.sh [route...]
#
# No arguments: every route on the `anthropic` or `opencode` wire, plus every `iu-openai` text route (no `price`), read
# from `agw routes`. Media and decision routes are `make verify`'s and their capabilities'. Each route runs as
# `AGW_PURPOSE=verify agw smoke route <id>`, four at a time. Then, within LIVE_ROUTES_POLL_SECS (120), for each run:
#   - usage.records has a source='gateway' row of the run with outcome 'ok', the route's concrete model as the served
#     `model` (a Claude alias resolves to its id through CLAUDE_ALIASES of the deployed release, read from its source),
#     cost_usd not null, lane 'agw_workflow';
#   - the run's agw.runs row is 'done' with a cost.
# Prints route | model | billing | account | input | cache read | output | cost | run id, and exits 1 naming each route
# that failed. It costs cents (DeepSeek routes included) and never prints a key.

set -u

ROOT="${AGW_ROOT:-$HOME/.agent-workflows}"
SCHEMA="${AGW_PG_SCHEMA:-agw}"
PG_PASSWORD_REF="op://mini/vps-dev/AGENT_WORKFLOWS_DB_PASSWORD"
USAGE_PG_PASSWORD_REF="op://mini/vps-dev/SHARED_USAGE_DB_PASSWORD"
POLL_SECS="${LIVE_ROUTES_POLL_SECS:-120}"
PARALLEL=4

export PATH="$PATH:$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin"

# Worker mode (`--worker <dir> <route>`, started by xargs below): one call, its answer in <dir>/<route>.{out,err,rc}.
# Exit 10 (pending) is resumed with `agw run wait`, which prints the same answer.
if [[ "${1:-}" == "--worker" ]]; then
  dir=$2 id=$3
  out=$(AGW_PURPOSE=verify agw smoke route "$id" 2>"$dir/$id.err"); rc=$?
  for _ in {1..10}; do
    (( rc == 10 )) || break
    run_id=$(print -r -- "$out" | jq -r '.runId // empty' 2>/dev/null)
    [[ -n "$run_id" ]] || break
    out=$(AGW_PURPOSE=verify agw run wait "$run_id" 2>"$dir/$id.err"); rc=$?
  done
  print -r -- "$out" >"$dir/$id.out"
  print -r -- "$rc" >"$dir/$id.rc"
  exit 0
fi

die() { print -u2 "live-routes: $*"; exit 1; }

for tool in jq psql secrets-run agw xargs bun; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH"
done

# 1. the routes: the table as the live host resolves it, narrowed to what smoke.route can probe
table=$(agw routes 2>&1) || die "agw routes failed: $table"
print -r -- "$table" | jq -e '.routes' >/dev/null 2>&1 || die "agw routes did not print the route table as JSON"
probe_filter='.routes | to_entries[]
  | select(.value.price == null and (.value.wire == "anthropic" or .value.wire == "opencode" or .value.wire == "iu-openai"))
  | .key'
if (( $# == 0 )); then
  ids=("${(@f)$(print -r -- "$table" | jq -r "$probe_filter")}")
else
  allowed=("${(@f)$(print -r -- "$table" | jq -r "$probe_filter")}")
  ids=("$@")
  typeset -A given
  for id in $ids; do
    [[ -z "${given[$id]:-}" ]] || die "$id is given more than once"
    given[$id]=1
    (( ${allowed[(Ie)$id]} )) || die "$id is not a probeable route (known: ${(j: :)allowed})"
  done
fi
ids=(${ids:#})
(( ${#ids} > 0 )) || die "no routes to probe"
# The route's concrete model: a Claude alias resolves to its id, because the gateway row's `model` is the served model.
# The alias map is CLAUDE_ALIASES of the release being tested (neither `agw routes` nor a copy here carries it), read from
# its source; a missing or malformed map fails loudly, a route is never silently compared against its alias.
alias_src="$ROOT/current/packages/routes/src/table/claude.ts"
[[ -f "$alias_src" ]] || die "the alias map source $alias_src is missing (CLAUDE_ALIASES of the deployed release)"
alias_json=$(bun -e 'const m = await import(process.argv[1]); if (typeof m.CLAUDE_ALIASES !== "object" || m.CLAUDE_ALIASES === null) throw new Error("CLAUDE_ALIASES is not exported"); console.log(JSON.stringify(m.CLAUDE_ALIASES))' "$alias_src" 2>&1) \
  || die "cannot read CLAUDE_ALIASES from $alias_src: $alias_json"
print -r -- "$alias_json" | jq -e 'type == "object" and length > 0 and all(.[]; type == "string")' >/dev/null 2>&1 \
  || die "CLAUDE_ALIASES from $alias_src is not a non-empty map of strings: $alias_json"
typeset -A model_of
for id in $ids; do
  m=$(print -r -- "$table" | jq -r --arg id "$id" '.routes[$id].model')
  model_of[$id]=$(print -r -- "$alias_json" | jq -r --arg m "$m" '.[$m] // $m')
done

work=$(mktemp -d "${TMPDIR:-/tmp}/agw-live-routes.XXXXXX") || die "cannot create a temp dir"
trap 'rm -rf "$work"' EXIT

# 2. the calls, four at a time (the worker mode above).
print "live-routes: ${#ids} routes, $PARALLEL at a time"
printf '%s\n' $ids | xargs -P $PARALLEL -n 1 /bin/zsh "${0:A}" --worker "$work" || true

typeset -A run_of failure
for id in $ids; do
  rc=$(<"$work/$id.rc" 2>/dev/null)
  out=$(<"$work/$id.out" 2>/dev/null)
  if [[ "$rc" != "0" ]]; then
    failure[$id]="agw smoke route exited ${rc:-?}: $(print -r -- "$out" | head -c 300 | tr '\n' ' ') $(head -c 300 "$work/$id.err" 2>/dev/null | tr '\n' ' ')"
    continue
  fi
  run_of[$id]=$(print -r -- "$out" | jq -r '.runId // empty' 2>/dev/null)
  [[ -n "${run_of[$id]}" ]] || { failure[$id]="agw smoke route printed no runId"; continue; }
  [[ "$(print -r -- "$out" | jq -r '.status // empty')" == "done" ]] || failure[$id]="run ${run_of[$id]} is not done: $(print -r -- "$out" | head -c 300 | tr '\n' ' ')"
done

# 3. the rows. The journal (agent_workflows) and the usage database (shared) are two connections.
password=$(secrets-run read "$PG_PASSWORD_REF" 2>/dev/null)
[[ -n "$password" ]] || die "cannot read $PG_PASSWORD_REF through secrets-run"
usage_password=$(secrets-run read "$USAGE_PG_PASSWORD_REF" 2>/dev/null)
[[ -n "$usage_password" ]] || die "cannot read $USAGE_PG_PASSWORD_REF through secrets-run"
psql_err="$work/psql.err"
# Each psql call is bounded under the polling deadline: a connect and a statement timeout of at most 10s (POLL_SECS if less).
bound=$(( POLL_SECS < 10 ? POLL_SECS : 10 )); (( bound >= 1 )) || bound=1
export PGCONNECT_TIMEOUT=$bound PGOPTIONS="-c statement_timeout=$(( bound * 1000 ))"
journal() {  # SQL on stdin; -v bindings as arguments
  local sql=$1; shift
  PGPASSWORD="$password" psql -h 127.0.0.1 -U agent_workflows -d agent_workflows -AtF '|' -v ON_ERROR_STOP=1 "$@" \
    2>"$psql_err" <<< "$sql" || die "journal query failed: $(<"$psql_err")"
}
usage() {
  local sql=$1; shift
  PGPASSWORD="$usage_password" psql -h 127.0.0.1 -U usage -d shared -AtF '|' -v ON_ERROR_STOP=1 "$@" \
    2>"$psql_err" <<< "$sql" || die "usage query failed: $(<"$psql_err")"
}

gateway_sql="select count(*), coalesce(string_agg(distinct billing, ','), ''),
    coalesce(string_agg(distinct coalesce(nullif(account, ''), api_key, ''), ','), ''),
    coalesce(sum(input_tokens), 0), coalesce(sum(cache_read_tokens), 0), coalesce(sum(output_tokens), 0), coalesce(sum(cost_usd)::text, '')
  from usage.records
  where source = 'gateway' and run_id = :'run' and lane = 'agw_workflow' and cost_usd is not null and outcome = 'ok' and model = :'model'"
seen_sql="select coalesce(string_agg(coalesce(model, '?') || ' lane=' || coalesce(lane, '?') || ' cost=' || coalesce(cost_usd::text, 'null'), '; '), '')
  from usage.records where source = 'gateway' and run_id = :'run'"
run_sql="select status, coalesce(cost::text, '') from \"$SCHEMA\".runs where id = :'run'"

typeset -A row why
pending=()
for id in $ids; do [[ -z "${failure[$id]:-}" ]] && pending+=($id); done
deadline=$(( SECONDS + POLL_SECS ))
while :; do
  still=()
  for id in $pending; do
    run=${run_of[$id]}; model=${model_of[$id]}
    g=$(usage "$gateway_sql" -v "run=$run" -v "model=$model") || exit 1
    r=$(journal "$run_sql" -v "run=$run") || exit 1
    IFS='|' read -r g_count g_billing g_account g_in g_read g_out g_cost <<< "$g"
    IFS='|' read -r r_status r_cost <<< "$r"
    gateway_ok=0; journal_ok=0
    (( ${g_count:-0} > 0 )) && gateway_ok=1
    [[ "${r_status:-}" == "done" && -n "${r_cost:-}" ]] && journal_ok=1
    if (( gateway_ok && journal_ok )); then
      row[$id]="$g_billing|$g_account|$g_in|$g_read|$g_out|$g_cost"
      continue
    fi
    reasons=()
    if (( ! gateway_ok )); then
      seen=$(usage "$seen_sql" -v "run=$run") || exit 1
      reasons+=("no source='gateway' row with outcome ok, model $model, cost_usd and lane agw_workflow (saw: ${seen:-none})")
    fi
    (( journal_ok )) || reasons+=("run is '${r_status:-missing}' with cost '${r_cost:-null}' in $SCHEMA.runs")
    why[$id]="${(j:; :)reasons}"
    still+=($id)
  done
  pending=($still)
  (( ${#pending} == 0 )) && break
  (( SECONDS >= deadline )) && break
  sleep 5
done
for id in $pending; do failure[$id]="${why[$id]} (after ${POLL_SECS}s)"; done

# 4. the table, and the verdict
fmt='%-30s %-32s %-11s %-10s %9s %10s %8s %12s  %s\n'
printf "$fmt" route model billing account input 'cache read' output cost 'run id'
for id in $ids; do
  if [[ -n "${row[$id]:-}" ]]; then
    IFS='|' read -r billing account input cache_read output cost <<< "${row[$id]}"
    printf "$fmt" "$id" "${model_of[$id]}" "$billing" "$account" "$input" "$cache_read" "$output" "$cost" "${run_of[$id]}"
  else
    printf "$fmt" "$id" "${model_of[$id]}" - - - - - - "${run_of[$id]:--}"
  fi
done
failed=0
for id in $ids; do
  [[ -n "${failure[$id]:-}" ]] || continue
  print -u2 "live-routes: FAIL $id: ${failure[$id]}"
  failed=$(( failed + 1 ))
done
(( failed == 0 )) || die "$failed of ${#ids} routes failed"
print "live-routes: PASS ${#ids} routes"
