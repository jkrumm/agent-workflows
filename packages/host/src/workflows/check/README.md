# check

The repo's validation as a workflow: `agw check --cwd <dir> [--commands '["…"]'] [--step-timeout-seconds N]`.
Output is the legacy `CHECK_OUTPUT`, a drop-in for today's callers: `{ passed, steps: [{ name, passed, errors? }], summary }`,
`name` a non-empty string, by convention `format | lint | typecheck | test | fallow | check`.

Behaviour is ported from agent-gateway's `check`, the code is written fresh. Legacy references, for the diff of intent:

| Here | Legacy (`agent-gateway/server`) |
|-|-|
| `make.ts` `makeDatabaseHasCheckTarget`, `hasMakeCheckTarget` | `jobs/handlers/check.ts` `makeDatabaseHasCheckTarget`, `hasMakeCheckTarget` (`make -p -q`, 5 s probe) |
| `exec.ts` idle watchdog, process-group kill, `PWD` pin, drain grace | `check.ts` `runStep` |
| `env.ts` `commandEnv` | `mcp/worker-shared.ts` `scrubSensitiveEnv`, the `CLAUDE_CODE_OAUTH_TOKEN` delete in `runStep` |
| `agents/check/skills/run-step/run-step.sh` | `check.ts` `idleWatchdogBlock` (`run_step`) |
| `index.ts` `contractCheck`, `errorLines`, `stepResult` | `check.ts` `runRepoContractCheck`, `makeCheckErrorLines`, `runStep` verdicts |
| `index.ts` `agentCheck` (one retry on invalid JSON) | `check.ts` `runCheck` tail, `lib/worker-io.ts` `JSON_ONLY_RETRY` |
| `prompt.ts` `agentIdleMs`, `agentPrompt` | `check.ts` `checkSessionIdleTimeoutMs`, `explicitCommandsPrompt`, `idleWatchdogBlock` (OpenCode variant) |
| `agents/check/AGENTS.md` | `skills/check.md` plus the explicit-commands prompt |

## Paths

1. **Makefile contract, no LLM.** No `commands` and the Makefile (`GNUmakefile`, `makefile`, `Makefile`) has a real
   `check:` rule: step `make-check` runs `make check`, step `fallow` runs `fallow audit --quiet` when fallow is
   installed and the repo has a remote (also after a red `make check`). `errors` are the last 50 non-empty output
   lines, 500 characters each; nothing else of the log is kept. A `check-foo` target, a recipe-less `check:`, a file
   named `check` or a catch-all `%:` rule is not a contract.
2. **Agent.** Otherwise one agent step (`agent`, agent `check`, route `check`): explicit `commands` run verbatim,
   without discovery; none means the discovery guide in `AGENTS.md`. The agent works in its compiled location, so the
   step passes `options.allowDirectories: [cwd]` and the prompt names `cwd`. Invalid JSON (or a step name outside the
   contract) fails the step as `invalid_output`; one more session (`agent-retry`) gets the same prompt plus
   `JSON_ONLY_RETRY` (JSON-only, nothing else; it is a new session, so running the steps again is expected). A second miss ends the run `done` with `passed: false`, `steps: []` and a summary. Any other
   step failure fails the run.

`plan` is a journaled step with a retry policy (3 attempts): it decides the path (and whether fallow applies), so a
resume takes the same path without re-probing. It refuses a `cwd` that is not an existing git work tree (the run
ends `failed`, kind `invalid_input`), but only on a definitive answer: no such directory, or `git` exiting 128 with
"not a git repository", or `false`. Any other probe failure throws and is retried, never journaled as a verdict
about the caller's input. Every probe gets the step's abort signal. The `make -p -q` probe has 30 s (a short wall
silently sends the run to the paid agent path on a loaded host) and keeps the whole output; a probe that times out
or comes back cut is logged and falls back to the agent path.

A command killed by a signal the host did not send (an OOM kill, an operator) is not a red: the step throws
`InfraError` and runs again.

## Agent path watchdog

