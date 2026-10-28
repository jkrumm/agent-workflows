#!/bin/zsh
# agent-workflows deploy (`make deploy`): the dedicated clone ~/.agent-workflows/app is checked out at origin/master
# (detached, clean), deps installed, the LaunchAgent rendered and (re)bootstrapped, /health awaited, the sha recorded,
# then the CLI linked and its env file written. The dev checkout is never what runs.
#
# DRY_RUN=1 prints the rendered plist and every action, and touches nothing (no fetch, no launchd, no ~/.local/bin).
#
# Everything lives inside `main`, called on the last line: this file is tracked in the repo the deploy checks out,
# so the checkout can rewrite it mid-run. zsh parses a function body as one unit at definition time, so the running
# body is unaffected. After the checkout `main` re-executes the clone's copy once, so the orchestration that runs
# always matches the code being deployed.

set -u

LABEL="com.jkrumm.agent-workflows-host"
ROOT="${AGW_ROOT:-$HOME/.agent-workflows}"
APP_DIR="$ROOT/app"
DATA_DIR="$ROOT/data"
SHA_FILE="$DATA_DIR/deployed-sha"
PORT=7791
HEALTH_URL="http://127.0.0.1:$PORT/health"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
OUT_LOG="$HOME/Library/Logs/agent-workflows-host.out.log"
ERR_LOG="$HOME/Library/Logs/agent-workflows-host.err.log"
BIN_DIR="$HOME/.local/bin"
CLI_LINK="$BIN_DIR/agw"
CLI_ENTRY="$APP_DIR/packages/cli/bin/agw.ts"
ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/agw/env"
API_SECRET_REF="op://mini/agent-workflows/API_SECRET"
# A cold start migrates the journal and may adopt or boot the OpenCode server lazily (not at boot): 120 s is generous.
HEALTH_WAIT_SECS="${HEALTH_WAIT_SECS:-120}"
SELF="${0:A}"
SELF_DIR="${SELF:h}"
LOCK="$DATA_DIR/deploy.lock"
DRY_RUN="${DRY_RUN:-}"

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

log() { print "[deploy] $*"; }
die() { print -u2 "[deploy] ERROR: $*"; exit 1; }

# Print an action in a dry run, run it otherwise.
act() {
  if [[ -n "$DRY_RUN" ]]; then print "[dry-run] would run: $*"; return 0; fi
  "$@"
}

# The dotfiles heartbeat pages on every restart of a KeepAlive job; one epoch line marks this one deliberate.
# Best-effort: a failed write costs a false page, never a deploy.
mark_deliberate_restart() {
  local dir="$HOME/.local/state/devhost/deliberate-restart"
  mkdir -p "$dir" 2>/dev/null && date +%s >> "$dir/$1" 2>/dev/null || true
}

render_plist() {  # $1 template, $2 sha -> stdout
  /usr/bin/sed -e "s|__HOME__|$HOME|g" -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__SHA__|$2|g" "$1"
}

tail_logs() {
  local f
  for f in "$ERR_LOG" "$OUT_LOG"; do
    [[ -f "$f" ]] && { print -u2 "--- tail -n 40 $f"; tail -n 40 "$f" >&2; }
  done
}

wait_unloaded() {
  local i=0
  while (( i < 30 )) && launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; do sleep 1; i=$((i + 1)); done
}

# The host answers /health with its version (AGW_VERSION = the deployed sha); only the new process reports it.
wait_healthy() {  # $1 sha
  local i=0 body
  while (( i < HEALTH_WAIT_SECS )); do
    if body=$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null) \
      && [[ "$(print -r -- "$body" | jq -r '.status + " " + .version' 2>/dev/null)" == "ok $1" ]]; then
      return 0
    fi
    sleep 1; i=$((i + 1))
  done
  return 1
}

write_env_file() {
  local secret
  secret=$(secrets-run read "$API_SECRET_REF" 2>/dev/null)
  [[ -n "$secret" ]] || die "cannot read $API_SECRET_REF through secrets-run (seed it: make secrets-seed on the MacBook)"
  # umask 077 before the file exists: never world-readable, not even briefly. Temp file + rename = atomic.
  (
    umask 077
    mkdir -p "${ENV_FILE:h}"
    tmp="$ENV_FILE.tmp.$$"
    print -r -- "AGW_URL=http://127.0.0.1:$PORT" > "$tmp"
    print -r -- "AGW_API_SECRET=$secret" >> "$tmp"
    chmod 600 "$tmp" && mv -f "$tmp" "$ENV_FILE"
  ) || die "writing $ENV_FILE failed"
}

