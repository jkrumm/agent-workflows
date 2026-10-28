# @agent-workflows/host

The `host` process (concept §8): light workflows, capabilities and the HTTP API in one process, bound to `127.0.0.1`. The `agw` CLI is generated from the OpenAPI document it serves (concept §9).

```ts
const host = createHost({ runtime, registry, workflows, secret, version })
Bun.serve({ hostname: '127.0.0.1', port: 7791, idleTimeout: 255, fetch: host.fetch })
await host.openapi() // OpenAPI 3.1 for the whole process, info['x-contract-sha'] included
```

`src/main.ts` is the entry (`bun packages/host/src/main.ts`); `src/boot.ts` builds everything from the environment and is what the process tests drive. `createHost` takes its collaborators by injection, so tests run it without a socket.

## Environment

Names only; values come from 1Password through `secrets-run`, never from the repo.

| Variable | Required | Notes |
|-|-|-|
| `AGW_API_SECRET` | yes | bearer secret, at least 32 characters and no whitespace (a trailing newline could never authenticate); the process exits non-zero before listening otherwise |
| `AGW_MACHINE` | yes | Argo's `machine`, part of its upsert key `(source, source_id, machine)`; must stay stable. The deploy sets it |
| `AGW_PG_URL` | yes | the journal database (`agent_workflows`) |
| `AGW_PG_SCHEMA` | no | journal schema, default `agw` |
| `AGW_PORT` | no | default `7791` |
| `AGW_VERSION` | no | reported by `/health` and `info.version`; default `dev`. A change changes the contract sha |
| `AGW_AGENTS_DIR`, `AGW_OPENCODE_BIN` | no | fingerprint source: compiled agent definitions and the `opencode` binary. Read only for workflows that reference agents |
| `IU_API_KEY`, `IU_BASE_URL` | for capabilities | read per call by the capabilities |
| `IU_KEY_ID` | no | non-secret label of the IU key above: `personal` (default; unset or empty) or `athena-team`; any other value refuses to start. Stamped on every run this process admits and posted as `iu_key` on `billing=iu` Argo rows; also forwarded to OpenCode servers, which do not read it |
| `AGW_RETRO_WEEKLY` | no | the weekly retrospective schedule; on unless `0`, `off` or `false` |
| `AGW_RETRO_FILE_ISSUES`, `AGW_RETRO_ISSUE_REPO` | no | scheduled retrospectives file their proposals as GitHub issues in `owner/name`. Off by default; the repository is required when it is on (the process refuses to start otherwise). `gh` authenticates from the host's environment (`GH_TOKEN`) |
| `ARGO_URL`, `ARGO_API_SECRET` | no | the usage outbox is on when both are set |
| `OTEL_EXPORTER_OTLP_ENDPOINT` (or `…_TRACES_ENDPOINT`), `OTEL_EXPORTER_OTLP_HEADERS` | no | span export is off without an endpoint |
| `AGW_ROUTES`, `AGW_WALLET_*` | no | route overrides (routes README), wallet gate (limits README) |
| `AGW_DRIFT_RATE`, `AGW_DRIFT_INTERVAL_S` | no | drift: the share of finished production runs scored after the fact (default `0.1`, `0` turns it off) and the tick (default 300 s); a bad value refuses to start |
| `AGW_EVAL_DIR`, `AGW_EVAL_HOME` | no | `agw eval run`: where `<workflow>/cases.jsonl` live (default `~/.local/share/agent-workflows/eval`) and the root a case's `repo` is relative to (default `$HOME`) |

## Routes

| Route | Auth | Notes |
|-|-|-|
| `GET /health` | none | `200 { status: 'ok', version }` when the runtime is open and Postgres answers within 2 s, else `503 { status: 'degraded', reason }`; the probe is bounded: the store ends its own query at the bound (`Runtime.ping(timeoutMs)`), so a slow Postgres cannot park probes on the journal pool |
| `GET /openapi.json` | bearer | the document; every operation has `x-cli` with `kind` |
| `POST /<capability path>` | bearer | the registry's capabilities, e.g. `POST /llm/title`; each call is a one-step run, its id in `agw-run-id` |
| `POST /workflows/a/b` | bearer | workflow `a.b`; body = input |
| `GET /runs/{runId}` | bearer | `run status` |
| `POST /runs/{runId}/wait` | bearer | `run wait` |
| `POST /runs/{runId}/cancel` | bearer | `run cancel`, mutating |