The agent runs every command through `agents/check/skills/run-step/run-step.sh <cwd> <idle-seconds> '<command>'`
(ported from legacy's `run_step`): the command is killed alone after `idle-seconds` without new output, the wrapper
prints `run-step: IDLE_TIMEOUT no output for Ns` and exits 124, and the agent records that step as failed with
"no output for Ns — likely a watch-mode runner or a hung process" and goes on, so the report keeps the other steps.
The windows are the request's: `stepTimeoutSeconds`, else 180 s (600 s for the test step). The wrapper `cd`s into
the checked tree itself and is called from the agent's session directory, so the agent never needs the location's
absolute path. Not yet exercised against the real OpenCode host (`allowDirectories` is the other open part).

The script re-executes itself under bash. The group kill needs job control (`set -m`) and `kill -- -PGID`, which dash
(Debian/Ubuntu's `sh`) does not support without a tty, so there the kill reached nothing. Bash is required; a host
without it fails loudly rather than leaving the command running.

## Credentials and orphans

Every spawn (`make check`, `fallow`, the `make -p -q` probe, the git probes) runs with the host's environment minus
anything credential-shaped: legacy's pattern (`TOKEN|SECRET|PASSWORD|PASSWD|_KEY|APIKEY|API_KEY|CREDENTIAL|BEARER|SESSION_ID`,
case-insensitive, no exemptions, so `CLAUDE_CODE_OAUTH_TOKEN` goes too) plus `AUTHORIZATION`, `AGW_PG_URL`, `USAGE_PG_URL`, `IU_*` and
`OTEL_EXPORTER_OTLP_*HEADERS`. A `$(shell …)` in an untrusted Makefile runs in the probe as well.

Make's own recursion state (`MAKELEVEL`, `MAKEFLAGS`, `MFLAGS`, `MAKEOVERRIDES`, `GNUMAKEFLAGS`, `MAKEFILES`,
`MAKE_TERMOUT`, `MAKE_TERMERR`) is dropped too: when the host itself runs under `make` (CI: `make check` → `bun test`),
the validated repo's `make` would otherwise be a sub-make that obeys the host's `-j`/`-k`/`-n` and jobserver and, on
GNU make 4, prints `Entering directory`. Every validated `make`, the probe included, starts top-level.

Each command's process group (pgid and start time) is recorded in `<state dir>/check/<run>_<step>.group` while it
runs. A step that starts first kills a recorded group that is still alive (a host crash between spawn and reap leaves
one); a leader whose start time differs is a reused pid and is left alone. The final group kill runs only after an
idle kill, an abort, or a drain that did not finish, never after a clean reap.

## Idle, never a wall clock

A command is killed only after `stepTimeoutSeconds` (default 180 s; 600 s for `make check`, which bundles the tests,
and for the agent's test step) without a new byte of output. The exec port's watchdog is re-armed per chunk, so a slow
chatty suite runs as long as it needs. The runtime's step idle timer is a backstop (window + 60 s) fed by the same
chunks (`scope.progress`); it never fires before the port's own watchdog. Only helper subprocesses have wall caps
(`git`, 30 s; `make -p -q`, 5 s). The agent step's idle window is the legacy one: the larger of the runtime default
and the longest step window + 120 s, because a shell call writes nothing to the session while it runs.

## Exec port

`Exec` (`exec.ts`) is `{ run, which }`; `createCheckWorkflows({ exec })` injects it, `bunExec` (`Bun.spawn`, own
process group, scrubbed host environment with `PWD` pinned to `cwd`) is the default. A drain read error ends the
stream; it never throws out of `run`. What leaves a step is the truncated tail in `errors`.

## Token and cache effect

- The Makefile path spends **no tokens** (no usage on any step). It is also the common path for the repos that
  matter, which is why `commands` is the caller's explicit opt-out.
- The agent path's stable rules live in `agents/check/AGENTS.md` (the cacheable prefix, identical for every run);
  the per-run prompt is three short lines (cwd, idle window, mode and commands) at the end. Discovery and explicit
  commands share one `AGENTS.md`, so both hit the same cache entry; the mode line switches behaviour.
- The retry is a fresh session with the same prompt plus a short directive, so it re-reads the cached prefix at the
  cache-read rate; a second miss costs two sessions and no more.
- The agent is told to run each command once and never to re-read: that, not the prompt size, is where tokens go.
  Route `check` is the cheap classify seat.

## Route

Model and rate: `packages/routes/src/table/check.ts` (the only home of model ids). Source seat: agent-gateway
`GET /api/routing`, 2026-10-27, unless noted.

| Route | Source seat | Wire |
|-|-|-|
| `check` | `check` (CLASSIFY) | opencode |
