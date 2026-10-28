# check

The repo's validation as a workflow: `agw check --cwd <dir> [--commands '["…"]'] [--step-timeout-seconds N]`.
Output is the legacy `CHECK_OUTPUT`, a drop-in for today's callers: `{ passed, steps: [{ name, passed, errors? }], summary }`,
`name` one of `format | lint | typecheck | test | fallow | check`.

Behaviour is ported from agent-gateway's `check`, the code is written fresh. Legacy references, for the diff of intent:

| Here | Legacy (`agent-gateway/server`) |
|-|-|
| `make.ts` `makeDatabaseHasCheckTarget`, `hasMakeCheckTarget` | `jobs/handlers/check.ts` `makeDatabaseHasCheckTarget`, `hasMakeCheckTarget` (`make -p -q`, 5 s probe) |
| `exec.ts` idle watchdog, process-group kill, `PWD` pin, drain grace | `check.ts` `runStep` |
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
   `JSON_ONLY_RETRY`. A second miss ends the run `done` with `passed: false`, `steps: []` and a summary. Any other
   step failure fails the run.

`plan` is a journaled step: it refuses a `cwd` that is not an existing git work tree (the run ends `failed` with
kind `invalid_input`) and decides the path, so a resume takes the same path without re-probing.

## Idle, never a wall clock

A command is killed only after `stepTimeoutSeconds` (default 180 s; 600 s for `make check`, which bundles the tests,
and for the agent's test step) without a new byte of output. The exec port's watchdog is re-armed per chunk, so a slow
chatty suite runs as long as it needs. The runtime's step idle timer is a backstop (window + 60 s) fed by the same
chunks (`scope.progress`); it never fires before the port's own watchdog. Only helper subprocesses have wall caps
(`git`, 30 s; `make -p -q`, 5 s). The agent step's idle window is the legacy one: the larger of the runtime default
and the longest step window + 120 s, because a shell call writes nothing to the session while it runs.

## Exec port

`Exec` (`exec.ts`) is `{ run, which }`; `createCheckWorkflows({ exec })` injects it, `bunExec` (`Bun.spawn`, own
process group, host environment with `PWD` pinned to `cwd`) is the default. Unlike legacy there is no secret scrub:
the host's env passes through as is, and the only thing that leaves a step is the truncated tail in `errors`.

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