- **Trust model.** One trust domain: a single bearer secret, and any holder may start, read and cancel any run. `x-agw-purpose` is a label for the run record, not a scope or a permission.
- **Auth.** `Authorization: Bearer <AGW_API_SECRET>` on everything but `/health`; missing or wrong is `401 UNAUTHORIZED`. Both sides are sha256-hashed and compared with `crypto.timingSafeEqual`. It runs before the contract check and before any handler, so an unauthenticated request starts nothing.
- **Errors.** One body everywhere: `{ defined, code, status, message, data? }`. Codes: `BAD_REQUEST` 400, `UNAUTHORIZED` 401, `NOT_FOUND` 404, `CONFLICT` 409, `CONTRACT_MISMATCH` 412, the capability codes, `INTERNAL_SERVER_ERROR` 500. Input validation failures are `BAD_REQUEST`. `defined` is `true` only for errors a procedure declares (the capability codes, `NOT_FOUND`, `CONFLICT`); the host's own envelopes (`UNAUTHORIZED`, `CONTRACT_MISMATCH`, `SERVICE_UNAVAILABLE`) and the transport-level ones (`INTERNAL_SERVER_ERROR`, an unmatched route) are `false`.
- **Contract.** `info['x-contract-sha']` is the sha256 hex of the canonical JSON (keys sorted recursively, no whitespace) of the document without that field. A request header `x-agw-contract: <sha>` that differs is `412 CONTRACT_MISMATCH` with `data: { server, client }`; no header, no check. `/openapi.json` is never checked, so a stale client can always fetch the new document.
- **Workflows.** Headers: `Prefer: wait=<seconds>` (absent is 0, at most 240; Bun's `idleTimeout` ceiling is 255 s, verified against Bun's docs and `Bun.serve`, which rejects more), `Idempotency-Key` (a repeat with the same body returns the same run, scoped to the workflow; a different body is `409 CONFLICT` naming the key, with `data: { runId }` of the run that stands), `x-agw-purpose` (default `prod`), `traceparent` (joins the caller's trace). A body-less (or empty) `POST` starts a workflow whose input is all defaults; a body sent without a content type is read as JSON and validated like any other.
- **Capabilities are runs.** A capability called over HTTP (`agw llm title`) runs as the one-step workflow `cap.<id>` (step `call`; version: a hash of the capability's schemas and handler), so journal, run record, purpose, fingerprint, telemetry, the Argo outbox and the limits apply as to any run (concept N6). `src/capability-runs.ts` builds the workflows (`createCapabilityWorkflows`, called once in `boot`, which hands the same map to the runtime and to `createHost`; they are not operations: no `/workflows/cap/…` route, no command) and the handler: input is validated first (a `400` starts nothing), then the run starts with the request's `x-agw-purpose`, `Idempotency-Key` (a repeat answers with the first run's output or error, no second model call) and `traceparent`; the request waits for it without a deadline and answers with its output or the capability's own typed error, the same body and status as a call without a run. The step journals the error as `CODE: message`, a newline and one JSON line `{"agwCapabilityError":1,"code","status","data"}`; only that last line is parsed, so a replay or another process rebuilds the same answer. A refused run (wallet gate, runaway cap: the kinds a workflow route reports in its failed run state) is `503 SERVICE_UNAVAILABLE` with the refusal's reason and `data: { runId, kind }`; any other failure is an opaque `500 run <id> failed`, its detail logged. The run id comes back in the `agw-run-id` header, on errors too. A client that goes away mid-run cancels the run only without an `Idempotency-Key` (that request alone created it); a keyed run finishes, and the retry with the key gets its result. A host shutdown leaves the run to recovery. The input is parsed again by the workflow and by the capability's `call`; no capability input uses a transform, so the parses agree. In-process calls (`registry.call` inside a step) stay plain calls whose usage belongs to the step.
- **Strict inputs.** Workflow inputs reject unknown keys like capability inputs (`400 BAD_REQUEST`, `additionalProperties: false` in the document), so a typo fails loudly instead of running on defaults.
- **Run state.** `{ runId, workflowId, status, output?, error?: { kind, message } }` (the document types `output` with the workflow's own output schema on its start route, written in by `withOutputType` so `agw schema <workflow>` prints it, with refs inlined and its own description kept; a response shape or output schema it cannot write (a `$ref`/`$defs`, a cycle) fails the start, since the document is built at boot; the run operations serve any workflow and leave it open, and the host does not validate a stored output against it, so an older run still reads): `200` when `done|failed|cancelled`, `202` while `pending|running` (the OpenAPI document lists both). A failed run is a `200` with `status: 'failed'`; the failure is the run's state, not the request's. A done run whose output is `null` keeps `output: null`; a run without output has no `output` key. A held wait retries a failed journal read on the poll backoff, logging each, until the deadline or 5 failures in a row, then answers with the error. Unknown run: `404 NOT_FOUND`. Cancel of an ended run is `200` with its state; cancel of a running run waits (`Prefer: wait`, else up to 10 s) for the run to end, `202` if it has not by then.
- **`x-cli`.** Capabilities carry `kind: 'capability'`; workflows `{ command: id.split('.'), kind: 'workflow', mutating: false, defaultFormat: 'json', resume: { command: ['run','wait'], positional: ['runId'] } }`; run ops `kind: 'run'`, positional `['runId']`. A workflow declares `positional`, `stdin`, `mutating` in its `HostWorkflow.cli`.
- **Reserved flags.** The CLI's own `--format`, `--commit`, `--idempotency-key` and `--help` always win, so no capability or workflow input may have a property named `format`, `commit`, `idempotencyKey`, `idempotency-key` or `help`; the host refuses to start otherwise (`llm.summarize` takes `style`).
- **Collisions.** Two operations on the same command, or one command extending another (`agw run` next to `agw run wait`), the same operation id or `METHOD path` throw at `createHost`.

## Journal reads

Run state comes from `Runtime.getRun` and `Runtime.ping` (the runtime's public read API). The only SQL in the host is the learnings store and the retrospective's sampling (below), through one small pool of its own (2 connections, 30 s statement timeout) that never touches the run path. A held `Prefer: wait` polls `getRun`: one primary-key read per poll, backed off from 25 ms to 250 ms, so waiters cost the journal pool far less than the run writes. If that ever starves the pool (the runtime's `journalPoolSize`, default 10), the fix is a separate read pool inside the runtime, not more SQL in the host.

## Known gaps

- `/health` does not reflect stale recovery ticks: it says the runtime is open and Postgres answers, not that recovery is still running.

## Retrospective and learnings (concept §7)

**`agw retrospective <workflow>`** (`src/workflows/retrospective/`) looks back on one workflow that runs agents.
Input: `workflow`, `window` (days, default 7), `sample` (runs, default 20), `fileIssues` (default false).

| Step | Does |
|-|-|
| `sample` | Finished (`done`/`failed`) top-level runs of the workflow inside the window, `purpose <> 'eval'`, failed runs first, then a stable spread by id hash. Reads outcome, wall time, cost, tool calls, `friction` (null until `w5/friction` fills it; tolerated), and per step: kind, status, model, error, a 1 200-character output preview. **Never the run input** (it holds working directories and diffs) |
| `analyze` | One agent step (`agents/retrospective/`, route `retro.analyze`, a copy of `check`'s model and wire, no tools, edit denied) over the sample rendered as text (at most 120k characters; step previews shrink 600 → 300 → 120 → none before runs are cut; absolute paths become `<path>`). One JSON-only retry on invalid output, then the run fails |
| `store-learnings` | Candidate facts are stored as **`proposed`**, never active |
| `file-issues` | Only with `fileIssues: true`. Per proposal: filter, find an issue with the same title, else create one |

Output (typed): `proposals[]` (kind `capability | agents-md | skill | cli`, target, title, change, evidence run ids,
confidence), `learnings[]` (agent, fact, evidence, stored id), `issues[]` (title, `filed | duplicate | refused`, url or reason)
and `dropped[]`. Before anything is stored or filed the answer is checked in code: evidence must be run ids that were in the
sample, a learning must name an agent the workflow runs, a target must be an agent, an `agw` command or a path in this repo;
the rest is dropped with its reason, never repaired. Proposals are never applied.

**Issues and the public repo** (`issue.ts`, `tracked.ts`, `gh.ts`). Public by construction, not by filtering: an issue is
built from structured fields only: kind, **target** (must be a path tracked in this repo: a file, a directory holding
tracked files, or an agent name standing for `agents/<name>`), confidence, evidence run ids and a fixed line pointing at
`agw run status <retroRunId>`. The model's free text (`change`, `title`, facts) never goes into an issue; it stays in the run
output (the private journal). A proposal whose target is not tracked is `refused` (it still appears in the output). *What is
tracked:* a release is a `git archive` of the commit plus `node_modules` (`scripts/deploy.sh`), so the release tree minus
`node_modules` is the tracked list; a dev checkout asks `git ls-files`. Read once per process, on the first filing. The same
function builds the title (`retro(<workflow>): <kind> change for <path> [<hash8>]`) and a marker
`<!-- agw-retro:<sha256(kind + target + normalised change), first 16 hex> -->` (case and whitespace of the change do not
matter). **Dedupe** searches the marker (`gh issue list --state all --search '"agw-retro:<hash>" in:body'`) and verifies it
against the issue's own body; two proposals with one hash in a run collapse. **Known window:** GitHub's search index lags a
new issue by seconds to minutes, so a second run in that window can file a duplicate; the weekly cadence and the retry bound
keep that rare, and no lock closes it. Without `AGW_RETRO_FILE_ISSUES` the port is never called. The agent's *prompt* data is
still scrubbed (`scrub.ts`: absolute paths of any shape, `~/…`, Windows drive paths, single-segment paths like `/tmp`, token-shaped
strings), as hygiene for what the model sees, not as a boundary.

**Weekly schedule** (`schedule.ts`, `boot.ts`). An hourly tick (and one at start) asks the journal which agent workflows had
finished non-eval runs in the last 7 days and starts one `retrospective` per workflow with the idempotency key
`retro:<workflow>:<ISO week>` (purpose `retro`). A week whose runs have **all failed** is retried under
`<key>:retry-<n>` (at most 3 per week, a lifecycle bound on re-starts and not a cap on the agent; a running, done or
cancelled run of the week stands, so a retry never doubles one). The `(workflow, idempotency_key)` constraint makes it once per workflow and
week however often it ticks or the host restarts; the first tick of a new week starts it, so a host down on Monday catches up.
Flipping `fileIssues` mid-week hits the same key with another input: that week's run stands (no error, no second run).

**`agw learnings list|add|activate|retire`** (`src/learnings/`). Per-agent facts in `<schema>.learnings`
(migration `0005_learnings.sql`: agent, fact, source = run id or `manual`, evidence, status `proposed | active | retired`,
`created_at`, `activated_at`, `retired_at`; one row per fact and agent, **retired rows included**: a retired fact is a rejected
one and a retrospective never proposes it again (the add returns the retired row). A human brings it back with
`agw learnings add` (source `manual`), which reuses the row. A fact containing the learned-facts fence tag is refused on add and
on activate and skipped when rendering). Decision: each command is a
one-step workflow rather than a new operation kind, so it appears in the generated CLI through the existing workflow path,
carries the platform contract and leaves a run record of who changed what; the cost is a journal row per command.
`add` proposes (`--activate` for the human path), `activate` makes a proposed fact live, `retire` ends any fact.

**Read-back.** `RuntimeOptions.agentPrompt` (runtime, additive) lets the host append to an agent step's task message right
before the session is opened or prompted (not on a re-attach to a prompted session). The host appends the agent's active facts
(the 25 most recently *activated*, in activation order, so a late activation of an old fact is not lost) as a fenced
`<learned_facts>` block after the task and before the step's `tail` (a retry directive such as "answer with JSON only",
which `AgentSpec.tail` keeps last; the retrospective uses it, `check` and `review` still append theirs to the prompt and could
adopt it); with no active facts the message is unchanged. A
lookup failure is logged and the plain task is sent. `withLearningsFingerprint` wraps the fingerprint source: an agent with
active facts gets a `learnings/active` pseudo-file holding the digest of its set, so activate and retire change the fingerprint
of every workflow that runs the agent, and an agent without facts keeps the fingerprint it has today. The fingerprint is read at
admission and the facts at the step's prompt, so a fact changed during a run shows in that run's output but in the next run's
fingerprint (a window of minutes). Retire takes effect on the next run.

## Adding a workflow

Define it with `defineWorkflow` (input must be a `z.object`; list its agents in `HostWorkflow.agents` so their files and routes feed the run fingerprint), add it to `src/workflows/index.ts` as a `HostWorkflow`, and it appears as `POST /workflows/…` and `agw <id words>` with no other code. `smoke.ping` (`src/workflows/smoke.ts`) is the reference: one code step calling `llm.title` through `registry.call`, its usage passed to the step's `addUsage` so the run has priced usage that reaches Argo.

## Evals (concept §6)

`src/workflows/eval/` serves the regression and comparison side of the scorers; `review` and `check` carry a scorer
(`src/workflows/{review,check}/scorer.ts`), attached for regression and drift only: neither workflow calls
`ctx.score`, so production behaviour is unchanged (an inline gate is a later experiment).

| Command | Does |
|-|-|
| `agw eval run <review\|check> [--ids a,b] [--limit N] [--concurrency N] [--args '{…}'] [--yes]` | Without `--yes`: the plan (selected case ids) and an estimate (mean cost of the workflow's latest 50 done runs × cases), nothing runs. With `--yes`: each case materialized like the harness does (`materialize` from `@agent-workflows/eval`), run as its own top-level run with purpose `eval`, scored against the case's reference, the verdict and the arm's `args` recorded on that run (`scores.final`); the output lists per-case scores, the fingerprints and the means |
| `agw eval compare <review\|check> --a <fp> --b <fp> [--a-args '{…}'] [--b-args '{…}'] [--seed N]` | Two arms paired by case id: per metric the means, the mean and median delta (B − A) with seeded bootstrap 95% CIs (harness `stats.ts`), and which arm the CI favours. Scores are higher-is-better; `costUsd`, `wallMs`, `tokens`, `toolCalls` lower-is-better. Reads only |
| drift (no command) | every `AGW_DRIFT_INTERVAL_S`, up to 20 sampled, unscored production runs of a workflow with a scorer are scored (`source: drift`); the sample is a hash of the run id, the write first-writer-wins, so several hosts never score a run twice. A tick counts verdicts and recorded scorer errors apart (and warns on errors) |

- **Spend gate: `--yes`, not `--commit`.** The CLI's `--commit` gate (mutating operations) applies only off a TTY and
  shows nothing first; an eval spends IU money (concept N8) whoever types it, so `eval.run` is not `mutating`: the
  default answer is the plan with the estimate, and only `--yes` spends.
- **An arm is a fingerprint plus the exact `--args`.** An input such as `angleVariant` changes behaviour without
  changing the fingerprint, so compare selects by both: equal fingerprints compare when the args differ, and two
  identical arms are refused. A fingerprint may be given as a unique prefix (8+ characters). Reruns of a case in one
  arm are averaged before pairing; a run with unpriced calls leaves its cost out instead of comparing a lower bound;
  mixed scorer versions and fewer than 10 paired cases are reported as `warnings`.
- **Resume and cancel.** Each case run is keyed `eval:<evalRunId>:<caseId>`, and its clone lives in a directory
  derived from that key (`agw_eval_case_<sha256[:16]>` in the temp dir). A resumed `eval.run` looks the key up before
  anything else: a case scored by this eval run is reported as recorded (no clone, no install, no second score); one
  still running is waited on and scored; only a case with no run is materialized and started. A failure on that path
  (a lookup, a wait, a score) is that case's error result, never the whole step's. After a case is done its directory
  is removed, so the process that adopts a case after a shutdown removes the tree the first process kept. Cases go
  through a pool that takes no new case after the first failure. Cancelling `eval.run` cancels its case runs (a case
  run that starts after the cancel fired is cancelled too, and no case starts after it), waits up to 30 s for each to
  end, and only then removes its clone. A tree is removed only when its run is known ended (a terminal status read
  just then) or known never started; a failed lookup or wait, or a live run, keeps it, and a sweep (at start and
  hourly) removes `agw_eval_case_*` directories older than 3 h whose run has ended or does not exist (a marker file
  in each names its run). On resume, a case whose recorded score is a scorer error is scored again. A shutdown or a lost lease leaves
  the case runs going and keeps their clones for the next process. A scorer error is a case `error` (reason
  `scorer: …`), out of the pass rate and the means. Repeated `--ids` are deduplicated.
- **What compare will not call.** A metric with fewer than 5 pairs gets `better: unknown`, whatever its CI, and a
  warning says the verdict is withheld (for every metric when fewer than 5 cases pair at all). A case with any
  unpriced rerun leaves `costUsd` on that side (`cases.unpricedCost`), never averaged over its priced reruns; a case
  with no cost recorded at all is counted apart (`cases.noCost`), and the cost warning names both. A run with a scorer
  error is no verdict: it is left out of its arm (`scorerErrors`, warned). An arm that itself mixes scorer versions
  is warned too. Each arm is read with its fingerprint prefix and args in SQL, never the workflow's whole
  history.
- **Wiring.** `wireEval` (in `boot`) binds the eval workflows to the runtime before it opens (recovery may resume an
  eval run at once) and owns the drift job's timer; the runtime has no `judge`, so no scorer can call a model.

## Process

`main.ts` binds the port first and only then opens the runtime, so a taken port (a deploy overlap) fails before any run is claimed; every resource registers its closer as it is created, and a failure anywhere in the start runs the same teardown as a signal. It builds the runtime with `platformMiddleware` (purpose, fingerprint, record, telemetry) followed by the wallet gate and the runaway cap, opens it (migrates the journal, starts the recovery tick), starts the outbox flush tick (30 s, when Argo is configured) and serves. SIGTERM/SIGINT: stop accepting (held waits get 5 s to answer), `runtime.close()`, the cap's pool, `platform.close()` (flushes telemetry), exit 0. A second signal exits at once, and an unref'd timer (45 s, past the runtime's body grace) exits regardless if a close hangs. An uncaught exception shuts down the same way (exit 1); an unhandled rejection is logged and the process keeps serving. Until the runtime is open, `/health` is degraded and every other route is `503`. Runs stay `running` and the next process resumes them (concept §3: deploys need no drain); `test/main.test.ts` kills a process mid-run and watches a second one finish it.

The OpenCode `AgentHost` is wired in `boot.ts` (`lazyOpenCodeHost`): an `OpenCodeServer` and an `OpenCodeHost` with an empty agent list (no agent definitions exist yet). Both are built on the first agent step, not at boot, so a host without agent workflows never spawns or probes `opencode`; a failed start is not cached and the next step retries. Shutdown closes the host and stops supervising the server, which keeps running for the next process (opencode-host README). `BootOptions.agentHost` replaces it in tests.

## Deploy

`make deploy` (`scripts/deploy.sh`) deploys `origin/master` on the mini as a **release**; `make deploy DRY_RUN=1` prints the plan and the rendered plist and changes nothing.

| Path (under `~/.agent-workflows`) | Is |
|-|-|
| `repo` | the clone; fetch only, nothing runs from it |
| `releases/<sha>` | one immutable export of a commit (`git archive`) with its own `node_modules`; a `.complete` marker is written last, and the live release is never written to |
| `current` | symlink to the live release; the CLI link goes through it |
| `data/deployed-sha`, `data/previous-sha` | the live and the rollback release |

1. Preflight, before anything is built, stopped or written: the tools exist, `~/.local/bin/agw` is not a regular file, and the API secret reads through `secrets-run`.
2. `repo` is fetched; `origin/master` is exported to `releases/<sha>` and `bun install --frozen-lockfile` runs there. A failure removes the half-built release and leaves the running host untouched. The release's own `deploy.sh` takes over once, pinned to the same sha.
3. `deploy/com.jkrumm.agent-workflows-host.plist.template` is rendered into `~/Library/LaunchAgents/` (`__HOME__`, `__RELEASE_DIR__`, `__SHA__`) and the LaunchAgent `com.jkrumm.agent-workflows-host` is booted out and bootstrapped. The plist points at the release path, not at `current`: it is the single statement of what runs, and moving the symlink can never change a running host's code. `KeepAlive`, `ExitTimeOut` 120 s (the host's own backstop is 45 s; the deploy waits `ExitTimeOut` + 10 s for the unload and refuses to bootstrap over a host that is still loaded), logs in `~/Library/Logs/agent-workflows-host.{out,err}.log`, env `AGW_MACHINE=mini`, `AGW_PORT=7791`, `AGW_VERSION=<sha>`.
4. `/health` must answer `ok` with `version` equal to the new sha within `HEALTH_WAIT_SECS` (120). If it never does, the deploy prints the new build's log tails and **rolls back**: the previous release is re-rendered, bootstrapped and awaited (version = previous sha); both outcomes are printed and the deploy exits 1, `deployed-sha` unchanged. With no previous release (the first deploy) the LaunchAgent is booted out, so `KeepAlive` does not loop a failing launch every 30 s.
5. Healthy: `current` moves to the release, `previous-sha` is written, `${XDG_CONFIG_HOME:-~/.config}/agw/env` is written at mode 0600 (created under `umask 077`; `AGW_URL` and `AGW_API_SECRET`), `~/.local/bin/agw` is linked, and only then `deployed-sha`, so "deployed" means the CLI works too. The newest 3 releases stay, plus the live and the previous one; older ones are removed (only directories named like a full sha).

The LaunchAgent runs `/bin/zsh scripts/launch.sh` (never a Homebrew binary: macOS BTM). `launch.sh` exits 78 unless every ref in `.env.tpl` resolves through `secrets-run`, naming the refs that do not (refs, never values). Then `secrets-run run --env-file=.env.tpl` starts the host, with `AGW_PG_URL` built from `AGW_PG_PASSWORD` and `OTEL_EXPORTER_OTLP_HEADERS` from `OTEL_EXPORTER_OTLP_AUTHORIZATION` (secrets-run resolves whole-value refs only); the raw pieces are unset before the host starts.

**An untracked IU key override** (a team key for interim evals; the label goes with it): if `~/.config/agw/iu.env` exists, `launch.sh` reads `IU_API_KEY` and `IU_KEY_ID` from it and they replace the `.env.tpl` values before the host starts. The file must be a regular file at mode 0600, else `launch.sh` exits 78 and says why; it must set both names (a key without its label would be mis-attributed) with a non-empty `IU_API_KEY` and an `IU_KEY_ID` of exactly `personal` or `athena-team`, else 78. Values may be unquoted, double- or single-quoted; a trailing CR is stripped. Any other line is ignored with a warning that names the variable, never a value; values are never printed. Absent file: no override. `launch-override.test.ts` runs the block with a fake HOME.

`make verify` (`scripts/verify.sh`) exits 0 only if `/health` is ok, the deployed sha equals `origin/master` and is what the host reports, `AGW_PURPOSE=verify agw smoke ping` exits 0 with a `title`, and that run's row in `agw.runs` is `done` with a trace id and priced usage, and a direct `AGW_PURPOSE=verify agw llm title …` leaves a `cap.llm.title` row `done` with priced usage. It prints both run ids.

## Token effect / cache effect

The learnings read-back adds tokens only where a fact is active: the fenced block is appended **after the task message**, never
into `AGENTS.md`, so the agent's cached prefix (system prompt, skills) is untouched; the block costs its own tokens
(at most 25 facts of at most 400 characters, in practice a few hundred) on every step of that agent, and a changed fact set
changes the message tail only. Activating or retiring a fact changes the run fingerprint (one new fingerprint group, no
cold prompt cache: the prefix is unchanged). The retrospective is its own spend: one Haiku-class agent step per workflow and week
over at most ~30k input tokens of sampled records, no tools, plus at most one JSON retry; nothing runs when a workflow had no runs.
Otherwise none of its own. The host adds no model-visible text and no tokens (the default scorers and drift are deterministic; `agw eval run --yes` costs what its case runs cost, tagged `purpose: eval`, and says so before it runs): workflow input goes to the runtime unchanged and capability calls go to the route table as the capabilities README describes. Held requests poll the journal, not a model. Two things to know: `agw schema <workflow>` now prints the workflow's output schema too (about a screenful for `review`), which a caller reading it spends context on once; a deploy that changes an `AGENTS.md`, skill, route or the OpenCode version changes the run fingerprint and costs one cold prompt cache (middleware README), and a capability called straight over HTTP (`agw llm title`) is a `cap.<id>` run of its own, recorded and in Argo like any run; one inside a workflow step counts on that step.

## Tests

`bun test packages/host` against a real Postgres (`AGW_TEST_PG_URL`, a throwaway schema per file) and the capabilities' fake IU server:

| File | Covers |
|-|-|
| `http.test.ts` | auth (missing, wrong, right, constant-time path, secret refusal), `/health` ok and degraded, the document and its sha, contract mismatch, collisions, `Prefer` parsing |
| `workflows.test.ts` | start 200 and 202, `run wait`, idempotency replay, purpose, failed runs, 404s, cancel of running and ended runs, a wait that stops with its client |
| `learnings.test.ts` | the store (propose, activate, retire at once, dedupe, a retired fact is never re-proposed and only a manual add revives it, activation order, the fence refused, the newest 25 read back), the read-back into the task message (proposed no, active yes, retired no on the next run), the fingerprint (unchanged without facts, moved by activate and retire), `agw learnings` over HTTP |
| `retrospective.test.ts` | sampling (window, eval/running/cancelled/child runs excluded, failed first, limit, null friction, no run input, preview cut), the agent step on `FakeAgentHost` with a fixture answer, dropped answers, the JSON retry (facts before the directive), no runs → no session, issues off/on/dedupe by marker/refused on a fake `gh` port, ISO weeks, weekly idempotency, failed-week retries and their bound |
| `retro-issue.test.ts` | the issue (structured fields only, hostile model text never in it, untracked targets refused, hash stability), `TrackedPaths` on a release tree and a git checkout, target shape, the prompt scrub |
| `retro-wiring.test.ts` | config (`AGW_RETRO_*`), registration and fingerprint refs, the `gh` argument lists |
| `smoke.test.ts` | `smoke.ping` end to end behind the platform middleware: usage on the step, the row in Argo |
| `capability-runs.test.ts` | a direct `llm.title` call as a `cap.llm.title` run: same body and errors as without a run, usage and the Argo row, invalid input starts nothing, no nested run under `smoke.ping`, idempotent replay (success and failure), an unkeyed abort cancels the run, a keyed one does not (alone or as a retry of a running key), the journaled error wire format, opaque and refusal failures |
| `scorers.test.ts` | the review and check scorers on fixed fixtures: structure without a reference (failed angles, salvage, balance, invalid output), recall / precision / outcome against a reference |
| `eval.test.ts` | `eval.run` on a fake agent host with two check cases on a real git repo (plan without `--yes`, purpose `eval`, scores and fingerprint recorded, clones removed, bad ids and args refused), `eval.compare` with equal fingerprints by args and on synthetic runs with known deltas, drift scoring each sampled run once across two jobs |
| `eval-cli.test.ts` | the document as the CLI reads it: `agw eval run` and `agw eval compare` are commands with their flags, none skipped |
| `eval-resume.test.ts` | a resumed `eval.run` adopts its case runs (no new clone, a scored case not scored again, the running one's clone kept across the shutdown and removed by the adopting process); a cancelled one cancels its running case, starts no further case and removes a clone only after its run ended (a slowed cancel proves the order); an adopt-path failure and a scorer error are per-case errors outside the pass rate |
| `main.test.ts` | config, `lazyOpenCodeHost` (nothing built before the first agent step, a failed start retried), `boot` (a taken port fails before the runtime opens), the process entry: refusals, SIGTERM leaves a run `running` with exit 0, a second process resumes it |
| `launch-override.test.ts` | the `launch.sh` IU override block in `/bin/sh` with a fake HOME: absent file, both names override, other lines warned by name only, CR and quote styles, refused with 78: a mode other than 0600, a missing name, an empty key, an unknown label |
| `lifecycle.test.ts` | signals, the hard-exit backstop, second signal, uncaught exception vs unhandled rejection |
