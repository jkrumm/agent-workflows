#!/usr/bin/env bash
# What does an OpenCode v2 server emit, and does it read an inbound `traceparent`? (Spike 6, step 5.)
#
#   opencode_probe.sh <trace-id-32hex> <parent-span-id-16hex> [--session]
#
# --session additionally creates a session and sends ONE tiny prompt through the IU unified
# endpoint (credentials read from the macOS Keychain by this script and placed in the throwaway
# server's environment only), to see which spans a running session emits and whether they join.
#
# Starts a THROWAWAY `opencode serve` the way the agw probe does (docs/opencode-v2.md): its own
# port, scratch HOME/XDG roots (the shared opencode.db and the agw-owned server are never
# touched), the pinned build, no providers. The OTLP env is set on this child only. Then sends a
# few authenticated and unauthenticated requests carrying `traceparent`, waits for the export,
# and stops the server. No model call is made.
set -euo pipefail

TRACE="${1:?trace id (32 hex)}"; PARENT="${2:?parent span id (16 hex)}"; MODE="${3:-}"
SCR="${SPIKE_SCRATCH:-$HOME/.local/share/factory/spikes/06-telemetry}"
RUN="$SCR/run/opencode"; PORT=17900
BIN="$HOME/.local/share/agent-gateway/opencode-bin/2.0.32/node_modules/.bin/opencode"
OTLP="${SPIKE_OTLP_BASE:-http://localhost:4319}"
PW="$(openssl rand -hex 8)"
TP="00-${TRACE}-${PARENT}-01"

rm -rf "$RUN"; mkdir -p "$RUN/home" "$RUN/data" "$RUN/config" "$RUN/state" "$RUN/cache"
[[ -x "$BIN" ]] || { echo "pinned opencode missing: $BIN" >&2; exit 1; }

CFG='{}'; IU_ENV=()
if [[ "$MODE" == "--session" ]]; then
  IU_KEY="$(security find-generic-password -s claude-sdk-api-key -w)"
  IU_BASE="$(security find-generic-password -s claude-sdk-base-url -w)"
  IU_BASE="${IU_BASE%/}"
  IU_ENV=(IU_KEY="$IU_KEY" IU_OPENAI_BASE="${IU_BASE%/anthropic}/openai/v1")
  CFG='{"autoupdate":false,"share":"disabled","providers":{"iu-chat":{"package":"aisdk:@ai-sdk/openai-compatible","name":"IU chat","settings":{"baseURL":"{env:IU_OPENAI_BASE}","apiKey":"{env:IU_KEY}"},"models":{"deepseek-v4.1-flash":{"name":"deepseek-v4.1-flash","limit":{"context":128000,"output":8000},"cost":{"input":0,"output":0}}}}}}'
fi

(
  cd "$RUN/home"
  env -i PATH="$PATH" HOME="$RUN/home" TMPDIR="${TMPDIR:-/tmp}" LANG=en_US.UTF-8 \
    XDG_DATA_HOME="$RUN/data" XDG_CONFIG_HOME="$RUN/config" XDG_STATE_HOME="$RUN/state" XDG_CACHE_HOME="$RUN/cache" \
    OPENCODE_SERVER_PASSWORD="$PW" OPENCODE_CONFIG_CONTENT="$CFG" "${IU_ENV[@]}" \
    OTEL_EXPORTER_OTLP_ENDPOINT="$OTLP" OTEL_SERVICE_NAME=opencode-spike \
    "$BIN" serve --hostname localhost --port "$PORT" > "$RUN/server.log" 2>&1 &
  echo $! > "$RUN/server.pid"
)
trap 'kill "$(cat "$RUN/server.pid")" 2>/dev/null || true' EXIT

# /api/info answers 401 without credentials on 2.0.32 (the docs say it needs none); poll with auth.
for _ in $(seq 1 60); do
  curl -fsS -m 2 -u "opencode:$PW" "http://localhost:$PORT/api/info" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 5 -u "opencode:$PW" "http://localhost:$PORT/api/info" >/dev/null || { echo "server did not start; see $RUN/server.log" >&2; exit 1; }

