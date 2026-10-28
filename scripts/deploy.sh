#!/bin/zsh
# agent-workflows deploy (`make deploy`): releases, not an in-place clone.
#
#   ~/.agent-workflows/repo               the clone; fetch only, nothing runs from it
#   ~/.agent-workflows/releases/<sha>     one immutable export of a commit with its own node_modules
#   ~/.agent-workflows/current            symlink to the live release (the CLI link goes through it)
#   ~/.agent-workflows/data/{deployed,previous}-sha
#
# The live release is never written to: a new release is exported and installed beside it, the LaunchAgent is
# switched to it, and /health must report its sha. If it never does, the previous release is booted again (rollback)
# and the deploy exits 1. The plist points at the release path, not at `current`: the plist is then the single
# statement of what runs, and a swap of the symlink can never change a running host's code underneath it.
#
# DRY_RUN=1 prints the plan and the rendered plist and touches nothing (no fetch, no launchd, no ~/.local/bin).
#
# Everything lives inside `main`, called on the last line: this file is tracked in the repo the deploy exports, and
# zsh parses a function body as one unit at definition time. After the release is built `main` re-executes that
# release's copy once (pinned to the same sha), so the orchestration that runs matches the code being deployed.

set -u

LABEL="com.jkrumm.agent-workflows-host"
ROOT="${AGW_ROOT:-$HOME/.agent-workflows}"
REPO_DIR="$ROOT/repo"
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"
DATA_DIR="$ROOT/data"
SHA_FILE="$DATA_DIR/deployed-sha"
PREV_FILE="$DATA_DIR/previous-sha"
KEEP_RELEASES=3
PORT=7791
HEALTH_URL="http://127.0.0.1:$PORT/health"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
OUT_LOG="$HOME/Library/Logs/agent-workflows-host.out.log"
ERR_LOG="$HOME/Library/Logs/agent-workflows-host.err.log"
BIN_DIR="$HOME/.local/bin"
CLI_LINK="$BIN_DIR/agw"
ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/agw/env"
API_SECRET_REF="op://mini/agent-workflows/API_SECRET"
# A cold start migrates the journal; the OpenCode server starts lazily, not at boot: 120 s is generous.
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

read_sha() { tr -d '[:space:]' < "$1" 2>/dev/null; }

# Atomic: a reader must never see a partial file.
write_atomic() {  # $1 path, $2 content
  local tmp="$1.tmp.$$"
  print -r -- "$2" > "$tmp" && mv -f "$tmp" "$1"
}

# The dotfiles heartbeat pages on every restart of a KeepAlive job; one epoch line marks this one deliberate.
# Best-effort: a failed write costs a false page, never a deploy.
mark_deliberate_restart() {
  local dir="$HOME/.local/state/devhost/deliberate-restart"
  mkdir -p "$dir" 2>/dev/null && date +%s >> "$dir/$1" 2>/dev/null || true
}

render_plist() {  # $1 template, $2 release dir, $3 sha -> stdout
  /usr/bin/sed -e "s|__HOME__|$HOME|g" -e "s|__RELEASE_DIR__|$2|g" -e "s|__SHA__|$3|g" "$1"
}

tail_logs() {
  local f
  for f in "$ERR_LOG" "$OUT_LOG"; do
    [[ -f "$f" ]] && { print -u2 "--- tail -n 40 $f"; tail -n 40 "$f" >&2; }
  done
}

loaded() { launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; }

# SIGTERM shutdown may take up to the plist's ExitTimeOut before launchd kills the host: wait that long and a bit.
unload_wait_secs() {
  local t
  t=$(plutil -extract ExitTimeOut raw -o - "$1" 2>/dev/null)
  print $(( ${t:-120} + 10 ))
}

stop_host() {  # $1 max seconds to wait for the unload
  loaded || return 0
  mark_deliberate_restart "$LABEL"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  local i=0
  while (( i < $1 )) && loaded; do sleep 1; i=$((i + 1)); done
  ! loaded
}

