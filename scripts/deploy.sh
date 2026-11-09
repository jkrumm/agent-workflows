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
# The gateway (docs/gateway.md) is the third LaunchAgent, but it does not run from a release: its entry is bundled into
# one file and installed to ~/.agent-workflows/gateway/<build> (gateway.js, launch-gateway.sh, .env.gateway.tpl, the plist
# template, a `.complete` marker; immutable once complete). The build id is 16 hex of a sha256 over the bundle, the launcher,
# the env template, the plist template and `bun --version`. A deploy restarts the gateway only when its build changed (or
# it is not loaded, or not healthy at its recorded build, or data/door-tokens differs from the one it last started on,
# recorded in data/gateway-door-tokens: it reads the file only at start), so streams are not cut by unrelated deploys; when it does, it is stopped after host and audio,
# started first and awaited (its /health `build`, not `version`) before they start, and rolled back with the others, to
# the previous build's directory. A host or audio failure on a deploy that left the gateway running leaves it alone. data/gateway-build
# and data/gateway-previous-build record the live and the previous build.
#
# DRY_RUN=1 prints the plan and every rendered plist and touches nothing (no fetch, no launchd, no ~/.local/bin).
#
# Everything lives inside `main`, called on the last line: this file is tracked in the repo the deploy exports, and
# zsh parses a function body as one unit at definition time. After the release is built `main` re-executes that
# release's copy once (pinned to the same sha), so the orchestration that runs matches the code being deployed.

set -u

# The processes, in start order. Each: a LaunchAgent label, a port, `deploy/<label>.plist.template` and its logs.
# RELEASE_PROCESSES run from the release; PROCESSES is what this deploy stops, starts and awaits: those two, plus the
# gateway when it restarts (main appends it: stopped last, started first).
RELEASE_PROCESSES=(host audio)
PROCESSES=(host audio)
typeset -A LABELS PORTS
LABELS=(host com.jkrumm.agent-workflows-host audio com.jkrumm.agent-workflows-audio gateway com.jkrumm.agent-workflows-gateway)
PORTS=(host 7791 audio 7792 gateway 7794)
# The sha each process's plist was last rendered for by this deploy: a rollback removes only what this deploy wrote.
typeset -A RENDERED_SHA
ROOT="${AGW_ROOT:-$HOME/.agent-workflows}"
REPO_DIR="$ROOT/repo"
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"
DATA_DIR="$ROOT/data"
SHA_FILE="$DATA_DIR/deployed-sha"
PREV_FILE="$DATA_DIR/previous-sha"
KEEP_RELEASES=3
# The gateway: builds live beside the releases, not in them.
GATEWAY_ROOT="$ROOT/gateway"
GATEWAY_ENTRY="packages/gateway/src/main.ts"
GW_BUILD_FILE="$DATA_DIR/gateway-build"
GW_PREV_FILE="$DATA_DIR/gateway-previous-build"
# sha256 of data/door-tokens as the gateway last started healthy on it (a deploy wrote it): the gateway reads the file
# only at start, so a file that differs from this record restarts it, whatever changed it (a deploy that appended lines
# and then died, a hand rotation).
GW_TOKENS_FILE="$DATA_DIR/gateway-door-tokens"
KEEP_GATEWAY_BUILDS=3
GW_BUILD=""      # the build this deploy would run (set by build_gateway)
GW_DIR=""        # its directory
GW_OLD_BUILD=""  # the build live before this deploy ("" = none): the gateway's rollback target
GW_EXPECT=""     # the build the gateway's /health must report
DRY_GW_RESTART="" # DRY_RUN: the build the plan restarts the gateway on ("" = left running)
TOKENS_DIGEST="" # sha256 of data/door-tokens after ensure_door_tokens (what a restarted gateway starts on)
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

# $2 is the release dir (the gateway: its build dir, `__BUILD_DIR__`), $4 the gateway's build id.
render_plist() {  # $1 template, $2 release dir, $3 sha, $4 build -> stdout
  /usr/bin/sed -e "s|__HOME__|$HOME|g" -e "s|__RELEASE_DIR__|$2|g" -e "s|__BUILD_DIR__|$2|g" -e "s|__SHA__|$3|g" \
    -e "s|__BUILD__|${4:-}|g" -e "s|__DATA_DIR__|$DATA_DIR|g" "$1"
}

# $1 release dir (the gateway: its build dir, which carries its own copy of the template), $2 process
template_of() { if [[ "$2" == gateway ]]; then print "$1/plist.template"; else print "$1/deploy/${LABELS[$2]}.plist.template"; fi; }
plist_of() { print "$HOME/Library/LaunchAgents/${LABELS[$1]}.plist"; }  # $1 process
health_url() { print "http://127.0.0.1:${PORTS[$1]}/health"; }  # $1 process

