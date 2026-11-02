#!/bin/zsh
# agent-workflows process launcher: the ProgramArguments of every platform process's LaunchAgent,
# `launch.sh [host|audio]` (default host: com.jkrumm.agent-workflows-host; audio: com.jkrumm.agent-workflows-audio).
# Never point launchd at a Homebrew binary directly (macOS BTM silently disallows it); this wrapper is the indirection,
# and it fails closed (exit 78) per process unless every ref in .env.tpl resolves. Runs from a release
# (~/.agent-workflows/releases/<sha>, the one the plist names), never the dev checkout. No secret is ever printed: the
# export is only counted, refs are named, values never.

set -u

DIR="${0:A:h:h}"  # scripts/launch.sh -> repo root
cd "$DIR" || { print -u2 "agent-workflows-host: cannot cd to $DIR"; exit 78; }

PROCESS="${1:-host}"
case "$PROCESS" in
  host) AGW_LAUNCH_ENTRY="packages/host/src/main.ts" ;;
  audio) AGW_LAUNCH_ENTRY="packages/audio/src/main.ts" ;;
  *) print -u2 "agent-workflows-host: unknown process '$PROCESS' (host or audio)"; exit 78 ;;
esac
[[ -f "$DIR/$AGW_LAUNCH_ENTRY" ]] || { print -u2 "agent-workflows-$PROCESS: $AGW_LAUNCH_ENTRY missing"; exit 78; }
# Read by the secrets-run child below: the values that differ between the processes.
AGW_LAUNCH_PROCESS="$PROCESS"
export AGW_LAUNCH_ENTRY AGW_LAUNCH_PROCESS

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# `timeout` is a Homebrew coreutils binary (macOS ships none); a missing one must not read as an unrelated error.
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
else
  print -u2 "agent-workflows-host: neither 'timeout' nor 'gtimeout' on PATH (brew install coreutils)"
  exit 78
fi

SECRETS_RUN="$HOME/.local/bin/secrets-run"
TPL="$DIR/.env.tpl"

[[ -x "$SECRETS_RUN" ]] || { print -u2 "agent-workflows-host: $SECRETS_RUN missing"; exit 78; }
[[ -f "$TPL" ]]         || { print -u2 "agent-workflows-host: $TPL missing"; exit 78; }
command -v bun >/dev/null 2>&1 || { print -u2 "agent-workflows-host: bun not on PATH"; exit 78; }

