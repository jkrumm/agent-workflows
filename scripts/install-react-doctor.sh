#!/bin/bash
# Idempotent: installs the pinned react-doctor (REACT_DOCTOR_VERSION, packages/host/src/workflows/review/react-doctor.ts)
# from npm under ~/.local/share/agent-workflows/react-doctor/<version>, where `reactDoctorBin` execs it by absolute
# path. Never `bunx`: its shared install cache races under concurrent reviews (`Failed to link <pkg>: EEXIST`, 73 of
# 520 runs failed, measured 2026-10-19). The lockfile (bun.lock) stays in that directory. A failure is non-fatal for
# review runs: they report react-doctor as not run.
# AGW_REACT_DOCTOR_ROOT overrides the install root (tests, a temp prefix).
set -euo pipefail
cd "$(dirname "$0")/.."
bun="$(command -v bun || echo /opt/homebrew/bin/bun)"
version="$(sed -nE "s/^export const REACT_DOCTOR_VERSION = '([^']+)'.*/\1/p" packages/host/src/workflows/review/react-doctor.ts)"
[ -n "$version" ] || { echo "install-react-doctor: REACT_DOCTOR_VERSION not found in react-doctor.ts" >&2; exit 1; }
root="${AGW_REACT_DOCTOR_ROOT:-$HOME/.local/share/agent-workflows/react-doctor}"
dir="$root/$version"
bin="$dir/node_modules/.bin/react-doctor"
installed() { "$bun" -e 'console.log(require(process.argv[1]).version)' "$dir/node_modules/react-doctor/package.json" 2>/dev/null; }
if [ -x "$bin" ] && [ "$(installed)" = "$version" ]; then
  echo "react-doctor $version already installed at $bin"
  exit 0
fi
mkdir -p "$dir"
[ -f "$dir/package.json" ] || echo '{"name":"agw-react-doctor","private":true}' > "$dir/package.json"
(cd "$dir" && "$bun" add --exact --silent "react-doctor@$version")
[ -x "$bin" ] || { echo "install-react-doctor: $bin missing after install" >&2; exit 1; }
echo "installed react-doctor $version at $bin"
