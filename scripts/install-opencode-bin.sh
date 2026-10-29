#!/bin/bash
# Idempotent: installs the pinned opencode build (OPENCODE_VERSION, packages/opencode-host/src/server.ts) from npm
# under ~/.local/share/agent-workflows/opencode-bin/<version> and points `current` at it; scripts/opencode (the
# machine-wide shim) execs `current`. A present, matching version is not downloaded again. Homebrew's bottle lags
# the npm releases, so Homebrew cannot serve the pin.
# The install runs in a temp directory next to the target and is renamed into place only after the binary reports the
# pinned version, so an interrupted install never leaves a half version directory that a later run would trust.
# `current` is repointed atomically.
# AGW_OPENCODE_ROOT overrides the install root (absolute; tests, a temp prefix). Never restarts anything: the host's
# OpenCode server picks the new binary up on its next start (packages/opencode-host/README.md §Pinned build).
set -euo pipefail
pins="$(cd "$(dirname "$0")" && pwd)/pins.sh"
version="$("$pins" version opencode)"
root="$("$pins" root opencode)"
dir="$root/$version"
bin="$dir/node_modules/.bin/opencode"

reported() { "$1" --version 2>/dev/null | awk '{print $NF}' | sed 's/^v//' || true; }

# `current` -> the pinned directory, swapped in one rename (mv -h / -T treat the existing link itself as the target).
link_current() {
  ln -s "$dir" "$root/.current.$$"
  if [ "$(uname)" = Darwin ]; then mv -fh "$root/.current.$$" "$root/current"; else mv -fT "$root/.current.$$" "$root/current"; fi
}

mkdir -p "$root"
if [ -x "$bin" ] && [ "$(reported "$bin")" = "$version" ]; then
  link_current
  echo "opencode $version already installed at $bin"
  exit 0
fi

command -v npm >/dev/null 2>&1 || { echo "install-opencode-bin: npm not found on PATH (install Node, e.g. via fnm)" >&2; exit 1; }
tmp="$(mktemp -d "$root/.install-$version.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
echo '{"name":"agw-opencode-bin","private":true}' > "$tmp/package.json"
(cd "$tmp" && npm install --silent --save-exact "@opencode/cli@$version")
[ "$(reported "$tmp/node_modules/.bin/opencode")" = "$version" ] ||
  { echo "install-opencode-bin: the downloaded build does not report $version" >&2; exit 1; }
# A directory left by an interrupted or broken earlier install is replaced, not trusted.
[ ! -e "$dir" ] || mv "$dir" "$tmp/stale"
mv "$tmp" "$dir"
trap - EXIT
[ ! -e "$dir/stale" ] || rm -rf "$dir/stale"
link_current
echo "installed opencode $version at $bin"