start_host() {  # $1 template, $2 release dir, $3 sha
  local tmp="$PLIST.tmp.$$"
  if ! { render_plist "$1" "$2" "$3" > "$tmp" && plutil -lint "$tmp" >/dev/null; }; then
    print -u2 "[deploy] ERROR: rendering the plist failed ($tmp)"
    return 1
  fi
  mv -f "$tmp" "$PLIST" && launchctl bootstrap "gui/$(id -u)" "$PLIST"
}

# The host answers /health with its version (AGW_VERSION = the sha it was started for); only that process counts.
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

is_sha() { [[ "$1" =~ '^[0-9a-f]{40}$' ]]; }

# The only place a release is deleted: the name must be a full sha, and both path parts are guarded against empty.
remove_release() {  # $1 sha
  is_sha "$1" || die "refusing to remove '$1': not a 40-hex sha"
  rm -rf "${RELEASES:?}/${1:?}"
}

# Exports a commit and installs its dependencies beside the live release. A release with a `.complete` marker is
# reused untouched (a redeploy, a rollback target); anything else is a leftover of a failed build and is exported
# again from nothing. The marker is written last, so a half-built release can never be started; a failed build
# removes itself.
build_release() {  # $1 sha
  is_sha "$1" || die "'$1' is not a 40-hex sha"
  local dir="$RELEASES/$1"
  if [[ -f "$dir/.complete" ]]; then touch "$dir"; return 0; fi
  [[ -e "$dir" ]] && remove_release "$1"
  mkdir -p "$dir"
  git -C "$REPO_DIR" archive --format=tar "$1" | tar -x -C "$dir" || { remove_release "$1"; die "exporting $1 failed"; }
  (cd "$dir" && bun install --frozen-lockfile) || { remove_release "$1"; die "bun install failed; the live release is untouched"; }
  chmod +x "$dir/scripts/"*.sh "$dir/packages/cli/bin/agw.ts"
  touch "$dir/.complete"
}

# Keeps the newest $KEEP_RELEASES releases plus the live and the previous one; removes older ones. Only entries named
# like a sha are considered (anything else in releases/ is left alone), and only completed releases.
prune_releases() {  # $@ shas never to remove
  local -a all; local n=0 d
  all=( ${(f)"$(ls -1t "$RELEASES" 2>/dev/null)"} )
  for d in $all; do
    is_sha "$d" || continue
    [[ -f "$RELEASES/$d/.complete" ]] || continue
    n=$((n + 1))
    (( n <= KEEP_RELEASES )) && continue
    (( ${@[(Ie)$d]} )) && continue
    log "pruning release ${d[1,12]}"
    remove_release "$d"
  done
}

# The new build never became healthy: say so with its log tail, then put the previous release back.
roll_back() {  # $1 failed sha, $2 previous sha ("" = none), $3 template, $4 unload wait
  print -u2 "[deploy] ERROR: ${1[1,12]} did not become healthy within ${HEALTH_WAIT_SECS}s"
  tail_logs
  if [[ -z "$2" ]]; then
    stop_host "$4" || print -u2 "[deploy] WARNING: could not unload $LABEL"
    print -u2 "[deploy] no previous release (first deploy or same sha): $LABEL left booted out so KeepAlive does not loop a failing launch. deployed-sha unchanged."
    return 0
  fi
  print -u2 "[deploy] rolling back to ${2[1,12]}"
  if ! stop_host "$4"; then
    print -u2 "[deploy] ROLLBACK FAILED: $LABEL did not unload within ${4}s"
    return 0
  fi
  if start_host "$3" "$RELEASES/$2" "$2" && wait_healthy "$2"; then
    print -u2 "[deploy] rollback OK: ${2[1,12]} is healthy again. deployed-sha unchanged."
  else
    stop_host "$4"
    print -u2 "[deploy] ROLLBACK FAILED: ${2[1,12]} did not become healthy either; $LABEL left booted out."
  fi
}

