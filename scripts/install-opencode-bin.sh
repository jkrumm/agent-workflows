#!/bin/bash
# Idempotent: installs the pinned opencode build (OPENCODE_VERSION, packages/opencode-host/src/server.ts) from npm
# under ~/.local/share/agent-workflows/opencode-bin/<version> and points `current` at it; scripts/opencode (the
# machine-wide shim) execs `current`. A present, matching version is not downloaded again. Homebrew's bottle lags
# the npm releases, so Homebrew cannot serve the pin.
# AGW_OPENCODE_ROOT overrides the install root (tests, a temp prefix). Never restarts anything: the host's OpenCode
# server picks the new binary up on its next start (packages/opencode-host/README.md §Pinned build).
set -euo pipefail
cd "$(dirname "$0")/.."
version="$(sed -nE "s/^export const OPENCODE_VERSION = '([^']+)'.*/\1/p" packages/opencode-host/src/server.ts)"
[ -n "$version" ] || { echo "install-opencode-bin: OPENCODE_VERSION not found in packages/opencode-host/src/server.ts" >&2; exit 1; }
root="${AGW_OPENCODE_ROOT:-$HOME/.local/share/agent-workflows/opencode-bin}"
dir="$root/$version"
bin="$dir/node_modules/.bin/opencode"
link_current() { ln -sfn "$dir" "$root/current"; }
if [ -x "$bin" ] && [ "$("$bin" --version 2>/dev/null | awk '{print $NF}' | sed 's/^v//')" = "$version" ]; then
  link_current
  echo "opencode $version already installed at $bin"
  exit 0
fi
mkdir -p "$dir"
(cd "$dir" && npm init -y >/dev/null && npm install --silent --save-exact "@opencode/cli@$version")
[ -x "$bin" ] || { echo "install-opencode-bin: $bin missing after install" >&2; exit 1; }
link_current
echo "installed opencode $version at $bin"