# Every ref must resolve BEFORE the hand-off: an unresolved ref would otherwise reach the process as nothing at all.
RENDERED=$("$TIMEOUT_BIN" 20 "$SECRETS_RUN" export --env-file="$TPL" 2>/dev/null | /usr/bin/grep -c '^export ')
WANT=$(/usr/bin/grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=' "$TPL" | /usr/bin/sort -u | /usr/bin/wc -l | /usr/bin/tr -d ' ')
if [[ -z "$RENDERED" || "$RENDERED" -lt "$WANT" ]]; then
  print -u2 "agent-workflows-host: only ${RENDERED:-0}/$WANT refs of .env.tpl resolved; refusing to start."
  # Name the refs that do not resolve (the ref, never a value). Failure path only: one read per ref.
  /usr/bin/grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=op://[^[:space:]]+' "$TPL" | while IFS='=' read -r key ref; do
    "$TIMEOUT_BIN" 20 "$SECRETS_RUN" read "$ref" >/dev/null 2>&1 || print -u2 "  unresolved: $key ($ref)"
  done
  print -u2 "  Seed the missing refs (add to dotfiles-private/headless.refs, then \`make secrets-seed\` on the MacBook) and retry."
  exit 78
fi

# A ref can resolve to an empty value; that is as unusable as a missing one. Checked inside the child, where the
# values exist: the key is named, the value never printed. Keys come from the template, so `eval` sees only names.
KEYS=( ${(f)"$(/usr/bin/grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=' "$TPL" | /usr/bin/tr -d =)"} )

# secrets-run resolves whole-value refs only, so the composite values are built after it, inside its child. The
# password is URL-encoded the way `make check` does it (the usage database URL the same way: role usage, database
# shared). USAGE_PG_PASSWORD is a required deploy secret like every other ref in .env.tpl: unresolved or empty, this script
# exits 78 and the process never starts, so the usage outbox is never "off" on a deployed host (seed the ref before the
# deploy that needs it). The raw AGW_PG_PASSWORD, USAGE_PG_PASSWORD and OTEL_EXPORTER_OTLP_AUTHORIZATION are dropped before the host
# starts. The built OTEL_EXPORTER_OTLP_HEADERS (`authorization=<ClickStack ingest key>`)
# stays: it is what the exporter reads, and the OpenCode server's env allow-list forwards every OTEL_EXPORTER_OTLP_*
# variable, so the ingest key is also in that server's env and its tool shells, like the agw-opencode door token
# (accepted risk: packages/opencode-host/README.md, "Accepted risk"). The host holds no provider key: every model call
# goes through the gateway (AGW_GATEWAY_URL).
exec "$SECRETS_RUN" run --env-file="$TPL" -- /bin/sh -c '
  # >>> gateway-tool-token
  # The host only (the OpenCode providers and `ocr` call the gateway as the caller agw-opencode): the agw-opencode line of
  # the door-tokens file ($AGW_DOOR_CALLERS_FILE, which the plist sets) becomes AGW_GATEWAY_TOOL_TOKEN. Parsed the way the
  # door-token parser reads a line (name=token, whitespace around both trimmed, CR dropped, # comments skipped). A missing
  # file, a missing line or an empty token refuses with 78, naming the file and the caller, never a value. `make deploy`
  # adds the line before it starts anything. The audio process never gets the token.
  if [ "$AGW_LAUNCH_PROCESS" = host ]; then
    TOOL_TOKENS="${AGW_DOOR_CALLERS_FILE:-$HOME/.agent-workflows/data/door-tokens}"
    [ -f "$TOOL_TOKENS" ] && [ -r "$TOOL_TOKENS" ] || {
      echo "agent-workflows-host: $TOOL_TOKENS is missing or unreadable (it must hold the caller agw-opencode; make deploy writes it); refusing to start." >&2
      exit 78
    }
    AGW_GATEWAY_TOOL_TOKEN=""
    tt_cr=$(printf "\\r")
    while IFS= read -r tt_line || [ -n "$tt_line" ]; do
      tt_line="${tt_line%"$tt_cr"}"
      case "$tt_line" in *=*) ;; *) continue ;; esac
      tt_name="${tt_line%%=*}"
      tt_name="${tt_name#"${tt_name%%[![:space:]]*}"}"
      tt_name="${tt_name%"${tt_name##*[![:space:]]}"}"
      [ "$tt_name" = agw-opencode ] || continue
      tt_token="${tt_line#*=}"
      tt_token="${tt_token#"${tt_token%%[![:space:]]*}"}"
      tt_token="${tt_token%"${tt_token##*[![:space:]]}"}"
      AGW_GATEWAY_TOOL_TOKEN="$tt_token"
      break
    done < "$TOOL_TOKENS"
    [ -n "$AGW_GATEWAY_TOOL_TOKEN" ] || {
      echo "agent-workflows-host: $TOOL_TOKENS has no token for the caller agw-opencode (make deploy adds it); refusing to start." >&2
      exit 78
    }
    export AGW_GATEWAY_TOOL_TOKEN
  fi
  # <<< gateway-tool-token
  # >>> routes-override
  # An untracked route override (which model and spend every run gets, e.g. an eval of another model):
  # $HOME/.config/agw/routes.json, one JSON object of route id -> partial route spec, exported as AGW_ROUTES. It must be
  # a regular file (no symlink) owned by this user and not group- or world-writable. It is read ONCE into a variable,
  # that string is validated with the routes package own validator (the same one the host runs at boot), and exactly that
  # string is exported. A file that fails is refused with 78 and the validator message, which names the file, the route
  # id and the problem, never a value or the parser text. 78 retries at the plist ThrottleInterval, not in a tight loop,
  # but a deploy whose new release refuses the file is rolled back to the previous release, which does not read it:
  # fix the file before the deploy. The file wins over an AGW_ROUTES already in the environment. Only the validated
  # route ids are logged. Absent file = no override, the environment untouched.
  ROUTES_OVERRIDE="$HOME/.config/agw/routes.json"
  if [ -e "$ROUTES_OVERRIDE" ] || [ -L "$ROUTES_OVERRIDE" ]; then
    routes_mode=$(/bin/ls -ld "$ROUTES_OVERRIDE" | /usr/bin/cut -c1-10)
    case "$routes_mode" in
      -?????????) ;;
      *) echo "agent-workflows-host: $ROUTES_OVERRIDE must be a regular file, not a symlink or directory; refusing to start." >&2; exit 78 ;;
    esac
    [ -O "$ROUTES_OVERRIDE" ] || { echo "agent-workflows-host: $ROUTES_OVERRIDE must be owned by the user running the host; refusing to start." >&2; exit 78; }
    routes_gw=$(printf "%s" "$routes_mode" | /usr/bin/cut -c6)
    routes_ow=$(printf "%s" "$routes_mode" | /usr/bin/cut -c9)
    if [ "$routes_gw" = "w" ] || [ "$routes_ow" = "w" ]; then
      echo "agent-workflows-host: $ROUTES_OVERRIDE must not be group- or world-writable (it steers the model and spend of every run); refusing to start." >&2
      exit 78
    fi
    routes_json=$(/bin/cat "$ROUTES_OVERRIDE")
    case "$routes_json" in
      *[![:space:]]*) ;;
      *) echo "agent-workflows-host: $ROUTES_OVERRIDE is empty; refusing to start." >&2; exit 78 ;;
    esac
    # Run from packages/host: with the isolated install, only a package own node_modules links the workspace packages.
    # The validator answers on stdout (the ids, or its own message with exit 3); stderr is dropped, so bun warnings or a
    # failed import never pass for ids or for a message about the file.
    routes_ids=$(cd packages/host && AGW_ROUTES="$routes_json" bun -e "
      const { validateOverrides } = await import(\"@agent-workflows/routes\")
      try {
        process.stdout.write(validateOverrides(process.env).join(\",\"))
      } catch (error) {
        process.stdout.write(error instanceof Error ? error.message : \"invalid override\")
        process.exit(3)
      }
    " 2>/dev/null) || {
      echo "agent-workflows-host: $ROUTES_OVERRIDE is invalid: ${routes_ids:-the route validator did not run (is the release bun install complete?)}; refusing to start." >&2
      exit 78
    }
    AGW_ROUTES="$routes_json"
    export AGW_ROUTES
    echo "agent-workflows-host: route override active from $ROUTES_OVERRIDE (routes: ${routes_ids:-none})" >&2
  fi
  # <<< routes-override
  for key in "$@"; do
    eval "value=\${$key-}"
    [ -n "$value" ] || { echo "agent-workflows-host: $key resolved to an empty value; refusing to start." >&2; exit 78; }
  done
  AGW_PG_URL="postgres://agent_workflows:$(bun -e "process.stdout.write(encodeURIComponent(process.env.AGW_PG_PASSWORD))")@127.0.0.1:5432/agent_workflows"
  USAGE_PG_URL="postgres://usage:$(bun -e "process.stdout.write(encodeURIComponent(process.env.USAGE_PG_PASSWORD))")@127.0.0.1:5432/shared"
  OTEL_EXPORTER_OTLP_HEADERS="authorization=$OTEL_EXPORTER_OTLP_AUTHORIZATION"
  export AGW_PG_URL USAGE_PG_URL OTEL_EXPORTER_OTLP_HEADERS
  unset AGW_PG_PASSWORD USAGE_PG_PASSWORD OTEL_EXPORTER_OTLP_AUTHORIZATION
  exec bun "$AGW_LAUNCH_ENTRY"
' sh "${KEYS[@]}"
