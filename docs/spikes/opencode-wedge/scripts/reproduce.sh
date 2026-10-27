#!/usr/bin/env bash
# One command, bounded: reproduces the verdict in REPORT.md. Typical run 6-9 min (a loaded mini is slower).
#   timeout 900 bash docs/spikes/opencode-wedge/scripts/reproduce.sh
# Needs: the pinned 2.0.32 build, bun, the IU Keychain items (claude-sdk-api-key, claude-sdk-base-url). ~10 cheap deepseek-flash prompts.
# Starts only throwaway servers on its own ports; each is SIGKILLed at the end of its trial. Never touches agent-gateway's servers.
set -uo pipefail
fail=0
HERE="$(cd "$(dirname "$0")" && pwd)"
echo "opencode $(opencode --version 2>&1 | tail -1), bun $(bun --version), load: $(uptime | sed 's/.*load averages*: //')"
echo "pre-existing servers: $(pgrep -f 'opencode.* serve' | tr '\n' ' ')"
echo; echo "== 1. dotfiles spike script, unmodified (verbatim) vs one-line patched (OPENCODE_DISABLE_FILEWATCHER=1)"
"$HERE/replay-dotfiles.sh" verbatim 2
"$HERE/replay-dotfiles.sh" nowatch 2
echo; echo "== 2. S2's spawn as it ran, watchers on vs off (3 reps each, 90 s ceiling)"
bun "$HERE/matrix.ts" repro --reps 3 --conc 1 --ceil 90000 --out "${TMPDIR:-/tmp}/ocw-repro.jsonl" 2>&1 | cut -c1-200
mx=${PIPESTATUS[0]}; echo "matrix exit: $mx"; fail=$((fail + (mx != 0)))
echo; echo "== 3. detection and recovery"
bun "$HERE/recover.ts" 2>&1 | cut -c1-220; fail=$((fail + (${PIPESTATUS[0]} != 0)))
echo; echo "servers after: $(pgrep -f 'opencode.* serve' | tr '\n' ' ') (must equal the pre-existing list)"
rm -f "${TMPDIR:-/tmp}/ocw-repro.jsonl" "${TMPDIR:-/tmp}/ocw-dotfiles-nowatch.sh"
echo "failed steps: $fail"
exit "$fail"
