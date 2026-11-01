#!/bin/zsh
# The inference gateway's launcher: the ProgramArguments of com.jkrumm.agent-workflows-gateway. It runs from a build
# directory (~/.agent-workflows/gateway/<build>: gateway.js, this script, .env.gateway.tpl), never from a release.
# Fail-closed exactly like launch.sh: exit 78 unless every ref in .env.gateway.tpl resolves through `secrets-run` (the
# offline cache) to a non-empty value; refs are named, values never printed.
#
# It reads only .env.gateway.tpl. It never reads ~/.config/agw/iu.env, athena-iu.env or routes.json: iu.env on the mini
# sets the Athena team key, which belongs to Athena Teamchat only; the gateway holds the personal key (IU_KEY_ID=personal).

set -u

DIR="${0:A:h}"  # <build dir>/launch-gateway.sh -> the build dir
cd "$DIR" || { print -u2 "agent-workflows-gateway: cannot cd to $DIR"; exit 78; }

[[ -f "$DIR/gateway.js" ]] || { print -u2 "agent-workflows-gateway: $DIR/gateway.js missing"; exit 78; }

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# `timeout` is a Homebrew coreutils binary (macOS ships none); a missing one must not read as an unrelated error.
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
else
  print -u2 "agent-workflows-gateway: neither 'timeout' nor 'gtimeout' on PATH (brew install coreutils)"
  exit 78
fi

SECRETS_RUN="$HOME/.local/bin/secrets-run"
TPL="$DIR/.env.gateway.tpl"

[[ -x "$SECRETS_RUN" ]] || { print -u2 "agent-workflows-gateway: $SECRETS_RUN missing"; exit 78; }
[[ -f "$TPL" ]]         || { print -u2 "agent-workflows-gateway: $TPL missing"; exit 78; }
command -v bun >/dev/null 2>&1 || { print -u2 "agent-workflows-gateway: bun not on PATH"; exit 78; }

# Every ref must resolve BEFORE the hand-off: an unresolved ref would otherwise reach the process as nothing at all.
RENDERED=$("$TIMEOUT_BIN" 20 "$SECRETS_RUN" export --env-file="$TPL" 2>/dev/null | /usr/bin/grep -c '^export ')
WANT=$(/usr/bin/grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=' "$TPL" | /usr/bin/sort -u | /usr/bin/wc -l | /usr/bin/tr -d ' ')
if [[ -z "$RENDERED" || "$RENDERED" -lt "$WANT" ]]; then
  print -u2 "agent-workflows-gateway: only ${RENDERED:-0}/$WANT refs of .env.gateway.tpl resolved; refusing to start."
  # Name the refs that do not resolve (the ref, never a value). Failure path only: one read per ref.
  /usr/bin/grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=op://[^[:space:]]+' "$TPL" | while IFS='=' read -r key ref; do
    "$TIMEOUT_BIN" 20 "$SECRETS_RUN" read "$ref" >/dev/null 2>&1 || print -u2 "  unresolved: $key ($ref)"
  done
  print -u2 "  Seed the missing refs (add to dotfiles-private/headless.refs, then \`make secrets-seed\` on the MacBook) and retry."
  exit 78
fi

# A ref can resolve to an empty value; that is as unusable as a missing one. Checked inside the child, where the values
# exist: the key is named, the value never printed. Keys come from the template, so `eval` sees only names.
KEYS=( ${(f)"$(/usr/bin/grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=' "$TPL" | /usr/bin/tr -d =)"} )

# secrets-run resolves whole-value refs only, so the composite values are built after it, inside its child: the usage
# database URL (role usage, database shared; the password URL-encoded the way launch.sh does) and the OTLP header. The raw
# USAGE_PG_PASSWORD and OTEL_EXPORTER_OTLP_AUTHORIZATION are dropped before the gateway starts. IU_KEY_ID is a constant:
# this process only ever holds the personal key. The pool keys the gateway resolves itself (`secrets-run read`, on PATH).
exec "$SECRETS_RUN" run --env-file="$TPL" -- /bin/sh -c '
  for key in "$@"; do
    eval "value=\${$key-}"
    [ -n "$value" ] || { echo "agent-workflows-gateway: $key resolved to an empty value; refusing to start." >&2; exit 78; }
  done
  USAGE_PG_URL="postgres://usage:$(bun -e "process.stdout.write(encodeURIComponent(process.env.USAGE_PG_PASSWORD))")@127.0.0.1:5432/shared"
  OTEL_EXPORTER_OTLP_HEADERS="authorization=$OTEL_EXPORTER_OTLP_AUTHORIZATION"
  IU_KEY_ID=personal
  export USAGE_PG_URL OTEL_EXPORTER_OTLP_HEADERS IU_KEY_ID
  unset USAGE_PG_PASSWORD OTEL_EXPORTER_OTLP_AUTHORIZATION
  exec bun gateway.js
' sh "${KEYS[@]}"