hit() { # <label> <curl args...>
  local label="$1"; shift
  printf '%s: ' "$label"
  curl -sS -m 10 -o /dev/null -w '%{http_code}\n' -H "traceparent: $TP" "$@" || true
}
hit "GET /api/info (basic auth)    " -u "opencode:$PW" "http://localhost:$PORT/api/info"
hit "GET /api/session (basic auth) " -u "opencode:$PW" "http://localhost:$PORT/api/session"
hit "GET /api/session/active       " -u "opencode:$PW" "http://localhost:$PORT/api/session/active"
hit "GET /api/session (no auth,401)" "http://localhost:$PORT/api/session"

if [[ "$MODE" == "--session" ]]; then
  api() { curl -sS -m 30 -u "opencode:$PW" -H "traceparent: $TP" -H 'content-type: application/json' "$@"; }
  SID="$(api -X POST "http://localhost:$PORT/api/session" \
        -d "{\"location\":{\"directory\":\"$RUN/home\"},\"model\":{\"providerID\":\"iu-chat\",\"id\":\"deepseek-v4.1-flash\"}}" \
        | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["data"]["id"])')"
  echo "session: created"
  api -X POST "http://localhost:$PORT/api/session/$SID/prompt" -d '{"text":"Reply with the single word OK."}' -o /dev/null -w 'prompt: %{http_code}\n'
  # wait for the episode to finish (agw does the same); no timeout around the agent run.
  curl -sS -u "opencode:$PW" -H "traceparent: $TP" -X POST "http://localhost:$PORT/api/experimental/session/$SID/wait" -o /dev/null -w 'wait: %{http_code}\n' || true
  api "http://localhost:$PORT/api/session/$SID/message" -o "$RUN/messages.json" -w 'messages: %{http_code}\n'
fi

sleep 6   # let the exporter's batch interval pass
echo "server log tail:"; tail -5 "$RUN/server.log" | cut -c1-200

# ---- what reached ClickHouse (the local ClickStack) --------------------------------------------
sleep 3
python3 -I - "$TRACE" <<'PY'
import json, sys, urllib.request
trace = sys.argv[1]
def ch(sql):
    raw = urllib.request.urlopen(urllib.request.Request("http://localhost:8123/", data=(sql + " FORMAT JSONEachRow").encode(), method="POST")).read().decode()
    return [json.loads(l) for l in raw.splitlines() if l.strip()]
print("\n== spans in the supplied trace (parent should be the supplied span id)")
for r in ch(f"SELECT SpanName, SpanKind, substring(ParentSpanId,1,8) AS parent8, SpanAttributes['http.route'] AS route, SpanAttributes['http.response.status_code'] AS status FROM default.otel_traces WHERE TraceId = '{trace}' ORDER BY Timestamp"):
    print(" ", r)
print("\n== where did the session RUN spans go? (largest opencode traces from the last 10 minutes)")
for r in ch("SELECT substring(TraceId,1,8) AS trace8, count() AS spans, countIf(ParentSpanId = '') AS roots, anyIf(SpanName, ParentSpanId = '') AS root_span FROM default.otel_traces WHERE ServiceName = 'opencode' AND Timestamp > now() - INTERVAL 10 MINUTE GROUP BY trace8 ORDER BY spans DESC LIMIT 3"):
    print(" ", r)
print("\n== the LLM call span: attribute keys that identify the session (values not printed)")
for r in ch("SELECT arraySort(arrayFilter(k -> k LIKE '%session%', mapKeys(SpanAttributes))) AS session_keys FROM default.otel_traces WHERE ServiceName = 'opencode' AND SpanName = 'http.client POST' AND Timestamp > now() - INTERVAL 10 MINUTE LIMIT 1"):
    print(" ", r)
print("\n== span names in the run (top 12 by count)")
for r in ch("SELECT SpanName, count() AS n FROM default.otel_traces WHERE ServiceName = 'opencode' AND Timestamp > now() - INTERVAL 10 MINUTE GROUP BY SpanName ORDER BY n DESC LIMIT 12"):
    print(" ", r)
PY
