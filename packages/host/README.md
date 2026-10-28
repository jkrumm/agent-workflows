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
| `ARGO_URL`, `ARGO_API_SECRET` | no | the usage outbox is on when both are set |
| `OTEL_EXPORTER_OTLP_ENDPOINT` (or `…_TRACES_ENDPOINT`), `OTEL_EXPORTER_OTLP_HEADERS` | no | span export is off without an endpoint |
| `AGW_ROUTES`, `AGW_WALLET_*` | no | route overrides (routes README), wallet gate (limits README) |

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
- **Run state.** `{ runId, workflowId, status, output?, error?: { kind, message } }` (the document types `output` with the workflow's own output schema on its start route, written in by `withOutputType` so `agw schema <workflow>` prints it; the run operations serve any workflow and leave it open, and the host does not validate a stored output against it, so an older run still reads): `200` when `done|failed|cancelled`, `202` while `pending|running` (the OpenAPI document lists both). A failed run is a `200` with `status: 'failed'`; the failure is the run's state, not the request's. A done run whose output is `null` keeps `output: null`; a run without output has no `output` key. A held wait retries a failed journal read on the poll backoff, logging each, until the deadline or 5 failures in a row, then answers with the error. Unknown run: `404 NOT_FOUND`. Cancel of an ended run is `200` with its state; cancel of a running run waits (`Prefer: wait`, else up to 10 s) for the run to end, `202` if it has not by then.
- **`x-cli`.** Capabilities carry `kind: 'capability'`; workflows `{ command: id.split('.'), kind: 'workflow', mutating: false, defaultFormat: 'json', resume: { command: ['run','wait'], positional: ['runId'] } }`; run ops `kind: 'run'`, positional `['runId']`. A workflow declares `positional`, `stdin`, `mutating` in its `HostWorkflow.cli`.
- **Reserved flags.** The CLI's own `--format`, `--commit`, `--idempotency-key` and `--help` always win, so no capability or workflow input may have a property named `format`, `commit`, `idempotencyKey`, `idempotency-key` or `help`; the host refuses to start otherwise (`llm.summarize` takes `style`).
- **Collisions.** Two operations on the same command, or one command extending another (`agw run` next to `agw run wait`), the same operation id or `METHOD path` throw at `createHost`.

## Journal reads

Run state comes from `Runtime.getRun` and `Runtime.ping` (the runtime's public read API); the host has no SQL and no pool of its own. A held `Prefer: wait` polls `getRun`: one primary-key read per poll, backed off from 25 ms to 250 ms, so waiters cost the journal pool far less than the run writes. If that ever starves the pool (the runtime's `journalPoolSize`, default 10), the fix is a separate read pool inside the runtime, not SQL in the host.

## Known gaps

- `/health` does not reflect stale recovery ticks: it says the runtime is open and Postgres answers, not that recovery is still running.

## Adding a workflow

Define it with `defineWorkflow` (input must be a `z.object`; list its agents in `HostWorkflow.agents` so their files and routes feed the run fingerprint), add it to `src/workflows/index.ts` as a `HostWorkflow`, and it appears as `POST /workflows/…` and `agw <id words>` with no other code. `smoke.ping` (`src/workflows/smoke.ts`) is the reference: one code step calling `llm.title` through `registry.call`, its usage passed to the step's `addUsage` so the run has priced usage that reaches Argo.

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

None of its own. The host adds no model-visible text and no tokens: workflow input goes to the runtime unchanged and capability calls go to the route table as the capabilities README describes. Held requests poll the journal, not a model. Two things to know: `agw schema <workflow>` now prints the workflow's output schema too (about a screenful for `review`), which a caller reading it spends context on once; a deploy that changes an `AGENTS.md`, skill, route or the OpenCode version changes the run fingerprint and costs one cold prompt cache (middleware README), and a capability called straight over HTTP (`agw llm title`) is a `cap.<id>` run of its own, recorded and in Argo like any run; one inside a workflow step counts on that step.

## Tests

`bun test packages/host` against a real Postgres (`AGW_TEST_PG_URL`, a throwaway schema per file) and the capabilities' fake IU server:

| File | Covers |
|-|-|
| `http.test.ts` | auth (missing, wrong, right, constant-time path, secret refusal), `/health` ok and degraded, the document and its sha, contract mismatch, collisions, `Prefer` parsing |
| `workflows.test.ts` | start 200 and 202, `run wait`, idempotency replay, purpose, failed runs, 404s, cancel of running and ended runs, a wait that stops with its client |
| `smoke.test.ts` | `smoke.ping` end to end behind the platform middleware: usage on the step, the row in Argo |
| `capability-runs.test.ts` | a direct `llm.title` call as a `cap.llm.title` run: same body and errors as without a run, usage and the Argo row, invalid input starts nothing, no nested run under `smoke.ping`, idempotent replay (success and failure), an unkeyed abort cancels the run, a keyed one does not (alone or as a retry of a running key), the journaled error wire format, opaque and refusal failures |
| `main.test.ts` | config, `lazyOpenCodeHost` (nothing built before the first agent step, a failed start retried), `boot` (a taken port fails before the runtime opens), the process entry: refusals, SIGTERM leaves a run `running` with exit 0, a second process resumes it |
| `launch-override.test.ts` | the `launch.sh` IU override block in `/bin/sh` with a fake HOME: absent file, both names override, other lines warned by name only, CR and quote styles, refused with 78: a mode other than 0600, a missing name, an empty key, an unknown label |
| `lifecycle.test.ts` | signals, the hard-exit backstop, second signal, uncaught exception vs unhandled rejection |
