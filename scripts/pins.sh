#!/bin/bash
# The pinned install, in one place (install-opencode-bin.sh, `make install-opencode`, `make verify` and
# packages/host/test/pins.test.ts all go through here):
#   pins.sh version <opencode> [source-root]   the pinned version, read from the exported constant
#   pins.sh root <opencode|bin>                the install root / the link dir: the AGW_* override or the
#                                              default; a relative override is rejected
#   pins.sh check [source-root]                exit 1 naming `make install-opencode` when the pinned OpenCode build
#                                              is missing at its path
# source-root defaults to this checkout; `make verify` passes the deployed release. Overrides: AGW_OPENCODE_ROOT,
# AGW_BIN_DIR (where the install and the links go) and AGW_OPENCODE_BIN (the binary itself, as the host reads it).
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"

die() { echo "pins: $1" >&2; exit "${2:-1}"; }

version() {
  local file name v
  case "$1" in
    opencode) file=packages/opencode-host/src/server.ts name=OPENCODE_VERSION ;;
    *) die "unknown pin '$1' (opencode)" 2 ;;
  esac
  v="$(sed -nE "s/^export const $name = '([^']+)'.*/\1/p" "${2:-$here}/$file")"
  [ -n "$v" ] || die "$name not found in ${2:-$here}/$file"
  echo "$v"
}

root() {
  local var default value
  case "$1" in
    opencode) var=AGW_OPENCODE_ROOT default="$HOME/.local/share/agent-workflows/opencode-bin" ;;
    bin) var=AGW_BIN_DIR default="$HOME/.local/bin" ;;
    *) die "unknown root '$1' (opencode|bin)" 2 ;;
  esac
  value="${!var:-$default}"
  case "$value" in
    /*) echo "${value%/}" ;;
    *) die "$var must be an absolute path (got '$value')" ;;
  esac
}

check() {
  local src="${1:-$here}" missing=() ov oroot ocbin
  ov="$(version opencode "$src")"
  oroot="$(root opencode)"
  ocbin="${AGW_OPENCODE_BIN:-$oroot/$ov/node_modules/.bin/opencode}"
  [ -x "$ocbin" ] || missing+=("OpenCode $ov missing at $ocbin")
  if [ -z "${AGW_OPENCODE_BIN:-}" ] && [ -x "$ocbin" ] &&
    [ "$(cd "$oroot/current" 2>/dev/null && pwd -P || true)" != "$(cd "$oroot/$ov" && pwd -P)" ]; then
    missing+=("$oroot/current does not point at the pinned OpenCode $ov")
  fi
  if [ ${#missing[@]} -gt 0 ]; then
    printf 'pins: %s\n' "${missing[@]}" >&2
    die "fix: run 'make install-opencode' in the agent-workflows checkout"
  fi
  echo "pinned build present: opencode $ov"
}

case "${1:-}" in
  version) version "${2:-}" "${3:-}" ;;
  root) root "${2:-}" ;;
  check) check "${2:-}" ;;
  *) die "usage: pins.sh version <opencode> [source-root] | root <opencode|bin> | check [source-root]" 2 ;;
esac