write_env_file() {  # $1 content
  # umask 077 before the file exists: never world-readable, not even briefly. Temp file + rename = atomic.
  (
    umask 077
    mkdir -p "${ENV_FILE:h}"
    tmp="$ENV_FILE.tmp.$$"
    print -r -- "$1" > "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$ENV_FILE"
  ) || die "writing $ENV_FILE failed"
}

main() {
  local repo_url sha old prev="" release template unload_secs env_content

  # --- preflight: everything that can refuse does so before anything is built, stopped or written
  local tool
  for tool in git bun curl jq secrets-run launchctl plutil tar; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH"
  done
  if [[ -e "$CLI_LINK" && ! -L "$CLI_LINK" ]]; then
    die "$CLI_LINK is a regular file; refusing to replace it (remove it, then deploy again)"
  fi
  if [[ -e "$CURRENT" && ! -L "$CURRENT" ]]; then
    die "$CURRENT exists and is not a symlink; remove it, then deploy again"
  fi
  repo_url="${AGW_REPO_URL:-$(git -C "$SELF_DIR" remote get-url origin 2>/dev/null)}"

  if [[ -z "$DRY_RUN" ]]; then
    local secret
    secret=$(secrets-run read "$API_SECRET_REF" 2>/dev/null)
    [[ -n "$secret" ]] || die "cannot read $API_SECRET_REF through secrets-run (seed it: make secrets-seed on the MacBook); nothing was changed"
    env_content="AGW_URL=http://127.0.0.1:$PORT"$'\n'"AGW_API_SECRET=$secret"
  fi

  if [[ -n "$DRY_RUN" ]]; then
    local repo_root="${SELF_DIR:h}"
    sha=$(git -C "$repo_root" rev-parse origin/master 2>/dev/null || print "<origin/master sha>")
    old=$(read_sha "$SHA_FILE")
    [[ -n "$old" && "$old" != "$sha" && -f "$RELEASES/$old/.complete" ]] && prev="$old"
    release="$RELEASES/$sha"
    log "DRY RUN: nothing is changed. Release ${sha[1,12]}, live ${old:-none}, label $LABEL"
    log "preflight: would read $API_SECRET_REF through secrets-run (value never printed)"
    [[ -d "$REPO_DIR/.git" ]] || act git clone "${repo_url:-<origin url>}" "$REPO_DIR"
    act git -C "$REPO_DIR" fetch --prune origin master
    act "git -C $REPO_DIR archive $sha | tar -x -C $release   (the live release is never written to)"
    act bun install --frozen-lockfile "(in $release)"
    act "re-exec $release/scripts/deploy.sh once, pinned to $sha"
    log "rendered $PLIST (points at the release, not at current):"
    render_plist "$repo_root/deploy/$LABEL.plist.template" "$release" "$sha"
    act launchctl bootout "gui/$(id -u)/$LABEL" "(wait up to $(unload_wait_secs "$repo_root/deploy/$LABEL.plist.template")s for the unload, ExitTimeOut + 10)"
    act launchctl bootstrap "gui/$(id -u)" "$PLIST"
    act "wait up to ${HEALTH_WAIT_SECS}s for $HEALTH_URL = ok, version $sha"
    if [[ -n "$prev" ]]; then
      act "on failure: print the log tail, bootout, re-render for ${prev[1,12]}, bootstrap, wait for its version, exit 1"
    else
      act "on failure: print the log tail, bootout (no previous release: left booted out, not crash-looping), exit 1"
    fi
    act ln -sfn "$release" "$CURRENT"
    [[ -n "$old" && "$old" != "$sha" ]] && act "write $PREV_FILE ($old)"
    act "write $ENV_FILE (mode 0600; AGW_URL=http://127.0.0.1:$PORT, AGW_API_SECRET=<redacted>)"
    act ln -sf "$CURRENT/packages/cli/bin/agw.ts" "$CLI_LINK"
    act "write $SHA_FILE ($sha)"
    act "prune releases beyond the newest $KEEP_RELEASES (never ${sha[1,12]} or ${old:+${old[1,12]}})"
    return 0
  fi

  # --- one deploy at a time
  mkdir -p "$DATA_DIR" "$RELEASES" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$BIN_DIR"
  if ! mkdir "$LOCK" 2>/dev/null; then
    local holder; holder=$(cat "$LOCK/pid" 2>/dev/null)
    if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then die "another deploy is running (pid $holder)"; fi
    rm -rf "$LOCK"; mkdir "$LOCK" || die "cannot take $LOCK"
  fi
  print $$ > "$LOCK/pid"
  trap 'rm -rf "$LOCK"' EXIT

  # --- the release: exported and installed beside the live one
  if [[ -z "${AGW_DEPLOY_SHA:-}" ]]; then
    if [[ ! -d "$REPO_DIR/.git" ]]; then
      [[ -n "$repo_url" ]] || die "no origin url (set AGW_REPO_URL)"
      log "cloning $repo_url -> $REPO_DIR"
      git clone --quiet "$repo_url" "$REPO_DIR" || die "git clone failed"
    fi
    git -C "$REPO_DIR" fetch --quiet --prune origin master || die "git fetch origin master failed (network or credential helper)"
    sha=$(git -C "$REPO_DIR" rev-parse origin/master)
  else
    sha="$AGW_DEPLOY_SHA"
  fi
  release="$RELEASES/$sha"
  log "building release ${sha[1,12]}"
  build_release "$sha"

  # Continue with the release's own copy of this script, once.
  if [[ -z "${AGW_DEPLOY_REEXEC:-}" && "$SELF" != "${release:A}/scripts/deploy.sh" ]]; then
    trap - EXIT; rm -rf "$LOCK"
    AGW_DEPLOY_REEXEC=1 AGW_DEPLOY_SHA="$sha" exec /bin/zsh "$release/scripts/deploy.sh"
  fi

  template="$release/deploy/$LABEL.plist.template"
  [[ -f "$template" ]] || die "$template missing"
  unload_secs=$(unload_wait_secs "$template")

  # The release that is live now is the rollback target, unless it is the one being deployed again.
  old=$(read_sha "$SHA_FILE")
  [[ -n "$old" && "$old" != "$sha" && -f "$RELEASES/$old/.complete" ]] && prev="$old"

  # --- switch
  log "deploying ${sha[1,12]} (live: ${old:-none}), stopping $LABEL"
  stop_host "$unload_secs" || die "$LABEL is still loaded ${unload_secs}s after bootout (ExitTimeOut + 10); not bootstrapping over it. The old host may still be shutting down: retry the deploy."
  if ! start_host "$template" "$release" "$sha"; then
    print -u2 "[deploy] ERROR: launchctl bootstrap failed for ${sha[1,12]}"
    roll_back "$sha" "$prev" "$template" "$unload_secs"
    return 1
  fi
  log "waiting up to ${HEALTH_WAIT_SECS}s for $HEALTH_URL (version ${sha[1,12]})"
  if ! wait_healthy "$sha"; then
    roll_back "$sha" "$prev" "$template" "$unload_secs"
    return 1
  fi

  # --- healthy: current, the CLI, then the marker ("deployed" means the CLI is usable too)
  ln -sfn "$release" "$CURRENT" || die "updating $CURRENT failed"
  [[ -n "$old" && "$old" != "$sha" ]] && write_atomic "$PREV_FILE" "$old"
  write_env_file "$env_content"
  ln -sf "$CURRENT/packages/cli/bin/agw.ts" "$CLI_LINK" || die "linking $CLI_LINK failed"
  write_atomic "$SHA_FILE" "$sha" || die "writing $SHA_FILE failed"
  prune_releases "$sha" "$(read_sha "$PREV_FILE")"
  log "deploy OK: ${sha[1,12]} healthy; agw -> $CLI_LINK, credentials in $ENV_FILE"
}

main