tail_logs() {
  local p f
  for p in $PROCESSES; do
    for f in "$HOME/Library/Logs/agent-workflows-$p.err.log" "$HOME/Library/Logs/agent-workflows-$p.out.log"; do
      [[ -f "$f" ]] && { print -u2 -r -- "--- tail -n 40 $f"; tail -n 40 "$f" >&2; }
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

start_process() {  # $1 process, $2 release dir (gateway: its build dir), $3 sha, $4 gateway build id
  local plist tmp
  plist=$(plist_of "$1"); tmp="$plist.tmp.$$"
  if ! { render_plist "$(template_of "$2" "$1")" "$2" "$3" "${4:-}" > "$tmp" && plutil -lint "$tmp" >/dev/null; }; then
    print -u2 "[deploy] ERROR: rendering the plist of $1 failed ($tmp)"
    return 1
  fi
  mv -f "$tmp" "$plist" || return 1
  RENDERED_SHA[$1]="$3"
  launchctl bootstrap "gui/$(id -u)" "$plist"
}

# The processes a release has a plist template for: a rollback target may predate a process.
processes_of() {  # $1 release dir -> process names
  local p
  for p in $RELEASE_PROCESSES; do [[ -f "$(template_of "$1" "$p")" ]] && print "$p"; done
}

# Each process answers /health with its version (AGW_VERSION = the sha it was started for); only those count. One
# deadline for all of them, so two processes cost no more wait than one. The gateway is not a release process: its
# /health is compared on `build` against $GW_EXPECT, whatever sha the caller passes.
# One probe: the process answers /health ok at the sha.
is_healthy() {  # $1 sha, $2 process
  local body field=version want=$1
  if [[ "$2" == gateway ]]; then field=build; want="$GW_EXPECT"; [[ -n "$want" ]] || return 1; fi
  body=$(curl -fsS --max-time 2 "$(health_url "$2")" 2>/dev/null) \
    && [[ "$(print -r -- "$body" | jq -r ".status + \" \" + .$field" 2>/dev/null)" == "ok $want" ]]
}

wait_healthy() {  # $1 sha, $2... processes
  local sha=$1; shift
  local i=0 p pending=("$@")
  while (( i < HEALTH_WAIT_SECS )); do
    local still=()
    for p in $pending; do
      is_healthy "$sha" "$p" || still+=("$p")
    done
    pending=("${still[@]}")
    (( ${#pending} == 0 )) && return 0
    sleep 1; i=$((i + 1))
  done
  print -u2 "[deploy] not healthy at ${sha[1,12]}: ${pending[*]}"
  return 1
}

# The doors' caller tokens (`name=token`, mode 0600), read by the gateway, the audio process's door and the host's image
# door (the host also hands the agw-opencode token to OpenCode, scripts/launch.sh). A new file gets one token
# per caller in DOOR_CALLERS; a file that exists gains a line for each caller in DOOR_CALLERS_ADDED it lacks (hermes is
# never re-added: a deleted hermes line is a revocation). Existing lines are never touched, no token is ever printed,
# the mode stays 0600. The names added are kept in DOOR_TOKENS_ADDED for the log; the gateway's restart is decided on the
# file's digest against data/gateway-door-tokens (door_tokens_changed), so it survives a deploy that died after appending.
DOOR_CALLERS=(hermes studio agw-opencode oc modelpick)
DOOR_CALLERS_ADDED=(studio agw-opencode oc modelpick)
DOOR_TOKENS_ADDED=()

# The callers of DOOR_CALLERS_ADDED the file has no line for (a commented line does not count).
missing_door_callers() {
  local name
  for name in $DOOR_CALLERS_ADDED; do
    /usr/bin/grep -Eq "^[[:space:]]*${name}[[:space:]]*=" "$DOOR_TOKENS" || print -r -- "$name"
  done
}

door_tokens_digest() { shasum -a 256 "$DOOR_TOKENS" 2>/dev/null | awk '{print $1}'; }

# The file differs from the one the gateway last started healthy on (no record counts as differing).
door_tokens_changed() {  # $1 the file's digest now
  [[ -z "$1" || "$(read_sha "$GW_TOKENS_FILE")" != "$1" ]]
}

ensure_door_tokens() {
  if [[ ! -e "$DOOR_TOKENS" ]]; then
    (
      umask 077
      tmp="$DOOR_TOKENS.tmp.$$"
      : > "$tmp" || exit 1
      for name in $DOOR_CALLERS; do
        token=$(openssl rand -hex 32) && [[ ${#token} -eq 64 ]] || exit 1
        print -r -- "$name=$token" >> "$tmp" || exit 1
      done
      chmod 600 "$tmp" && mv -f "$tmp" "$DOOR_TOKENS"
    ) || { rm -f "$DOOR_TOKENS.tmp.$$"; die "creating $DOOR_TOKENS failed"; }
    DOOR_TOKENS_ADDED=($DOOR_CALLERS)
    log "created $DOOR_TOKENS (${DOOR_CALLERS[*]}, mode 0600)"
    return 0
  fi
  # Only a regular file at 0600 is extended: anything else is left for check_door_tokens to refuse.
  [[ -f "$DOOR_TOKENS" && ! -L "$DOOR_TOKENS" && -n "$(/usr/bin/find "$DOOR_TOKENS" -maxdepth 0 -perm 600)" ]] || return 0
  local missing=( ${(f)"$(missing_door_callers)"} )
  (( ${#missing} )) || return 0
  (
    umask 077
    tmp="$DOOR_TOKENS.tmp.$$"
    last=$(/usr/bin/tail -c 1 "$DOOR_TOKENS")  # empty when the file ends in a newline (or is empty)
    { /bin/cat "$DOOR_TOKENS"; [[ -z "$last" ]] || print; } > "$tmp" || exit 1
    for name in $missing; do
      token=$(openssl rand -hex 32) && [[ ${#token} -eq 64 ]] || exit 1
      print -r -- "$name=$token" >> "$tmp" || exit 1
    done
    chmod 600 "$tmp" && mv -f "$tmp" "$DOOR_TOKENS"
  ) || { rm -f "$DOOR_TOKENS.tmp.$$"; die "adding ${missing[*]} to $DOOR_TOKENS failed"; }
  DOOR_TOKENS_ADDED=($missing)
  log "added ${missing[*]} to $DOOR_TOKENS (the other lines are untouched)"
}

# The door tokens read with the release's own parser (mode, owner, every line), the one both processes start with (the
# host's image door and the audio process's door): a bad file refuses the deploy before anything is stopped, never as a
# rollback. Messages name the file and the line, never a token. `door-tokens.ts` imports node and the host auth module
# (node-only), so a failure here is about the file, and bun's own stderr (a failed import, a crash) is kept in the
# message rather than passing for one.
check_door_tokens() {  # $1 release dir
  local why
  why=$(cd "$1/packages/host" && bun -e '
    const { readDoorTokens } = await import("./src/door-tokens.ts")
    try {
      readDoorTokens(process.argv[1])
    } catch (error) {
      process.stdout.write(error instanceof Error ? error.message : String(error))
      process.exit(3)
    }
  ' "$DOOR_TOKENS" 2>&1) || die "the door tokens are unusable: ${why:-bun exited without a message}; nothing was stopped"
}

# A process left booted out must not come back at the next login (RunAtLoad) on a release that failed: the plist goes,
# but only one this deploy rendered for that failed sha. Any other plist on disk is not this deploy's to remove.
remove_failed_plist() {  # $1 process, $2 failed sha
  [[ "${RENDERED_SHA[$1]:-}" == "$2" ]] || return 0
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

is_build() { [[ "$1" =~ '^[0-9a-f]{16}$' ]]; }

# The only place a gateway build is deleted: the name must be 16 hex.
remove_build() {  # $1 build
  is_build "$1" || die "refusing to remove gateway build '$1': not 16 hex"
  rm -rf "${GATEWAY_ROOT:?}/${1:?}"
}

# The build id: 16 hex of a sha256 over the bundle, the launcher, the env template, the plist template and the bun version.
# Each file is hashed on its own first, so no byte can move from one input to the next.
gateway_build_id() {  # $1 bundle, $2 launcher, $3 env template, $4 plist template
  local f
  { for f in "$@"; do shasum -a 256 "$f" | awk '{print $1}'; done; print "bun $(bun --version)"; } | shasum -a 256 | cut -c1-16
}

# Bundles the release's gateway entry and installs it as an immutable build directory (gateway.js, launch-gateway.sh,
# .env.gateway.tpl, plist.template, `.complete` written last). A complete directory is reused untouched; an incomplete
# one is rebuilt. Sets GW_BUILD and GW_DIR. Dies before anything is stopped.
build_gateway() {  # $1 release dir
  local release=$1 tmp out src
  for src in "$GATEWAY_ENTRY" scripts/launch-gateway.sh .env.gateway.tpl "deploy/${LABELS[gateway]}.plist.template"; do
    [[ -f "$release/$src" ]] || die "$release/$src missing: this release has no gateway; nothing was stopped"
  done
  mkdir -p "$GATEWAY_ROOT"
  rm -rf "$GATEWAY_ROOT"/.tmp.*(N)  # leftovers of a failed build (the deploy lock is held)
  tmp="$GATEWAY_ROOT/.tmp.$$"
  mkdir "$tmp" || die "cannot create $tmp"
  # Bundled from the release root so the bytes carry no absolute path: the same source is the same build in any release.
  out=$(cd "$release" && bun build --target=bun --outfile "$tmp/gateway.js" "$GATEWAY_ENTRY" 2>&1) \
    || { print -u2 "$out"; rm -rf "$tmp"; die "bundling the gateway failed; nothing was stopped"; }
  cp "$release/scripts/launch-gateway.sh" "$release/.env.gateway.tpl" "$tmp/" \
    && cp "$release/deploy/${LABELS[gateway]}.plist.template" "$tmp/plist.template" \
    || { rm -rf "$tmp"; die "copying the gateway files failed; nothing was stopped"; }
  GW_BUILD=$(gateway_build_id "$tmp/gateway.js" "$tmp/launch-gateway.sh" "$tmp/.env.gateway.tpl" "$tmp/plist.template") \
    && is_build "$GW_BUILD" || { rm -rf "$tmp"; die "computing the gateway build id failed; nothing was stopped"; }
  GW_DIR="$GATEWAY_ROOT/$GW_BUILD"
  if [[ -f "$GW_DIR/.complete" ]]; then rm -rf "$tmp"; touch "$GW_DIR"; return 0; fi
  [[ -e "$GW_DIR" ]] && remove_build "$GW_BUILD"
  { mv "$tmp" "$GW_DIR" && touch "$GW_DIR/.complete"; } || { rm -rf "$tmp"; die "installing the gateway build $GW_BUILD failed; nothing was stopped"; }
}

# The gateway is left running only if this build is the recorded live one AND it is loaded AND its /health is ok at that
# build. Anything else restarts it.
gateway_unchanged() {  # $1 build
  [[ -n "$1" && "$(read_sha "$GW_BUILD_FILE")" == "$1" ]] || return 1
  loaded gateway || return 1
  GW_EXPECT="$1"
  is_healthy "" gateway
}

# Keeps the newest $KEEP_GATEWAY_BUILDS complete builds plus the ones named in $@ (the live and the previous build);
# removes older ones. Only entries named like a build id are considered, and only complete ones.
prune_gateway_builds() {  # $@ builds never to remove
  local -a all; local n=0 d
  all=( ${(f)"$(ls -1t "$GATEWAY_ROOT" 2>/dev/null)"} )
  for d in $all; do
    is_build "$d" || continue
    [[ -f "$GATEWAY_ROOT/$d/.complete" ]] || continue
    n=$((n + 1))
    (( n <= KEEP_GATEWAY_BUILDS )) && continue
    (( ${@[(Ie)$d]} )) && continue
    log "pruning gateway build $d"
    remove_build "$d"
  done
}

# A rollback of a deploy that restarted the gateway: boot the build that was live before it (its own directory, so no
# release matters), or, with none, remove the plist this deploy rendered so it stays down. Returns 0 started, 1 nothing
# to start, 3 the start failed.
gateway_back() {  # $1 failed sha, $2 sha for AGW_VERSION
  local dir="$GATEWAY_ROOT/$GW_OLD_BUILD"
  if [[ -n "$GW_OLD_BUILD" && -f "$dir/.complete" && -f "$dir/plist.template" ]]; then
    print -u2 "[deploy] gateway back to build $GW_OLD_BUILD"
    GW_EXPECT="$GW_OLD_BUILD"
    start_process gateway "$dir" "$2" "$GW_OLD_BUILD" && return 0
    return 3
  fi
  print -u2 "[deploy] no previous gateway build: ${LABELS[gateway]} left booted out"
  remove_failed_plist gateway "$1"
  return 1
}

# stop_all failed: some processes unloaded, some are stuck. The unloaded ones go back up from their plists (still the live
# ones: nothing was rendered yet, they point at the live release and gateway build) and are awaited, so a stuck process
# does not leave the platform half down. Prints what is up, what is stuck and what did not come back.
restore_unloaded() {  # $1 live sha ("" = none: nothing was live, nothing to restore)
  local p back=() stuck=() up=() down=()
  for p in $PROCESSES; do
    if loaded "$p"; then stuck+=("$p"); continue; fi
    [[ -n "$1" && -f "$(plist_of "$p")" ]] || continue
    launchctl bootstrap "gui/$(id -u)" "$(plist_of "$p")" 2>/dev/null && back+=("$p")
  done
  if (( ${#back} )); then
    GW_EXPECT="$GW_OLD_BUILD"
    wait_healthy "$1" "${back[@]}" >/dev/null 2>&1
    for p in $back; do
      if is_healthy "$1" "$p"; then up+=("$p"); else down+=("$p"); fi
    done
  fi
  print -u2 "[deploy] restored from their plists: up ${up[*]:-none}; did not come back healthy ${down[*]:-none}; stuck loaded ${stuck[*]:-none}"
}

# A rollback that restarted the gateway puts it back first, the forward path's order: host and audio are never
# bootstrapped before it is healthy. 0: go on with host and audio (the gateway healthy, or no previous build to start:
# its plist removed, it stays down and leaves PROCESSES); 1: it did not come back, start nothing else.
gateway_first() {  # $1 failed sha, $2 sha for AGW_VERSION
  local grc
  gateway_back "$1" "$2"; grc=$?
  if (( grc == 1 )); then PROCESSES=("${(@)PROCESSES:#gateway}"); return 0; fi
  (( grc == 0 )) || { print -u2 "[deploy] the gateway's bootstrap failed"; return 1; }
  wait_healthy "$2" gateway
}

# The new build never became healthy: say so with the log tails, then put the previous release back, every process
# together (one sha live, never a mix), the gateway first.
roll_back() {  # $1 failed sha, $2 previous sha ("" = none), $3 unload wait, $4 live sha ("" = none)
  local p gw=0
  print -u2 "[deploy] ERROR: ${1[1,12]} did not become healthy within ${HEALTH_WAIT_SECS}s"
  tail_logs
  # The gateway is part of the rollback only if this deploy restarted it; otherwise it is still running, untouched.
  (( ${PROCESSES[(Ie)gateway]} )) && gw=1
  if [[ -z "$2" ]]; then
    stop_all "$3" || print -u2 "[deploy] WARNING: could not unload every process"
    if [[ -n "$4" && "$4" == "$1" ]]; then
      # A redeploy of the live sha (a transient health failure): same sha, same release, so its plists are the live
      # ones. They are kept and bootstrapped once more, the gateway first; the deploy still exits 1, naming what is up.
      local up=() down=() go=1
      print -u2 "[deploy] redeploy of the live sha ${1[1,12]}: starting every process again from its plist"
      if (( gw )); then gateway_first "$1" "$1" || go=0; fi
      if (( go )); then
        for p in $RELEASE_PROCESSES; do
          [[ -f "$(plist_of "$p")" ]] && launchctl bootstrap "gui/$(id -u)" "$(plist_of "$p")" 2>/dev/null
        done
        wait_healthy "$1" "${PROCESSES[@]}" >/dev/null 2>&1
      else
        print -u2 "[deploy] the gateway did not come back healthy: host and audio not started"
      fi
      for p in $PROCESSES; do
        if is_healthy "$1" "$p"; then up+=("$p"); else down+=("$p"); fi
      done
      print -u2 "[deploy] redeploy of the live sha ${1[1,12]} failed; up again: ${up[*]:-none}; down: ${down[*]:-none}. Plists kept, deployed-sha unchanged."
      return 0
    fi
    if (( gw )); then gateway_back "$1" "$1"; PROCESSES=("${(@)PROCESSES:#gateway}"); fi  # handled: up again, or its plist removed
    for p in $PROCESSES; do loaded "$p" || remove_failed_plist "$p" "$1"; done
    print -u2 "[deploy] no previous release (first deploy): every process left booted out so KeepAlive does not loop a failing launch. deployed-sha unchanged."
    return 0
  fi
  print -u2 "[deploy] rolling back to ${2[1,12]}"
  if ! stop_all "$3"; then
    print -u2 "[deploy] ROLLBACK FAILED: not every process unloaded within ${3}s"
    return 0
  fi
  if (( gw )) && ! gateway_first "$1" "$2"; then
    stop_all "$3"
    print -u2 "[deploy] ROLLBACK FAILED: the gateway (build ${GW_OLD_BUILD:-none}) did not become healthy; host and audio were not started, every process left booted out."
    return 0
  fi
  local back=() started=()
  back=( ${(f)"$(processes_of "$RELEASES/$2")"} )
  for p in $RELEASE_PROCESSES; do
    (( ${back[(Ie)$p]} )) && continue
    print -u2 "[deploy] ${2[1,12]} has no $p process: ${LABELS[$p]} left booted out"
    remove_failed_plist "$p" "$1"
  done
  for p in $back; do start_process "$p" "$RELEASES/$2" "$2" && started+=("$p"); done
  if (( ${#started} == ${#back} )) && wait_healthy "$2" "${back[@]}"; then
    (( ${PROCESSES[(Ie)gateway]} )) && back=(gateway $back)
    print -u2 "[deploy] rollback OK: ${2[1,12]} is healthy again (${back[*]}). deployed-sha unchanged."
  else
    stop_all "$3"
    print -u2 "[deploy] ROLLBACK FAILED: ${2[1,12]} did not become healthy either; every process left booted out."
  fi
}

# The CLI's process list (`AGW_PROCESSES`, packages/cli README): every process but the host.
processes_env() {
  local p entries=()
  # The host is the CLI's default, and the gateway serves no capability: only the other release processes are listed.
  for p in $RELEASE_PROCESSES; do [[ "$p" == host ]] || entries+=("$p=http://127.0.0.1:${PORTS[$p]}"); done
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

# DRY_RUN's gateway part. The build id is computed by bundling this checkout's gateway entry into a temp directory that is
# removed again (the real deploy bundles the release); unloaded/unhealthy/changed means a restart. Read-only: launchctl
# print and one curl.
dry_run_gateway() {  # $1 repo root, $2 sha
  local root=$1 sha=$2 tmp build="" live dir
  live=$(read_sha "$GW_BUILD_FILE")
  if [[ -f "$root/$GATEWAY_ENTRY" ]] && tmp=$(mktemp -d); then
    if (cd "$root" && bun build --target=bun --outfile "$tmp/gateway.js" "$GATEWAY_ENTRY" >/dev/null 2>&1); then
      build=$(gateway_build_id "$tmp/gateway.js" "$root/scripts/launch-gateway.sh" "$root/.env.gateway.tpl" "$root/deploy/${LABELS[gateway]}.plist.template")
    fi
    rm -rf "$tmp"
  fi
  if [[ -z "$build" ]]; then
    log "gateway: build id unknown ($GATEWAY_ENTRY did not bundle from this checkout); live build ${live:-none}"
  else
    log "gateway: build $build (live ${live:-none}), computed by bundling this checkout; the deploy bundles the release"
  fi
  if [[ -n "$build" ]] && gateway_unchanged "$build"; then
    if (( ${#DOOR_TOKENS_ADDED} == 0 )) && ! door_tokens_changed "$(door_tokens_digest)"; then
      log "gateway unchanged (build $build), not restarted"
      return 0
    fi
    log "gateway build $build unchanged, restarted anyway: $DOOR_TOKENS differs from the one it started on (recorded in $GW_TOKENS_FILE)${DOOR_TOKENS_ADDED:+; it gains ${DOOR_TOKENS_ADDED[*]}}"
  fi
  DRY_GW_RESTART="${build:-<build>}"
  dir="$GATEWAY_ROOT/${build:-<build>}"
  act "install $GATEWAY_ROOT/${build:-<build>}/ (gateway.js, launch-gateway.sh, .env.gateway.tpl, plist.template, .complete; an existing complete directory is reused)"
  log "rendered $(plist_of gateway) (points at the build directory, never at a release):"
  render_plist "$root/deploy/${LABELS[gateway]}.plist.template" "$dir" "$sha" "${build:-<build>}"
  act "on failure: the gateway goes back with the others, to build ${live:-none} (none: its plist is removed); after success write $GW_BUILD_FILE (${build:-<build>}), $GW_PREV_FILE (${live:-none}) and $GW_TOKENS_FILE (the door-tokens digest it started on), keep the newest $KEEP_GATEWAY_BUILDS builds plus both"
}

main() {
  local repo_url sha old prev="" release unload_secs env_content p gw_note="" gw_state="left running"

  # --- preflight: everything that can refuse does so before anything is built, stopped or written
  local tool
  for tool in git bun curl jq secrets-run launchctl plutil tar openssl shasum; do
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
    [[ -n "$old" && "$old" != "$sha" && -z "$prev" ]] \
      && log "REFUSED: deployed-sha names ${old[1,12]}, but $RELEASES/$old has no .complete marker; the real deploy dies before stopping anything"
    release="$RELEASES/$sha"
    log "DRY RUN: nothing is changed. Release ${sha[1,12]}, live ${old:-none}, processes: ${PROCESSES[*]}"
    log "preflight: would read $API_SECRET_REF through secrets-run (value never printed)"
    [[ -d "$REPO_DIR/.git" ]] || act git clone "${repo_url:-<origin url>}" "$REPO_DIR"
    act git -C "$REPO_DIR" fetch --prune origin master
    act "git -C $REPO_DIR archive $sha | tar -x -C $release   (the live release is never written to)"
    act bun install --frozen-lockfile "(in $release)"
    act "re-exec $release/scripts/deploy.sh once, pinned to $sha"
    if [[ -e "$DOOR_TOKENS" ]]; then
      log "$DOOR_TOKENS exists: existing lines are never rewritten"
      [[ -f "$DOOR_TOKENS" && -r "$DOOR_TOKENS" ]] && DOOR_TOKENS_ADDED=( ${(f)"$(missing_door_callers)"} )
      (( ${#DOOR_TOKENS_ADDED} )) \
        && act "append ${DOOR_TOKENS_ADDED[*]} (each <name>=<64 hex from openssl rand>) to $DOOR_TOKENS (mode stays 0600, the other lines are untouched, never printed)"
    else
      DOOR_TOKENS_ADDED=($DOOR_CALLERS)
      act "create $DOOR_TOKENS (mode 0600, one line <name>=<64 hex from openssl rand> for each of ${DOOR_CALLERS[*]}, never printed)"
    fi
    act "check $DOOR_TOKENS with the release's readDoorTokens (mode, owner, every line) before stopping anything"
    for p in $PROCESSES; do
      log "rendered $(plist_of "$p") (points at the release, not at current):"
      render_plist "$(template_of "$repo_root" "$p")" "$release" "$sha"
    done
    dry_run_gateway "$repo_root" "$sha"
    act "launchctl bootout ${LABELS[host]} ${LABELS[audio]}${DRY_GW_RESTART:+ then ${LABELS[gateway]}}, waiting up to $(unload_wait_secs "$(template_of "$repo_root" host)")s for each unload (ExitTimeOut + 10)"
    [[ -n "$DRY_GW_RESTART" ]] && act "start the gateway first: bootstrap ${LABELS[gateway]}, wait up to ${HEALTH_WAIT_SECS}s for $(health_url gateway) = ok, build ${DRY_GW_RESTART}; only then host and audio"
    for p in $PROCESSES; do act launchctl bootstrap "gui/$(id -u)" "$(plist_of "$p")"; done
    local urls=()
    for p in $PROCESSES; do urls+=("$(health_url "$p")"); done
    act "wait up to ${HEALTH_WAIT_SECS}s for every /health (${urls[*]}) = ok, version $sha"
    if [[ -n "$prev" ]]; then
      act "on failure: print every log tail, bootout every process, re-render each process ${prev[1,12]} has a template for, bootstrap, wait for its version; remove the plist this deploy rendered for each it has none for; exit 1"
    elif [[ -n "$old" && "$old" == "$sha" ]]; then
      act "on failure: print every log tail, bootout every process, bootstrap each again from its kept plist (a redeploy of the live sha: same release), wait for health once more, name the processes up and down, exit 1"
    else
      act "on failure: print every log tail, bootout every process and remove the plists this deploy rendered (no previous release: left down, not crash-looping, not back at login), exit 1"
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
  mkdir -p "$DATA_DIR" "$RELEASES" "$GATEWAY_ROOT" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$BIN_DIR"
  if ! mkdir "$LOCK" 2>/dev/null; then
    local holder; holder=$(cat "$LOCK/pid" 2>/dev/null)
    if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then die "another deploy is running (pid $holder)"; fi
    rm -rf "$LOCK"; mkdir "$LOCK" || die "cannot take $LOCK"
  fi
  print $$ > "$LOCK/pid"
  mkdir -p -m 700 "$DATA_DIR/gateway"  # the gateway's ledger (SQLite)
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

  for p in $RELEASE_PROCESSES; do
    [[ -f "$(template_of "$release" "$p")" ]] || die "$(template_of "$release" "$p") missing"
  done
  unload_secs=$(unload_wait_secs "$(template_of "$release" host)")
  ensure_door_tokens
  check_door_tokens "$release"

  # The gateway: bundled and installed beside the live build; restarted only if its build changed or door-tokens gained a caller.
  GW_OLD_BUILD=$(read_sha "$GW_BUILD_FILE")
  build_gateway "$release"
  TOKENS_DIGEST=$(door_tokens_digest)
  [[ -n "$TOKENS_DIGEST" ]] || die "cannot hash $DOOR_TOKENS; nothing was stopped"
  if ! gateway_unchanged "$GW_BUILD"; then
    PROCESSES+=(gateway)
  elif door_tokens_changed "$TOKENS_DIGEST"; then
    # Same build, but the gateway reads door-tokens only at start: a caller added (now or by a deploy that died after
    # appending) or a rotated token would get 401 until a restart.
    log "gateway build $GW_BUILD unchanged, restarted anyway: $DOOR_TOKENS differs from the one it started on${DOOR_TOKENS_ADDED:+ (added ${DOOR_TOKENS_ADDED[*]})}"
    PROCESSES+=(gateway)
  else
    log "gateway unchanged (build $GW_BUILD), not restarted"
  fi
  if (( ${PROCESSES[(Ie)gateway]} )); then
    GW_EXPECT="$GW_BUILD"
    gw_note="; the gateway on build $GW_BUILD"
    gw_state="restarted"
  fi

  # The release that is live now is the rollback target, unless it is the one being deployed again.
  old=$(read_sha "$SHA_FILE")
  # A live sha whose release is gone or incomplete leaves no rollback target: a failed deploy would take the "first
  # deploy" path and leave the already stopped service down with its plists removed. Refused before anything is stopped.
  if [[ -n "$old" && "$old" != "$sha" && ! -f "$RELEASES/$old/.complete" ]]; then
    die "deployed-sha names ${old[1,12]}, but $RELEASES/$old has no .complete marker: a failed deploy could not roll back. Nothing was stopped. Restore that release, or remove $SHA_FILE to deploy with no previous release."
  fi
  [[ -n "$old" && "$old" != "$sha" ]] && prev="$old"

  # --- switch
  log "deploying ${sha[1,12]} (live: ${old:-none}), stopping ${PROCESSES[*]}"
  if ! stop_all "$unload_secs"; then
    restore_unloaded "$old"
    die "a process is still loaded ${unload_secs}s after bootout (ExitTimeOut + 10); not bootstrapping over it. It may still be shutting down: retry the deploy. deployed-sha unchanged."
  fi
  # A restarted gateway goes first and must be healthy before the host and audio start serving: their model calls go
  # through it. Stopped last (above), started first; a gateway that never turns healthy rolls everything back.
  if (( ${PROCESSES[(Ie)gateway]} )); then
    if ! start_process gateway "$GW_DIR" "$sha" "$GW_BUILD"; then
      print -u2 "[deploy] ERROR: launchctl bootstrap failed for gateway at build $GW_BUILD"
      roll_back "$sha" "$prev" "$unload_secs" "$old"
      return 1
    fi
    log "waiting up to ${HEALTH_WAIT_SECS}s for the gateway's /health (build $GW_BUILD) before host and audio start"
    if ! wait_healthy "$sha" gateway; then
      roll_back "$sha" "$prev" "$unload_secs" "$old"
      return 1
    fi
  fi
  for p in $RELEASE_PROCESSES; do
    if ! start_process "$p" "$release" "$sha"; then
      print -u2 "[deploy] ERROR: launchctl bootstrap failed for $p at ${sha[1,12]}"
      roll_back "$sha" "$prev" "$unload_secs" "$old"
      return 1
    fi
  done
  log "waiting up to ${HEALTH_WAIT_SECS}s for every /health (version ${sha[1,12]})${gw_note}"
  if ! wait_healthy "$sha" "${PROCESSES[@]}"; then
    roll_back "$sha" "$prev" "$unload_secs" "$old"
    return 1
  fi

  # --- healthy: current, the CLI, then the marker ("deployed" means the CLI is usable too)
  ln -sfn "$release" "$CURRENT" || die "updating $CURRENT failed"
  [[ -n "$old" && "$old" != "$sha" ]] && write_atomic "$PREV_FILE" "$old"
  # The gateway's recorded build goes before deployed-sha: an interruption never leaves the sha newer than the build it runs.
  if (( ${PROCESSES[(Ie)gateway]} )); then
    [[ -n "$GW_OLD_BUILD" && "$GW_OLD_BUILD" != "$GW_BUILD" ]] && write_atomic "$GW_PREV_FILE" "$GW_OLD_BUILD"
    write_atomic "$GW_BUILD_FILE" "$GW_BUILD" || die "writing $GW_BUILD_FILE failed"
    write_atomic "$GW_TOKENS_FILE" "$TOKENS_DIGEST" || die "writing $GW_TOKENS_FILE failed"
  fi
  write_env_file "$env_content"
  ln -sf "$CURRENT/packages/cli/bin/agw.ts" "$CLI_LINK" || die "linking $CLI_LINK failed"
  write_atomic "$SHA_FILE" "$sha" || die "writing $SHA_FILE failed"
  prune_releases "$sha" "$(read_sha "$PREV_FILE")"
  prune_gateway_builds "$GW_BUILD" "$(read_sha "$GW_PREV_FILE")"
  log "deploy OK: ${sha[1,12]} healthy (${PROCESSES[*]}); gateway build $GW_BUILD ${gw_state}; agw -> $CLI_LINK, credentials in $ENV_FILE"
}

main
