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
# Every platform process (concept §8) is a LaunchAgent of its own, all from the same release: the host and the audio
# process are stopped, started and awaited (each /health at the sha) together, and rolled back together. A previous
# release without a process's plist template (it predates the process) rolls that process back to booted out.
#
# DRY_RUN=1 prints the plan and every rendered plist and touches nothing (no fetch, no launchd, no ~/.local/bin).
#
# Everything lives inside `main`, called on the last line: this file is tracked in the repo the deploy exports, and
# zsh parses a function body as one unit at definition time. After the release is built `main` re-executes that
# release's copy once (pinned to the same sha), so the orchestration that runs matches the code being deployed.

set -u

# The processes, in start order. Each: a LaunchAgent label, a port, `deploy/<label>.plist.template` and its logs.
PROCESSES=(host audio)
typeset -A LABELS PORTS
LABELS=(host com.jkrumm.agent-workflows-host audio com.jkrumm.agent-workflows-audio)
PORTS=(host 7791 audio 7792)
ROOT="${AGW_ROOT:-$HOME/.agent-workflows}"
REPO_DIR="$ROOT/repo"
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"
DATA_DIR="$ROOT/data"
SHA_FILE="$DATA_DIR/deployed-sha"
PREV_FILE="$DATA_DIR/previous-sha"
KEEP_RELEASES=3
PORT="${PORTS[host]}"
DOOR_TOKENS="$DATA_DIR/door-tokens"
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

read_sha() { [[ -f "$1" ]] && tr -d '[:space:]' < "$1"; }

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
  /usr/bin/sed -e "s|__HOME__|$HOME|g" -e "s|__RELEASE_DIR__|$2|g" -e "s|__SHA__|$3|g" -e "s|__DATA_DIR__|$DATA_DIR|g" "$1"
}

template_of() { print "$1/deploy/${LABELS[$2]}.plist.template"; }  # $1 release dir, $2 process
plist_of() { print "$HOME/Library/LaunchAgents/${LABELS[$1]}.plist"; }  # $1 process
health_url() { print "http://127.0.0.1:${PORTS[$1]}/health"; }  # $1 process

tail_logs() {
  local p f
  for p in $PROCESSES; do
    for f in "$HOME/Library/Logs/agent-workflows-$p.err.log" "$HOME/Library/Logs/agent-workflows-$p.out.log"; do
      [[ -f "$f" ]] && { print -u2 "--- tail -n 40 $f"; tail -n 40 "$f" >&2; }
    done
  done
}

loaded() { launchctl print "gui/$(id -u)/${LABELS[$1]}" >/dev/null 2>&1; }  # $1 process

# SIGTERM shutdown may take up to the plist's ExitTimeOut before launchd kills a process: wait that long and a bit.
unload_wait_secs() {
  local t
  t=$(plutil -extract ExitTimeOut raw -o - "$1" 2>/dev/null)
  print $(( ${t:-120} + 10 ))
}

stop_process() {  # $1 process, $2 max seconds to wait for the unload
  loaded "$1" || return 0
  mark_deliberate_restart "${LABELS[$1]}"
  launchctl bootout "gui/$(id -u)/${LABELS[$1]}" 2>/dev/null
  local i=0
  while (( i < $2 )) && loaded "$1"; do sleep 1; i=$((i + 1)); done
  ! loaded "$1"
}

