#!/bin/zsh
# agent-workflows host launcher: the ProgramArguments of com.jkrumm.agent-workflows-host. Never point launchd at a
# Homebrew binary directly (macOS BTM silently disallows it); this wrapper is the indirection, and it fails closed
# (exit 78) unless every ref in .env.tpl resolves. Runs from a release (~/.agent-workflows/releases/<sha>, the one
# the plist names), never the dev checkout. No secret is ever printed: the export is only counted, refs are named, values never.

set -u

DIR="${0:A:h:h}"  # scripts/launch.sh -> repo root
cd "$DIR" || { print -u2 "agent-workflows-host: cannot cd to $DIR"; exit 78; }

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
# password is URL-encoded the way `make check` does it; the raw AGW_PG_PASSWORD and OTEL_EXPORTER_OTLP_AUTHORIZATION
# are dropped before the host starts. The built OTEL_EXPORTER_OTLP_HEADERS (`authorization=<ClickStack ingest key>`)
# stays: it is what the exporter reads, and the OpenCode server's env allow-list forwards every OTEL_EXPORTER_OTLP_*
# variable, so the ingest key is also in that server's env and its tool shells, like the IU key (accepted risk:
# packages/opencode-host/README.md, "Accepted risk").
exec "$SECRETS_RUN" run --env-file="$TPL" -- /bin/sh -c '
  # >>> iu-override
  # An untracked IU key override (a team key for interim evals): $HOME/.config/agw/iu.env, mode 0600, may set
  # IU_API_KEY and IU_KEY_ID, which replace the .env.tpl values; the label goes with the key, so both are required.
  # Both are validated here (a non-empty key, an exact label), before the empty-value check below. Any other line is
  # ignored with a warning that names the variable, never a value. Absent file = no override.
  IU_OVERRIDE="$HOME/.config/agw/iu.env"
  if [ -e "$IU_OVERRIDE" ] || [ -L "$IU_OVERRIDE" ]; then
    if [ "$(/bin/ls -ld "$IU_OVERRIDE" | /usr/bin/cut -c1-10)" != "-rw-------" ]; then
      echo "agent-workflows-host: $IU_OVERRIDE must be a regular file with mode 0600 (it holds a key); refusing to start." >&2
      exit 78
    fi
    iu_seen=""
    iu_cr=$(printf "\\r")
    iu_sq=$(printf "\\047")
    while IFS= read -r iu_line || [ -n "$iu_line" ]; do
      iu_line="${iu_line%"$iu_cr"}"
      iu_line="${iu_line#"${iu_line%%[![:space:]]*}"}"
      case "$iu_line" in ""|"#"*) continue ;; esac
      iu_line="${iu_line#export }"
      case "$iu_line" in *=*) ;; *) echo "agent-workflows-host: $IU_OVERRIDE: a line without = was ignored" >&2; continue ;; esac
      iu_name="${iu_line%%=*}"
      iu_value="${iu_line#*=}"
      case "$iu_value" in
        \"*\") iu_value="${iu_value#\"}"; iu_value="${iu_value%\"}" ;;
        "$iu_sq"*"$iu_sq") iu_value="${iu_value#"$iu_sq"}"; iu_value="${iu_value%"$iu_sq"}" ;;
      esac
      case "$iu_name" in
        IU_API_KEY) IU_API_KEY="$iu_value"; iu_seen="$iu_seen key" ;;
        IU_KEY_ID) IU_KEY_ID="$iu_value"; iu_seen="$iu_seen id" ;;
        ""|[0-9]*|*[!A-Za-z0-9_]*) echo "agent-workflows-host: $IU_OVERRIDE: a malformed line was ignored" >&2 ;;
        *) echo "agent-workflows-host: $IU_OVERRIDE: ignoring $iu_name (only IU_API_KEY and IU_KEY_ID are read)" >&2 ;;
      esac
    done < "$IU_OVERRIDE"
    case "$iu_seen" in
      *key*id* | *id*key*) ;;
      *)
        echo "agent-workflows-host: $IU_OVERRIDE must set both IU_API_KEY and IU_KEY_ID (the label goes with the key); refusing to start." >&2
        exit 78
        ;;
    esac
    [ -n "$IU_API_KEY" ] || { echo "agent-workflows-host: $IU_OVERRIDE: IU_API_KEY is empty; refusing to start." >&2; exit 78; }
    case "$IU_KEY_ID" in
      personal | athena-team) ;;
      *) echo "agent-workflows-host: $IU_OVERRIDE: IU_KEY_ID must be exactly personal or athena-team; refusing to start." >&2; exit 78 ;;
    esac
    export IU_API_KEY IU_KEY_ID
  fi
  # <<< iu-override
  # >>> routes-override
  # An untracked route override (which model and spend every run gets, e.g. an eval of another model):
  # $HOME/.config/agw/routes.json, one JSON object of route id -> partial route spec, exported as AGW_ROUTES. It must be
  # a regular file (no symlink) owned by this user and not group- or world-writable, and parse as a JSON object with the
  # host bun; else the host refuses to start (78), naming the file, never its content. The file wins over an AGW_ROUTES
  # already in the environment. Only the route ids are logged. Absent file = no override, the environment untouched.
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
    routes_ids=$(AGW_ROUTES_FILE="$ROUTES_OVERRIDE" bun -e "
      try {
        const v = JSON.parse(require(\"fs\").readFileSync(process.env.AGW_ROUTES_FILE, \"utf8\"))
        if (!v || typeof v !== \"object\" || Array.isArray(v)) process.exit(3)
        process.stdout.write(Object.keys(v).join(\",\"))
      } catch {
        process.exit(3)
      }
    " 2>/dev/null) || { echo "agent-workflows-host: $ROUTES_OVERRIDE is not a JSON object; refusing to start." >&2; exit 78; }
    AGW_ROUTES=$(/bin/cat "$ROUTES_OVERRIDE")
    export AGW_ROUTES
    echo "agent-workflows-host: route override active from $ROUTES_OVERRIDE (routes: ${routes_ids:-none})" >&2
  fi
  # <<< routes-override
  for key in "$@"; do
    eval "value=\${$key-}"
    [ -n "$value" ] || { echo "agent-workflows-host: $key resolved to an empty value; refusing to start." >&2; exit 78; }
  done
  AGW_PG_URL="postgres://agent_workflows:$(bun -e "process.stdout.write(encodeURIComponent(process.env.AGW_PG_PASSWORD))")@127.0.0.1:5432/agent_workflows"
  OTEL_EXPORTER_OTLP_HEADERS="authorization=$OTEL_EXPORTER_OTLP_AUTHORIZATION"
  export AGW_PG_URL OTEL_EXPORTER_OTLP_HEADERS
  unset AGW_PG_PASSWORD OTEL_EXPORTER_OTLP_AUTHORIZATION
  exec bun packages/host/src/main.ts
' sh "${KEYS[@]}"
