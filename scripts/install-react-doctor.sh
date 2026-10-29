#!/bin/bash
# Idempotent: installs the pinned react-doctor (REACT_DOCTOR_VERSION, packages/host/src/workflows/review/react-doctor.ts)
# from npm under ~/.local/share/agent-workflows/react-doctor/<version>, where `reactDoctorBin` execs it by absolute
# path. Never `bunx`: its shared install cache races under concurrent reviews (`Failed to link <pkg>: EEXIST`, 73 of
# 520 runs failed, measured 2026-10-19). The lockfile (bun.lock) stays in that directory. A failure is non-fatal for
# review runs: they report react-doctor as not run (`make verify` names the missing install).
# The install runs in a temp directory next to the target and is renamed into place only when complete, so an
# interrupted install never leaves a half version directory.
# AGW_REACT_DOCTOR_ROOT overrides the install root (absolute; tests, a temp prefix).
set -euo pipefail
pins="$(cd "$(dirname "$0")" && pwd)/pins.sh"
bun="$(command -v bun || echo /opt/homebrew/bin/bun)"
version="$("$pins" version react-doctor)"
root="$("$pins" root react-doctor)"
dir="$root/$version"
bin="$dir/node_modules/.bin/react-doctor"
installed() { "$bun" -e 'console.log(require(process.argv[1]).version)' "$1/node_modules/react-doctor/package.json" 2>/dev/null || true; }
if [ -x "$bin" ] && [ "$(installed "$dir")" = "$version" ]; then
  echo "react-doctor $version already installed at $bin"
  exit 0
fi

[ -x "$bun" ] || { echo "install-react-doctor: bun not found on PATH" >&2; exit 1; }
mkdir -p "$root"
tmp="$(mktemp -d "$root/.install-$version.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
echo '{"name":"agw-react-doctor","private":true}' > "$tmp/package.json"
(cd "$tmp" && "$bun" add --exact --silent "react-doctor@$version")
[ -x "$tmp/node_modules/.bin/react-doctor" ] && [ "$(installed "$tmp")" = "$version" ] ||
  { echo "install-react-doctor: the downloaded install is not react-doctor $version" >&2; exit 1; }
[ ! -e "$dir" ] || mv "$dir" "$tmp/stale"
mv "$tmp" "$dir"
trap - EXIT
[ ! -e "$dir/stale" ] || rm -rf "$dir/stale"
echo "installed react-doctor $version at $bin"