main() {
  local repo_url sha template

  # --- preflight: everything that can refuse does so before the running host is touched
  local tool
  for tool in git bun curl jq secrets-run launchctl; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH"
  done
  if [[ -e "$CLI_LINK" && ! -L "$CLI_LINK" ]]; then
    die "$CLI_LINK is a regular file; refusing to replace it (remove it, then deploy again)"
  fi

  repo_url="${AGW_REPO_URL:-$(git -C "$SELF_DIR" remote get-url origin 2>/dev/null)}"

  if [[ -n "$DRY_RUN" ]]; then
    local repo_root="${SELF_DIR:h}"
    sha=$(git -C "$repo_root" rev-parse origin/master 2>/dev/null || print "<origin/master sha>")
    log "DRY RUN: nothing is changed. Deploy clone $APP_DIR, label $LABEL, sha ${sha[1,12]}"
    [[ -d "$APP_DIR/.git" ]] || act git clone "${repo_url:-<origin url>}" "$APP_DIR"
    act git -C "$APP_DIR" fetch --prune origin master
    act git -C "$APP_DIR" checkout --force --detach origin/master
    act git -C "$APP_DIR" clean -fd
    act bun install --frozen-lockfile "(in $APP_DIR)"
    log "rendered $PLIST:"
    render_plist "$repo_root/deploy/$LABEL.plist.template" "$sha"
    act launchctl bootout "gui/$(id -u)/$LABEL"
    act launchctl bootstrap "gui/$(id -u)" "$PLIST"
    act "wait up to ${HEALTH_WAIT_SECS}s for $HEALTH_URL = ok, version $sha"
    act "write $SHA_FILE"
    act ln -sf "$CLI_ENTRY" "$CLI_LINK"
    act "write $ENV_FILE (mode 0600; AGW_URL=http://127.0.0.1:$PORT, AGW_API_SECRET=<redacted>, read from $API_SECRET_REF)"
    return 0
  fi

  # --- one deploy at a time
  mkdir -p "$DATA_DIR" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$BIN_DIR"
  if ! mkdir "$LOCK" 2>/dev/null; then
    local holder; holder=$(cat "$LOCK/pid" 2>/dev/null)
    if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then die "another deploy is running (pid $holder)"; fi
    rm -rf "$LOCK"; mkdir "$LOCK" || die "cannot take $LOCK"
  fi
  print $$ > "$LOCK/pid"
  trap 'rm -rf "$LOCK"' EXIT

  # --- the clone: origin/master, detached and clean
  if [[ ! -d "$APP_DIR/.git" ]]; then
    [[ -n "$repo_url" ]] || die "no origin url (set AGW_REPO_URL)"
    log "cloning $repo_url -> $APP_DIR"
    git clone --quiet "$repo_url" "$APP_DIR" || die "git clone failed"
  fi
  git -C "$APP_DIR" fetch --quiet --prune origin master || die "git fetch origin master failed (network or credential helper)"
  git -C "$APP_DIR" checkout --quiet --force --detach origin/master || die "checkout origin/master failed"
  git -C "$APP_DIR" clean -fdq || die "git clean failed"
  sha=$(git -C "$APP_DIR" rev-parse HEAD)

  # The checkout may have replaced this script: continue with the clone's copy, once.
  if [[ -z "${AGW_DEPLOY_REEXEC:-}" && "$SELF" != "$APP_DIR/scripts/deploy.sh" ]]; then
    trap - EXIT; rm -rf "$LOCK"
    AGW_DEPLOY_REEXEC=1 exec /bin/zsh "$APP_DIR/scripts/deploy.sh"
  fi

  log "deploying ${sha[1,12]}"
  (cd "$APP_DIR" && bun install --frozen-lockfile) || die "bun install failed; the running host is untouched"
  chmod +x "$APP_DIR/scripts/"*.sh "$CLI_ENTRY"

  # --- LaunchAgent
  template="$APP_DIR/deploy/$LABEL.plist.template"
  [[ -f "$template" ]] || die "$template missing"
  render_plist "$template" "$sha" > "$PLIST.tmp.$$" && mv -f "$PLIST.tmp.$$" "$PLIST" || die "rendering $PLIST failed"
  plutil -lint "$PLIST" >/dev/null || die "rendered plist is invalid: $PLIST"

  mark_deliberate_restart "$LABEL"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  wait_unloaded
  launchctl bootstrap "gui/$(id -u)" "$PLIST" || die "launchctl bootstrap failed"

  log "waiting up to ${HEALTH_WAIT_SECS}s for $HEALTH_URL (version ${sha[1,12]})"
  if ! wait_healthy "$sha"; then
    print -u2 "[deploy] ERROR: ${sha[1,12]} did not become healthy within ${HEALTH_WAIT_SECS}s; deployed-sha NOT updated"
    tail_logs
    return 1
  fi

  local tmp="$SHA_FILE.tmp.$$"
  print -r -- "$sha" > "$tmp" && mv -f "$tmp" "$SHA_FILE" || die "writing $SHA_FILE failed"

  # --- the CLI
  ln -sf "$CLI_ENTRY" "$CLI_LINK" || die "linking $CLI_LINK failed"
  write_env_file
  log "deploy OK: ${sha[1,12]} healthy; agw -> $CLI_LINK, credentials in $ENV_FILE"
}

main