# Every process stopped (all are tried); fails naming the ones still loaded.
stop_all() {  # $1 max seconds to wait for each unload
  local p stuck=()
  for p in $PROCESSES; do stop_process "$p" "$1" || stuck+=("${LABELS[$p]}"); done
  (( ${#stuck} == 0 )) || { print -u2 "[deploy] still loaded after ${1}s: ${stuck[*]}"; return 1; }
}

start_process() {  # $1 process, $2 release dir, $3 sha
  local plist tmp
  plist=$(plist_of "$1"); tmp="$plist.tmp.$$"
  if ! { render_plist "$(template_of "$2" "$1")" "$2" "$3" > "$tmp" && plutil -lint "$tmp" >/dev/null; }; then
    print -u2 "[deploy] ERROR: rendering the plist of $1 failed ($tmp)"
    return 1
  fi
  mv -f "$tmp" "$plist" && launchctl bootstrap "gui/$(id -u)" "$plist"
}

# The processes a release has a plist template for: a rollback target may predate a process.
processes_of() {  # $1 release dir -> process names
  local p
  for p in $PROCESSES; do [[ -f "$(template_of "$1" "$p")" ]] && print "$p"; done
}

# Each process answers /health with its version (AGW_VERSION = the sha it was started for); only those count. One
# deadline for all of them, so two processes cost no more wait than one.
wait_healthy() {  # $1 sha, $2... processes
  local sha=$1; shift
  local i=0 body p pending=("$@")
  while (( i < HEALTH_WAIT_SECS )); do
    local still=()
    for p in $pending; do
      if body=$(curl -fsS --max-time 2 "$(health_url "$p")" 2>/dev/null) \
        && [[ "$(print -r -- "$body" | jq -r '.status + " " + .version' 2>/dev/null)" == "ok $sha" ]]; then
        continue
      fi
      still+=("$p")
    done
    pending=("${still[@]}")
    (( ${#pending} == 0 )) && return 0
    sleep 1; i=$((i + 1))
  done
  print -u2 "[deploy] not healthy at ${sha[1,12]}: ${pending[*]}"
  return 1
}

# The door's caller tokens (`name=token`, mode 0600): created once with a hermes token, never overwritten, never printed.
# The audio process refuses to start without the file (or with a wider mode).
ensure_door_tokens() {
  [[ -e "$DOOR_TOKENS" ]] && return 0
  (
    umask 077
    token=$(openssl rand -hex 32) && [[ ${#token} -eq 64 ]] || exit 1
    tmp="$DOOR_TOKENS.tmp.$$"
    print -r -- "hermes=$token" > "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$DOOR_TOKENS"
  ) || die "creating $DOOR_TOKENS failed"
  log "created $DOOR_TOKENS (one hermes token, mode 0600)"
}

# The door tokens read with the release's own parser (mode, owner, every line), the one the audio process starts
# with: a bad file refuses the deploy before anything is stopped, never as a rollback. Messages name the file and the
# line, never a token.
check_door_tokens() {  # $1 release dir
  local why
  why=$(cd "$1/packages/audio" && bun -e '
    const { readDoorTokens } = await import("./src/process/callers.ts")
    try {
      readDoorTokens(process.argv[1])
    } catch (error) {
      process.stdout.write(error instanceof Error ? error.message : String(error))
      process.exit(3)
    }
  ' "$DOOR_TOKENS" 2>/dev/null) || die "the door tokens are unusable: ${why:-the release could not read them}; nothing was stopped"
}

# A process left booted out must not come back at the next login (RunAtLoad) on a release that failed: its plist goes.
remove_plist() {  # $1 process
  rm -f "$(plist_of "$1")" && print -u2 "[deploy] removed $(plist_of "$1") (${LABELS[$1]} stays down)"
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

# The new build never became healthy: say so with the log tails, then put the previous release back, every process
# together (one sha live, never a mix).
roll_back() {  # $1 failed sha, $2 previous sha ("" = none), $3 unload wait
  local p
  print -u2 "[deploy] ERROR: ${1[1,12]} did not become healthy within ${HEALTH_WAIT_SECS}s"
  tail_logs
  if [[ -z "$2" ]]; then
    stop_all "$3" || print -u2 "[deploy] WARNING: could not unload every process"
    for p in $PROCESSES; do loaded "$p" || remove_plist "$p"; done
    print -u2 "[deploy] no previous release (first deploy or same sha): every process left booted out so KeepAlive does not loop a failing launch. deployed-sha unchanged."
    return 0
  fi
  print -u2 "[deploy] rolling back to ${2[1,12]}"
  if ! stop_all "$3"; then
    print -u2 "[deploy] ROLLBACK FAILED: not every process unloaded within ${3}s"
    return 0
  fi
  local back=() started=()
  back=( ${(f)"$(processes_of "$RELEASES/$2")"} )
  for p in $PROCESSES; do
    (( ${back[(Ie)$p]} )) && continue
    print -u2 "[deploy] ${2[1,12]} has no $p process: ${LABELS[$p]} left booted out"
    remove_plist "$p"
  done
  for p in $back; do start_process "$p" "$RELEASES/$2" "$2" && started+=("$p"); done
  if (( ${#started} == ${#back} )) && wait_healthy "$2" "${back[@]}"; then
    print -u2 "[deploy] rollback OK: ${2[1,12]} is healthy again (${back[*]}). deployed-sha unchanged."
  else
    stop_all "$3"
    print -u2 "[deploy] ROLLBACK FAILED: ${2[1,12]} did not become healthy either; every process left booted out."
  fi
}

# The CLI's process list (`AGW_PROCESSES`, packages/cli README): every process but the host.
processes_env() {
  local p entries=()
  for p in $PROCESSES; do [[ "$p" == host ]] || entries+=("$p=http://127.0.0.1:${PORTS[$p]}"); done
  print -r -- "AGW_PROCESSES=${(j:,:)entries}"
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
  local repo_url sha old prev="" release unload_secs env_content p

  # --- preflight: everything that can refuse does so before anything is built, stopped or written
  local tool
  for tool in git bun curl jq secrets-run launchctl plutil tar openssl; do
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
    env_content="AGW_URL=http://127.0.0.1:$PORT"$'\n'"AGW_API_SECRET=$secret"$'\n'"$(processes_env)"
  fi

  if [[ -n "$DRY_RUN" ]]; then
    local repo_root="${SELF_DIR:h}"
    sha=$(git -C "$repo_root" rev-parse origin/master 2>/dev/null || print "<origin/master sha>")
    old=$(read_sha "$SHA_FILE")
    [[ -n "$old" && "$old" != "$sha" && -f "$RELEASES/$old/.complete" ]] && prev="$old"
    release="$RELEASES/$sha"
    log "DRY RUN: nothing is changed. Release ${sha[1,12]}, live ${old:-none}, processes: ${PROCESSES[*]}"
    log "preflight: would read $API_SECRET_REF through secrets-run (value never printed)"
    [[ -d "$REPO_DIR/.git" ]] || act git clone "${repo_url:-<origin url>}" "$REPO_DIR"
    act git -C "$REPO_DIR" fetch --prune origin master
    act "git -C $REPO_DIR archive $sha | tar -x -C $release   (the live release is never written to)"
    act bun install --frozen-lockfile "(in $release)"
    act "re-exec $release/scripts/deploy.sh once, pinned to $sha"
    if [[ -e "$DOOR_TOKENS" ]]; then
      log "$DOOR_TOKENS exists: kept as is"
    else
      act "create $DOOR_TOKENS (mode 0600, one line hermes=<64 hex from openssl rand>, never printed)"
    fi
    act "check $DOOR_TOKENS with the release's readDoorTokens (mode, owner, every line) before stopping anything"
    for p in $PROCESSES; do
      log "rendered $(plist_of "$p") (points at the release, not at current):"
      render_plist "$(template_of "$repo_root" "$p")" "$release" "$sha"
    done
    act "launchctl bootout every process (${LABELS[host]} ${LABELS[audio]}), waiting up to $(unload_wait_secs "$(template_of "$repo_root" host)")s for each unload (ExitTimeOut + 10)"
    for p in $PROCESSES; do act launchctl bootstrap "gui/$(id -u)" "$(plist_of "$p")"; done
    local urls=()
    for p in $PROCESSES; do urls+=("$(health_url "$p")"); done
    act "wait up to ${HEALTH_WAIT_SECS}s for every /health (${urls[*]}) = ok, version $sha"
    if [[ -n "$prev" ]]; then
      act "on failure: print every log tail, bootout every process, re-render each process ${prev[1,12]} has a template for, bootstrap, wait for its version; remove the plist of each it has none for; exit 1"
    else
      act "on failure: print every log tail, bootout every process and remove their plists (no previous release: left down, not crash-looping, not back at login), exit 1"
    fi
    act ln -sfn "$release" "$CURRENT"
    [[ -n "$old" && "$old" != "$sha" ]] && act "write $PREV_FILE ($old)"
    act "write $ENV_FILE (mode 0600; AGW_URL=http://127.0.0.1:$PORT, AGW_API_SECRET=<redacted>, $(processes_env))"
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

  for p in $PROCESSES; do
    [[ -f "$(template_of "$release" "$p")" ]] || die "$(template_of "$release" "$p") missing"
  done
  unload_secs=$(unload_wait_secs "$(template_of "$release" host)")
  ensure_door_tokens
  check_door_tokens "$release"

  # The release that is live now is the rollback target, unless it is the one being deployed again.
  old=$(read_sha "$SHA_FILE")
  [[ -n "$old" && "$old" != "$sha" && -f "$RELEASES/$old/.complete" ]] && prev="$old"

  # --- switch
  log "deploying ${sha[1,12]} (live: ${old:-none}), stopping ${PROCESSES[*]}"
  stop_all "$unload_secs" || die "a process is still loaded ${unload_secs}s after bootout (ExitTimeOut + 10); not bootstrapping over it. It may still be shutting down: retry the deploy."
  for p in $PROCESSES; do
    if ! start_process "$p" "$release" "$sha"; then
      print -u2 "[deploy] ERROR: launchctl bootstrap failed for $p at ${sha[1,12]}"
      roll_back "$sha" "$prev" "$unload_secs"
      return 1
    fi
  done
  log "waiting up to ${HEALTH_WAIT_SECS}s for every /health (version ${sha[1,12]})"
  if ! wait_healthy "$sha" "${PROCESSES[@]}"; then
    roll_back "$sha" "$prev" "$unload_secs"
    return 1
  fi

  # --- healthy: current, the CLI, then the marker ("deployed" means the CLI is usable too)
  ln -sfn "$release" "$CURRENT" || die "updating $CURRENT failed"
  [[ -n "$old" && "$old" != "$sha" ]] && write_atomic "$PREV_FILE" "$old"
  write_env_file "$env_content"
  ln -sf "$CURRENT/packages/cli/bin/agw.ts" "$CLI_LINK" || die "linking $CLI_LINK failed"
  write_atomic "$SHA_FILE" "$sha" || die "writing $SHA_FILE failed"
  prune_releases "$sha" "$(read_sha "$PREV_FILE")"
  log "deploy OK: ${sha[1,12]} healthy (${PROCESSES[*]}); agw -> $CLI_LINK, credentials in $ENV_FILE"
}

main
