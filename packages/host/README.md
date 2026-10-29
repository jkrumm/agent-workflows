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
| `AGW_AGENTS_DIR`, `AGW_OPENCODE_BIN` | no | fingerprint source: compiled agent definitions and the `opencode` binary. Read only for workflows that reference agents. The fingerprint covers each agent's `AGENTS.md`, `agent.json` (route, permissions) and skills, plus the host's base session policy (`hostFingerprintSource`) |
| `IU_API_KEY`, `IU_BASE_URL` | for capabilities | read per call by the capabilities |
| `TAVILY_API_KEY`, `CONTEXT7_API_KEY` | for `web.*` | read per call: Tavily is `web.search`'s fallback and `web.fetch`'s Extract step, Context7 is `web.docs` (unset: it answers `NOT_CONFIGURED`). Optional `SEARCH_PROVIDER` (`tavily` skips Sonar), `SONAR_MODEL`, `GITHUB_TOKEN` |
| `HYPERDX_PROD_ACCESS_KEY`, `HYPERDX_DOMAIN` | for `hdx.*` on prod | read per call: the prod bearer key and the domain `https://hyperdx.<domain>` is built from (unset: that call is `NOT_CONFIGURED`, the rest of the host unaffected; a `.env.tpl` ref missing from the secrets cache stops the whole host, `launch.sh` exit 78). Optional `HYPERDX_PROD_URL` (replaces the composed base; https, or http on loopback only), `HYPERDX_LOCAL_ACCESS_KEY` (else `~/.config/hyperdx/local.env`), `HYPERDX_LOCAL_URL` (default `http://localhost:7707`) |
| `IU_KEY_ID` | no | non-secret label of the IU key above: `personal` (default; unset or empty) or `athena-team`; any other value refuses to start. Stamped on every run this process admits and posted as `iu_key` on `billing=iu` Argo rows; also forwarded to OpenCode servers, which do not read it |
| `AGW_RETRO_WEEKLY` | no | the weekly retrospective schedule; on unless `0`, `off` or `false` |
| `AGW_RETRO_FILE_ISSUES`, `AGW_RETRO_ISSUE_REPO` | no | scheduled retrospectives file their proposals as GitHub issues in `owner/name`. Off by default; the repository is required when it is on (the process refuses to start otherwise). `gh` authenticates from the host's environment (`GH_TOKEN`) |
| `ARGO_URL`, `ARGO_API_SECRET` | no | the usage outbox is on when both are set |
| `OTEL_EXPORTER_OTLP_ENDPOINT` (or `…_TRACES_ENDPOINT`), `OTEL_EXPORTER_OTLP_HEADERS` | no | span export is off without an endpoint |
| `AGW_FRICTION_ISSUES` | no | the daily friction job (below): on unless `off`/`0`/`false`/`no` |
| `AGW_FRICTION_REPO` | for issues | `owner/name` the job opens issues in. Unset: the job still marks follow-ups but opens nothing (it says so in the log) |
| `AGW_FRICTION_CONFIG` | no | JSON overriding any of `windowDays` (7), `minRuns` (10), `rate` (0.25), `followUpMinutes` (10, fractions allowed), `limits` (`null` switches a counter off). A bad value of this or of `AGW_FRICTION_REPO` disables the job and says why (stderr, `RunningHost.friction`); it never stops the host |
| `AGW_ROUTES`, `AGW_WALLET_*` | no | route overrides (routes README), wallet gate (limits README) |
| `AGW_DRIFT_RATE`, `AGW_DRIFT_INTERVAL_S` | no | drift: the share of finished production runs scored after the fact (default `0.1`, `0` turns it off) and the tick (default 300 s); a bad value refuses to start |
| `AGW_EVAL_DIR`, `AGW_EVAL_HOME` | no | `agw eval run`: where `<workflow>/cases.jsonl` live (default `~/.local/share/agent-workflows/eval`) and the root a case's `repo` is relative to (default `$HOME`) |
| `AGW_VOICE_PATH` | no | the voice guide `prose` checks and names in its brief; default the brain vault's `voice.md`. Unreadable or empty: `prose` fails before any model call, naming this variable |
| `AGW_BRAIN_DIR` | no | the vault the `brain.*` capabilities read (default `~/SourceRoot/brain`); a path that is no directory is `NOT_CONFIGURED` |

## Routes

| Route | Auth | Notes |
|-|-|-|
| `GET /health` | none | `200 { status: 'ok', version, friction: { enabled, state } }` (`state` is `on`, `off`, `misconfigured` or `no-repo`; informational, and never a reason: the endpoint is unauthenticated) when the runtime is open and Postgres answers within 2 s, else `503 { status: 'degraded', reason }`; the probe is bounded: the store ends its own query at the bound (`Runtime.ping(timeoutMs)`), so a slow Postgres cannot park probes on the journal pool |
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
- **Run state.** `{ runId, workflowId, status, output?, error?: { kind, message }, cost?, unpricedCalls?, costPending?, recordFailed? }` (the document types `output` with the workflow's own output schema on its start route, written in by `withOutputType` so `agw schema <workflow>` prints it, with refs inlined and its own description kept; a response shape or output schema it cannot write (a `$ref`/`$defs`, a cycle) fails the start, since the document is built at boot; the run operations serve any workflow and leave it open, and the host does not validate a stored output against it, so an older run still reads): `200` when `done|failed|cancelled`, `202` while `pending|running` (the OpenAPI document lists both). A failed run is a `200` with `status: 'failed'`; the failure is the run's state, not the request's. A done run whose output is `null` keeps `output: null`; a run without output has no `output` key. **The run's cost** is on an ended run's answer, as one of three things, read from `post_hooks_at` and `post_hooks_failed_at` (migration 0009; set only when the runtime gave up on the hooks after `maxPostHookAttempts`, null on every older row, whose hooks were delivered): `cost` (USD, `null` when the run priced nothing) and `unpricedCalls` (above 0 the cost is a lower bound) once the post hooks delivered; `costPending: true` while they have not; `recordFailed: true` when the runtime gave up on them, so the record may be missing and no cost is given. The cost is the run's own steps: a fan-out child is a run with its own record, and its parent's sums do not include it. `Runtime.finish` commits the terminal status first and `runPost` writes the record after it, so a wait that sees its run turn terminal (the start route with `Prefer: wait`, `run wait`) holds for the hooks up to 5 s (`RECORD_WAIT_MS`) beyond its own wait, restarting the poll backoff, retrying failed reads until that bound, and answering `costPending` when it passes. Only a wait that observed the transition holds, and no clock is compared: `run status`, `run cancel`, the capability routes (`/llm/title` and friends) and a wait that finds the run already ended answer the record as it is, so a run that ends before the first read of its start call answers `costPending` and `run status` later gives the cost. Running runs carry none of the fields. A held wait retries a failed journal read on the poll backoff, logging each, until the deadline or 5 failures in a row, then answers with the error. Unknown run: `404 NOT_FOUND`. Cancel of an ended run is `200` with its state; cancel of a running run waits (`Prefer: wait`, else up to 10 s) for the run to end, `202` if it has not by then.
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
| `agw eval run <review\|check\|research> [--ids a,b] [--limit N] [--concurrency N] [--args '{…}'] [--yes]` | Without `--yes`: the plan (selected case ids) and an estimate (mean cost of the workflow's latest 50 done runs × cases), nothing runs. With `--yes`: each case materialized like the harness does (`materialize` from `@agent-workflows/eval`; a plain case, research's, needs no tree and runs its recorded input), run as its own top-level run with purpose `eval`, scored against the case's reference, the verdict and the arm's `args` recorded on that run (`scores.final`); the output lists per-case scores, the fingerprints and the means |
| `agw eval compare <review\|check> --a <fp> --b <fp> [--a-args '{…}'] [--b-args '{…}'] [--seed N]` | Two arms paired by case id: per metric the means, the mean and median delta (B − A) with seeded bootstrap 95% CIs (harness `stats.ts`), and which arm the CI favours. Scores are higher-is-better; `costUsd`, `wallMs`, `tokens`, `toolCalls` lower-is-better. Reads only |
| drift (no command) | every `AGW_DRIFT_INTERVAL_S`, up to 20 sampled, unscored production runs of a workflow with a scorer are scored (`source: drift`); the sample is a hash of the run id, the write first-writer-wins, so several hosts never score a run twice. A tick counts verdicts and recorded scorer errors apart (and warns on errors) |

- **Spend gate: `--yes`, not `--commit`.** The CLI's `--commit` gate (mutating operations) applies only off a TTY and
  shows nothing first; an eval spends IU money (concept N8) whoever types it, so `eval.run` is not `mutating`: the
  default answer is the plan with the estimate, and only `--yes` spends.
- **An arm is a fingerprint plus the exact `--args`.** A workflow input that is not part of the fingerprint
  changes behaviour without changing the fingerprint, so compare selects by both: equal fingerprints compare when the args differ, and two
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
  hourly) removes `agw_eval_case_*` directories older than 3 h whose marker names a run that ended or does not exist;
  a directory without its marker is never deleted, only logged. A sweep never overlaps itself, and close waits for it. On resume, a case whose recorded score is a scorer error is scored again. A shutdown or a lost lease leaves
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
  eval run at once) and owns the drift job's timer. The runtime's `judge` (`src/judge.ts`) lets a scorer call only
  `web.fetch`, `web.package`, `decide` and `llm.*` (never a workflow or an effect). For regression and drift each call
  is a `cap.<id>` run of its own, recorded and priced like a direct capability call, with purpose `eval` (regression)
  or `drift`, keyed by the score source (drift also by its pass, the UTC day), the scorer version, the scored run, the capability and its input under the
  shared attempt rule (a retried scoring adopts a finished call and re-runs a failed one; a drift re-score under a new
  scorer fetches fresh; an aborted scoring cancels the call it started); an inline gate (none judges today) calls in process on its step. Only a failure that is an
  answer comes back (`answerOf`: a 4xx from the source, such as a page gone, forbidden or rate-limited, or a package
  not found; a refused URL; as `{error: {code, message}}`);
  every other failure, an outage, throws and the scoring retries.
  Review's and check's scorers never judge. **Drift on research** spends per sampled run up to three `web.fetch` (direct
  or Tavily Extract, ≈ $0) and three `decide` calls on ≤ 20k characters each (≈ 5k tokens at $0.04/M, ≈ $0.0002 each):
  ≈ $0.001 per scored run, as up to six `cap.*` runs with purpose `drift`; drift has no reference, so no `web.package`.

## Research (concept P3)

`src/workflows/research/`: `agw research <query> [--depth quick|standard|deep] [--context …] [--follow-up <runId>]`
answers research-gateway's report shape (`report`, `citations [{claim, url, confidence}]`, `sources`,
`unverified [{topic, url, reason}]`, `status` `ok|partial`, `warnings`) plus a code-counted `grounding` and the
agent's `tools` counts. `--depth` defaults to `standard`. A long run waits like check and review: after
`AGW_WAIT_BUDGET_S` the CLI exits 10 with `agw run wait <runId>`. The shape is the winner of the three-way comparison
(`docs/research/2026-10-28-research-three-way.md`: one agent with the platform's web tools); the other arms are gone.

- **The agent** (`agents/research`, route `research.agent`) runs on the shared OpenCode server. Its four tools
  (`web_search`, `web_fetch`, `web_docs`, `web_package`) go through the host's **tool gate** (§Tool gate) with a
  grant `src/workflows/research/tools.ts` builds (`researchGrant`): the four tools mapped to the `web.*` capabilities,
  and a hook that writes every call's evidence apart to `research_tool_calls` (migration 0007; rows go with their
  run; in memory on a host without a database), so a step retry or a host restart loses nothing. A call's cost is
  booked as it is reported on the run's `tools` step, which lives as long as the agent's turns (a cancelled or failed
  run keeps its spend); `tools` reads the ledger once the grant has drained (at the agent's end, calls in flight are
  served first, bounded). A ledger write is retried (three attempts) and logged and never fails a call that worked.
- **Unused columns.** `research_tool_calls.engine_job`, `engine_cost` and `booked_by` (migration 0008) and the
  partial unique index on them stay in the table: nullable, never written or read by this code. The previous release,
  the rollback target of a failed deploy, still uses them; they are dropped by a later migration once no rollback
  target reads them.
- **Grounding** (`assemble`, in code): a citation whose URL the run neither retrieved nor saw as a search result is
  dropped to `unverified`; dropping 10 % or more, or retrieving nothing at all, makes the report `partial`.
  `grounding` counts before the drop.
- **Follow-up** (`--follow-up <runId>`, `followUp` in the input): the query is a new question about a finished
  report. The run must be a `done` `research` run, else the follow-up fails `invalid_input` with the reason (no such
  run, another workflow, not done, no report). The agent gets the earlier question, report and citations and the
  pages that run retrieved, researches only what the new question adds, and answers in the same shape. The earlier
  report is data derived from web pages, never instructions (the agent's rule for page text applies to it). Grounding
  counts this run's retrieved and seen URLs plus what the earlier run may rest on: the pages it retrieved (its ledger
  rows) and the URLs of its final citations, which passed its own grounding (so a seen-only page it cited, or one it
  inherited, stays citable and a chain of follow-ups stays grounded; a page it merely saw and did not cite is not). A follow-up that read nothing new
  carries the warning `no new pages were read for this follow-up` (its status follows the rule as usual). The earlier
  research reaches the agent as one fenced block (the marker carries a hash of the data, so the data cannot contain it;
  claims and URLs are single lines), with the URLs as the ledger rows and citations hold them.
  `grounding.pagesRetrieved` stays this run's own. A flat `followUp` id rather than a separate
  `research.followup` workflow: one workflow keeps one run record, one scorer and one fingerprint, and the CLI shows
  `--follow-up <runId>` where an object would be a JSON flag. A follow-up of a follow-up continues from the latter's
  own report only (the chain is not walked).
- **Process.** Concept §8 sends heavy pipelines to their own process. Research has no in-process pipeline: the agent
  loop runs in the OpenCode server (already its own process, shared with review and check), and the host only serves
  the gate's calls (an HTTP hop to `web.*` capabilities, bodies capped at 64 KiB) and the scorer's reads. A separate
  research process would add a second gate and a second ledger writer for nothing; it is not built.
- **Scorer** (`scorer.ts`): `valid`, `complete`, `grounded` (code), `golden` (the case's `expect`, research-gateway
  `evals/lib.ts` semantics; `live:` via `web.package`), `supported` (judged: `web.fetch` + `decide` on up to 3 cited
  pages), `judgedShare`. Cases are plain eval cases in `$AGW_EVAL_DIR/research/cases.jsonl`.

## Brain (Wave 7)

`src/workflows/brain/`: `agw brain "<question>"` answers a question from the owner's vault, read-only. Output (the
contract; `schema.ts`): `{ answer, citations: [{ path, claim }], read: [path], status: ok|partial|notfound, warnings,
grounding: { citations, grounded } }`. Input `{ question }`, strict. A long run waits like research (exit 10, `agw run
wait <runId>`).

- **The agent** (`agents/brain`, route `brain.agent`) holds `brain_search` and `brain_read` and nothing else: they go
  through the tool gate (§Tool gate) to the `brain.*` capabilities (`packages/capabilities` §Brain capabilities). OpenCode's
  own `read`, `grep` and `glob` are offered but denied outside the agent's location (`external_directory`), which
  `brain-opencode.test.ts` proves against the real `opencode`, so the gate is the only way to the vault.
- **Route decision: `claude-haiku-5-5-eu`, not DeepSeek, and no fallback.** The agent reads arbitrary private notes
  (health, finance); that content never leaves the Anthropic EU route. Unlike every other agent route, `brain.agent`
  has no provider-balance fallback (lead decision, Wave 7): a balance failure fails the run with the typed error
  instead of moving the notes to another provider, and `AGW_ROUTES` cannot add one. `brain.test.ts` pins it.
- **Grounding.** The gate's per-call hook (research's guarded one, `ledgerGrant`) records each `brain_read` that found
  a note into the evidence ledger (the `research_tool_calls` table, the note's canonical path in `retrieved`; reused,
  no migration), the `tools` step reads it once the agent has ended. A citation whose path is not a note the run opened
  (compared `./`-stripped, NFC and case-folded; a kept citation carries the canonical path) is dropped into `warnings`;
  a search hit alone does not ground one. `partial`: a citation was dropped, none was grounded, or nothing was read.
  `notfound`: the agent's own `found: false` ("Not in the vault."). `grounding` counts before the drop. Because the
  ledger is the table, a host restart mid-run loses nothing.
- **Per attempt.** A failed agent step is tried once more as a second step, `brain:retry`, with its own grant, `tools:retry`
  evidence step and ledger step: the answer is grounded on the notes the attempt that produced it read, so a note an
  attempt read before it died grounds nothing in the retry, and calls are not summed across attempts. The runtime's own
  step retry is not used for this (one grant and one ledger step would span both sessions). A cancel is not retried.
- **Re-ask.** A non-JSON answer gets one re-ask in the same session (`brain:reask`), then `invalid_output`.
- **As a child.** `createBrainWorkflows(deps)[0].workflow` is the `Workflow` a parent passes to
  `ctx.workflow('<step>', brain, [{ question }, …])`; a child that fails is `null`. The input and output above are the
  stable contract; a change to either bumps `BRAIN_VERSION`. `brain.test.ts` calls it from a fake parent.
- **Eval** (`docs/research/2026-10-29-wave7-ports.md` §brain): suite `brain`, plain cases in
  `$AGW_EVAL_DIR/brain/cases.jsonl` (`{id, input: {question}, reference: {notes: [1-2 vault paths], facts: [1-3]}}`).
  The scorer reports `valid`, `reference` (a reference note is cited; with two notes, either), `grounded` (cited and
  read; the rule needs 1 on every case) and `facts` (judged: one `decide` boolean per reference fact, regression and
  drift only); `pass` is valid, reference cited, nothing dropped. Cost is the harness's `costUsd` (median ≤ $0.01).
  The live run is `agw eval run brain --yes`, once, by the lead.

## Otel (concept N7)

`agw otel "<investigation>" [--env prod|local] [--since 2h | <from>/<to>]` investigates traces, logs and metrics in
ClickStack/HyperDX and answers in agent-gateway's `otel` shape: `status` `healthy|degraded|errors`, `environment`,
`timeRange`, `findings [{service, summary, severity, evidence?, unverified}]`, `recommendations`. Changed from the
legacy tool: `hyperdx` is typed (`{connected, reason?}`), and the answer adds `queries` (every tool call of the run:
`id`, `tool`, `target`, `argsDigest`, `ok`, `error?`, `rows?`, `chars`) and `warnings`. `--since` is a duration ending
now (`30m`, `2h`, `3d`) or an absolute `<from>/<to>` of strict ISO-8601 instants with a zone (`2026-10-27T08:00:00Z`;
dates alone, local times, impossible days and a reversed range are refused); without it the agent chooses (the run's journaled
start time is in its prompt, since the agent has no clock).

- **The agent** (`agents/otel`, route `otel.agent`: deepseek on OpenCode, `AGENT_FALLBACK`) holds three tools through the
  tool gate (§Tool gate): `hdx_tools`, `hdx_guide`, `hdx_query`, mapped to `hdx.tools|guide|query` (`otelGrant`). No
  shell, no `query.py`, and no SQL: `clickstack_sql` is outside `AGENT_READ_TOOLS` (CLI-only, see the capabilities
  README), so the builder tools are the whole path (legacy's "SQL last" step is gone, deliberately). `hdx.link` is not
  granted: no finding carries a URL.
- **The environment is the run's.** The grant carries `fixed: { env }`; the gate sets it on every call after the agent's
  own arguments, and the plugin offers no `env` argument. The agent cannot choose or switch it; `environment` in the
  answer is the input's, not the agent's.
- **Query ids are the agent's citations.** The grant's `onStart` hook numbers each `hdx_query` when the call starts (issue
  order: `q1`, `q2`, ...) and the gate sends that label back with the answer, so the agent's tool shows `query q3: ...`
  and what it cites is what was recorded. `hdx_tools` and `hdx_guide` are `t<n>` and carry no label (reading about the
  tools is not a query). The recorder is per run (no global state): `onCall` writes the query's record (`tool`,
  `target`, `argsDigest`, `ok`, `rows`, `chars`) and the `tools` step journals the list, so a replay grounds the same
  way. A retried or resumed `tools` step numbers its queries `q<attempt>.<n>` (`q2.1`), so an id never means two calls;
  calls made before a host restart are lost, the resumed agent's earlier ids match nothing, and those findings are
  flagged, never dropped. A hook that fires after the step has taken its calls is ignored (nothing re-inserted).
- **Grounding** (`assemble`, in code). A finding is grounded when its `evidence` names at least one query of this run
  that read telemetry (`clickstack_table|timeseries|search|event_*|service_health|trace_*|query_tile(s)`), worked and
  returned rows (`rows > 0`, read from the answer's `result.rows`/`data` or a `services` list; an answer cut inside a
  non-empty `data` list counts as at least one). Nothing in the evidence text itself grounds it (a trace id, a quote,
  a date or a column name would ground a hallucination). Otherwise it stays in the answer with `unverified: true` and
  the run carries a warning. Quoted excerpts in evidence add a warning too.
- **Untrusted output.** Summaries, evidence and recommendations come from an agent that read logs any observed system
  can write: the answer carries an `untrusted` note, and the calling session reads it without obeying it.
- **Status is cross-checked.** `healthy` needs a query that returned rows (see above); without one the answer is
  `degraded` with a warning (health nobody looked at, or an empty window, is not health). `degraded` or `errors` with
  no such query keeps its status and adds a warning. `hyperdx.connected` is true when any call was answered.
- **One re-ask** (`otel:reask`, the same session) when the answer is not the findings JSON, then `invalid_output`.
- **Scorer** (`scorer.ts`): `valid`, `status` (match), `facts` (judged: one `decide` boolean per reference fact),
  `grounded` (the share of findings not flagged `unverified`; only when the output has `queries`, so the legacy arm is scored by the
  same function). `pass`: valid, status matches and every fact stated. Cases are plain eval cases in
  `$AGW_EVAL_DIR/otel/cases.jsonl` (`{id, input: {investigation, env, since}, reference: {status, facts}}`);
  `scripts/eval-legacy/otel.ts` runs agent-gateway's MCP `otel` tool per case and appends scored rows to
  `<evalDir>/otel/legacy-runs.jsonl`.

## Tool gate

`src/tool-gate/` is how an agent reaches the platform without a shell. One `ToolGate` per host process, built in
`boot` and handed to workflows as `WorkflowDeps.toolGate`; research and `otel` open grants on it with their own tools (`brain` will).

- **Why a gate.** An agent reading untrusted input (web pages, logs, notes) must not hold a shell, and a shell reaches
  the host's full API secret on disk. The gate is a loopback `Bun.serve` (no idle timeout: a capability call may
  outlast Bun's 10 s cut; the grant's abort ends it) whose only verbs are the tools of a grant, only for the sessions
  of a step that is running now. Its key is per process, in `<stateDir>/gate.json` (0600), outside every location (the
  sessions deny `external_directory`); it is not the API secret and opens nothing but these tools. `close` removes a
  file only while it still holds this host's key, never another host's. The state dir is `BootOptions.stateDir`, the
  one the OpenCode server and the locations use (plugins find the gate five levels up from their location, so the two
  must agree). A gate file that cannot be written fails `open` and leaves nothing serving; the next `open` retries.
  **Expand/contract:** for this release the gate also writes `<stateDir>/research/gate.json` (same url and key,
  same 0600 and atomic rename; removed on close under the same ownership rule), because a run resumed across a deploy
  re-attaches to a session in its old content-hashed location, whose plugin reads that path. The old path is dropped in
  a later release, once no live location reads it.
- **A grant** (`gate.open({ runId, stepId, tools, fixed?, onStart?, onCall? })`, returns the close) carries its own tool set: a map of
  tool name to capability id, `fixed` arguments the gate sets on every call over the agent's own (a run's environment is
  not the agent's to pick), an optional `onStart` hook (told of each granted call before it runs; the string it returns is the call's `label`, sent
  back with the answer for the agent's tool to show, and handed to `onCall`), and an optional `onCall` hook the workflow supplies.
  **An agent holds read tools only, structurally:**
  `open` throws `tool grant refused: <tool> -> …` for an `hdx.*` capability outside `AGENT_SAFE_HDX`, and (once
  `createWorkflows` has told the gate what the registry holds, `setCapabilities`) for a capability whose CLI spec is
  `mutating` or that does not exist; nothing is opened. A call is `POST /tool/<name>` with
  `{sessionID, args}` and the bearer key; the session resolves to its step's grant by the OpenCode host's
  deterministic session ids (`isStepSession`), so a run's session never reaches another run's grant. A tool outside
  that grant is refused (`403`, `code: 'not_granted'`) before any capability or hook is reached; a session with no
  grant is `no_grant`; the other refusals are `unauthorized`, `not_found`, `too_large` (64 KiB, checked before
  anything is buffered) and `bad_request`. Every answer is `{ok, result}` or `{ok: false, error, code?}`.
- **Usage and evidence are kept apart.** The capability's usage is booked on the granting step as it is reported
  (`bindUsage(runId, stepId, addUsage)`; held until bound, returns the unbind). The `onCall` hook is told each
  call's arguments and outcome and records the workflow's own evidence; one that throws is logged (to the host logger,
  `WorkflowDeps.logger`) and the call stands. A hook runs inside the call's in-flight window. Usage booked while no
  step is bound (never bound, unbound, or after the grant ended) is logged at error with run, step, call count and cost
  when the grant ends, never dropped silently.
- **One gate.** `HostDeps` (what `createWorkflows` takes) requires the host's `toolGate`; no workflow builds its own,
  because two gates would fight over one `gate.json`.
- **Settle and close.** `settle(runId, stepId)` waits (bounded, 10 s) for the step's calls in flight, hook included,
  so a last call books its cost and writes its row before the step reads them. The close of a grant aborts what is
  still in flight, awaits it (bounded) and revokes: a later call is `no_grant`. Call it in a `finally`. A second grant
  for the same step (a resumed run) replaces the first.
- **The plugin.** An agent's tools are an OpenCode plugin in its location (`agents/<name>/plugins/agw-tools.ts`)
  that forwards each call to the gate. `agents/research/plugins/agw-tools.ts` is the template: copy it, change `id`
  and the `TOOLS` table (name, description, input schema), nothing else; the gate's address and key are found at
  `../../../../../gate.json` from the file (`<stateDir>/gate.json`), one mechanism for every agent. The plugin is not
  shared as one module: `loadAgentDefinitions` reads only `agents/<name>/plugins/**` and `compileLocation` writes only
  that into the location, so a shared file would need a loader change (and a copy step into each content-hashed
  location); the forwarding is ~15 lines, kept per agent. An agent's `agent.json` lists the same tool names as
  `allow` permissions.

## Prose (concept §10)

`prose` is agent-gateway's lint → cross-lab review → rewrite → keep gate, minus the writer: the rewrite runs in the
calling Claude Code session on Max, so the platform does the two parts that need no Opus.

| Command | Does | Cost |
|-|-|-|
| `agw prose` | lint (code) and one cross-lab review call (route `prose.review`); answers `{language, format, mediumNote, lint{findings, counts}, review{scores, notes}, visualSuggestions, reviewer, voicePath, writerBrief}` | one call on the review route (about $0.004 on legacy's recorded jobs) |
| `agw prose-gate` | the keep decision on `{original, rewrite}`: `{kept: rewrite\|original, text, reason?, lint{before, after}}`; no model, a recorded run at cost 0. An empty rewrite is valid and keeps the original; a blank original is refused | 0 |

- **Command names.** The gate is the workflow `prose-gate`, command `agw prose-gate`. The host refuses a command that is
  a prefix of another, so `agw prose gate` cannot sit beside `agw prose`; workflow ids may now carry a hyphen inside a
  segment, only between alphanumerics and before a letter (`prose-gate`; the one operation-id helper makes it `proseGate`
  for the route and the uniqueness check). The brief names `agw prose-gate`; a test asserts it is the
  registered command.
- **The brief.** `writerBrief` is legacy's writer system prompt (rules and rubric) and user prompt (lint findings, reviewer
  notes, brief, context and draft as fenced data) in one block, without the voice guide: the session reads `voicePath`
  itself. The review prompt is legacy's, word for word, and carries no voice guide (legacy's did not either).
- **Fences.** Every prompt gets a fresh 128-bit random token, never derived from the text; it is regenerated while any
  fenced body contains it. Resume determinism comes from the journal (the step result), not from rebuilding the prompt.
  The brief has a token of its own, never the one the reviewer saw, built in a journaled step (`brief`) so a resumed run
  reads it back; the reviewer's notes and the lint excerpts (quoted draft text) have `<<<` and `>>>` made inert where they
  are inlined into the brief, which also lists at most 50 findings and 30 notes and counts the rest. The returned review
  keeps the reviewer's own words. A draft can make the reviewer echo its closing marker; the regeneration loop is capped
  at 8 tries.
- **The gate** takes no `medium` (its rules do not depend on it). It judges the trimmed rewrite and answers `text`: that
  trimmed rewrite when kept, else the original as given; the caller writes `text`. It is `judgeRewrite` unchanged: same format, every fenced block, URL and wikilink target kept, none added, no
  fence left open, no lint rule with more findings. `lint.after` is the rewrite's own lint, kept or not (an empty rewrite
  is kept out with the original's).
- **Cross-lab refusal.** The writer is always the calling session (Anthropic). `prose.critique` refuses a `prose.review`
  route whose primary or fallback is not on the OpenAI chat wire (an agent harness, an Anthropic wire) or whose model names an Anthropic family (`claude`, `anthropic`, `opus`, `sonnet`, `haiku`,
  `fable`, vendor prefix included): at boot (`createCapabilities`, after `AGW_ROUTES`) and again on the route each call
  resolves. A malformed `AGW_ROUTES` stays the first call's `NOT_CONFIGURED`, as for every other capability.
- **Capability.** `prose.critique` (route `prose.review`, `agw prose-critique`) takes the review fields (non-blank text, medium,
  register, language, `draftFormat`, verdictFirst, brief, context), never a prompt: it builds the fenced reviewer prompt
  itself, so no free prompt on the paid seat is reachable over HTTP or the CLI. A `verdictFirst: false` draft gets no
  `verdict_first` score, stripped in code. The registry has no internal registration, hence the structured input.
- **Port.** `lint.ts` is `server/lib/prose-lint.ts` of agent-gateway at `15a8e6d` with `noUncheckedIndexedAccess` casts
  and its tests (`prose-lint.test.ts`); `gate.ts` is `judgeRewrite`/`worsenedRule` from `server/jobs/handlers/prose.ts`.
- **Eval.** Suite `prose` (plain cases, scorer `scorer.ts`: `valid`, `notesPresent` (reported, not part of `pass`: a clean
  draft may get none), `scoresInRange`, and against a recorded case `scoreAgreement` and `lintAgreement`, which compares
  the findings (rule and line), not their count). Rules 1 and 2 of the pre-registered set are offline:
  `bun scripts/eval-legacy/prose.ts --offline` (legacy lint and the real legacy `runProsePipeline` with canned
  adapters); `--build-cases` writes `$AGW_EVAL_DIR/prose/cases.jsonl` from the recorded params (language included).
  Rules 3 and 4 need live review calls.
- No agent definitions: the workflow runs no agent step, so it adds nothing to the run fingerprint beyond its `version`.

## Diagram (Wave 7)

`agw diagram "<brief>"` (`src/workflows/diagram/`): an Excalidraw diagram from a brief; port of agent-gateway's
`excalidraw_diagram`. One agent (`agents/diagram`, route `diagram.agent` = Haiku 5.5 EU on OpenCode, the model the legacy
tool settled on after its bench) answers `{rationale, elements[]}`, the skeleton. Code does the rest; **the host writes no
caller path**, the caller writes the file.

| Step | What |
|-|-|
| `agent` | The skeleton envelope. No tools (OpenCode's deny-by-default), no web |
| `hydrate` | Parse and check the skeleton (`skeleton.ts`: ids, unique, bound arrows point at existing ids, field types), split off the pseudo-elements, convert with `@excalidraw/excalidraw` in a short-lived child process (`hydrate.ts`) |
| `diagram:reask`, `hydrate:reask` | One re-ask in the same session with the errors (a failed check, or a skeleton the library throws on); a second failure is `invalid_output` |

Input `brief`, `mode` (`create` or `extend`), `existing` (the current `.excalidraw` as a string, extend only:
`--existing "$(cat x.excalidraw)"`; the CLI reads stdin implicitly only for a required field and has no file argument,
so `existing` is a flag). **`existing` is capped at 512 KB** (UTF-8 bytes, about 400 elements; checked on the input).
One command-line argument that large is fine on macOS and over Linux's 128 KB per-argument limit; a bigger file (embedded
images, which are most of the weight) goes in without them, `jq '.files={}' x.excalidraw`, and the caller puts the `files`
back into the result. The agent never sees `files`, nor the app state: it reads a compact view of the elements.
Output `{document, elementCount, viewport, rationale}`; `document` is the v2 file as JSON text, so
`agw diagram "..." --format plain > x.excalidraw` writes the file (the contract's `plainField` is `document`).

**Pseudo-elements** (code, `skeleton.ts`): `cameraUpdate` becomes `viewport` (the last one wins), `delete` and
`restoreCheckpoint` act on the existing document. Legacy parsed them and then only filtered its own skeleton, so a
`restoreCheckpoint` lost the old diagram. Here extend has two honest modes: a skeleton that starts with
`restoreCheckpoint` keeps the existing elements (minus the deleted ones, their labels and arrows) and adds the new ones,
whose arrows may bind to old boxes; any other skeleton replaces the diagram. Rejected for the one re-ask, with the error
text: `restoreCheckpoint` in create mode, `delete` without `restoreCheckpoint`, a `delete` id the existing diagram does not
have, and a new element that reuses the id of an element it keeps (reject, not drop the old copy, so the agent decides); a deleted
id may be drawn again (delete and redraw). What hangs off a deleted element goes too, transitively (its label, an arrow
attached to it, that arrow's label), and survivors' `boundElements` lose the entries of anything deleted. To let a new arrow bind to an old box
the library needs the box in the skeleton it converts, and converting a finished arrow again drops its bindings;
so the new skeleton is converted with bare stand-ins for the boxes it binds to, and the real elements are swapped back in
(`document.ts` `bindingStubs`, `mergeExtension`). In extend mode the agent reads a compact view of the old diagram
(one JSON line per element in skeleton vocabulary), not the hydrated file.

### Hydration decision

Three options, one spike each in a scratch directory (not committed), 5 elements incl. a German label and an arrow
label, compared with a headless Chrome that had the pinned bundle and the Excalifont file loaded (the app's own widths):

| | Text widths vs the app | Cost per call | Runtime dependency |
|-|-|-|-|
| (c) legacy: Chrome + `import ... from "https://esm.sh/..."` | **9-23 % too narrow** (180.52 against 198.38 px for one label): its widths equal a canvas that has no Excalifont, i.e. a fallback font | Chrome start and a CDN fetch (the legacy bench saw a hydrate timeout, 1 of 2 runs on its flash arm) | CDN at runtime: supply chain; Chrome on the host |
| (b) Chrome + a local `bun build` of the pinned package (7.8 MB) + the font awaited | exact (this is the reference) | Chrome start ≈ 1 s; CDP or `--dump-dom`; a PID to kill | Chrome on the host |
| **(a) Bun child process + DOM shim + `@napi-rs/canvas` registering the package's own woff2 files** | **identical to (b)**: 144.86, 148.02, 51.06, 108.20, 150.76 px, including the mid-word wrap of "Größenänderung" in a 120 px box | 295-340 ms per call (below) | pinned npm packages only |

**(a) wins**: same widths as the app, no network, no browser. It first ran in a Bun `Worker`; review moved it into a
child process: the canvas is native code (a crash or an OOM kill must not take the host with it), and its font registry
is process-wide, so a worker registers the fonts again on every call and the host's memory only grows. One `bun
hydrate-child.ts` per call (stdin in, one JSON reply out), run from its package directory (no `.env` or `bunfig.toml` of
the host's cwd) with `PATH`, `HOME`, `TMPDIR` and its own variables only (no secrets), killed by its PID on timeout (30 s)
or abort, a silent exit seen at once (the pipes close), at most 2 alive at once (`MAX_CONCURRENT_HYDRATIONS`, the rest queue
for at most 60 s), stdout capped at 32 MB and stderr read but only its last 4 KB kept. It ends itself too (`watchdog.ts`):
at the host's timeout plus 5 s, and when its parent pid changes, so a host crash or a deploy leaves no orphan. Who owns
which failure: only a conversion error is an `{ok: false}` reply (the agent's skeleton, so the one re-ask); a child that
cannot run (unreadable input, the package, the shim, the fonts or the canvas failing, a crash, an OOM kill, a flood) exits
non-zero and is an `InfraError`, which the runtime does not retry as a step but takes the run back for, and which never
reaches the agent; a timeout or an over-long queue wait is a `timeout` failure that is not retried (the same skeleton would
hang again). A native crash on a Linux host whose `core_pattern` is apport (GitHub's runners) is only reaped after the kernel has written the core dump, 12-17 s, still bounded by the 30 s timeout; the tests use SIGKILL (the OOM killer's signal) for "killed" for that reason. Per call, 12 boxes and 11
arrows, 8 sequential calls, load 8: **Worker** 304-666 ms for the first, then 66-77 ms (median 69-71): warm only because
the library and the fonts stay in the host; **child process** 295-340 ms for every call (median 298-326), 4 calls through
the cap of 2 in 670-720 ms. Hydration is one journaled `hydrate` step. Dependencies, exact: `@excalidraw/excalidraw` 0.18.0 (legacy's version),
`@napi-rs/canvas` 1.0.13 (a prebuilt native module per platform, optional dependencies in the lockfile), `react`
and `react-dom` 19.3.1 (the library's peers, loaded but never rendered).

Traps found on the way, all handled in `hydrate.ts` / `dom-shim.ts`:
- The library multiplies every measured width by 10 when it thinks it runs under a test runner (`MODE === "test"`,
  which `bun test` sets); the child is started with `NODE_ENV=production` and nothing else in its environment.
- The shim lives in the child's global scope; importing it into the host process would give every other workflow a
  `window` and a `document`.
- A font family that registers no file throws (`registerFonts`): a canvas without the font measures in a fallback and
  every label of that family would come out the wrong width without a sign.
- A family ships as unicode-range subsets, and a canvas font string takes one typeface per name: each subset is
  registered under its own alias and the library's font string is rewritten to the list (per-glyph fallback). `Helvetica`
  maps to Liberation Sans (metric-compatible). Xiaolai (CJK, 209 files) is not registered: CJK falls back to a system font.
- Legacy widths come from a fallback font, so its labels are narrower than the app's: a legacy diagram opened in
  Excalidraw can overflow where this one fits.

### Eval

Suite `diagram` (`agw eval run diagram`), plain cases in `$AGW_EVAL_DIR/diagram/cases.jsonl` (private): the legacy bench
brief, an architecture, a flow, an extend on an existing drawing, German labels, a dense one. The scorer
(`scorer.ts`, `metrics.ts`) follows the pre-registered rule in `docs/research/2026-10-29-wave7-ports.md` §diagram:
`valid` (a v2 document), `elementCount`, `boundArrowShare` (both ends bound to existing ids), `overlaps` (crossing
shapes; a shape holding another entirely is a container, not an overlap), `textOverflow` (a label wider than its
container); a case's reference only bounds the element count (`inRange`). An invalid run scores `valid: 0` and nothing
else, so a failure counts in the valid rate and never pulls another mean down; the other means are over valid runs, for
both arms. The legacy arm is `bun scripts/eval-legacy/diagram.ts [--runs 2]`: it submits the same cases to agent-gateway's
job API (a scratch directory per run; an extend job that leaves the seeded file byte-identical counts as invalid), scores
the written files with the same metrics and writes a report next to the cases. The job view carries no cost, so the cost
of a run is joined from the usage tracker's `agent-gateway-sessions.jsonl`: on the job id where a row names it, else the `excalidraw-diagram` sessions that started
between the run's submit and the poll that saw it finish (summed when a job retried; runs are sequential so windows do not
overlap; a window join could count another caller's diagram job started in the same window, so the summary flags it as `foreignSessionRisk` with the count of runs per join kind, and `multiSessionRuns` counts runs with more than one session: run the arm on an idle gateway). A run with no such session, or whose session two runs claim, has `costUsd: null` and `costJoin` names why; the
summary reports `costJoined` as `n/total`. `--join <report.json>` redoes only the join once the tracker has caught up.

## Process

`main.ts` binds the port first and only then opens the runtime, so a taken port (a deploy overlap) fails before any run is claimed; every resource registers its closer as it is created, and a failure anywhere in the start runs the same teardown as a signal. It builds the runtime with `platformMiddleware` (purpose, fingerprint, record, telemetry) followed by the wallet gate and the runaway cap, opens it (migrates the journal, starts the recovery tick), starts the outbox flush tick (30 s, when Argo is configured) and serves. SIGTERM/SIGINT: stop accepting (held waits get 5 s to answer), `runtime.close()`, the cap's pool, `platform.close()` (flushes telemetry), exit 0. A second signal exits at once, and an unref'd timer (45 s, past the runtime's body grace) exits regardless if a close hangs. An uncaught exception shuts down the same way (exit 1); an unhandled rejection is logged and the process keeps serving. Until the runtime is open, `/health` is degraded and every other route is `503`. Runs stay `running` and the next process resumes them (concept §3: deploys need no drain); `test/main.test.ts` kills a process mid-run and watches a second one finish it.

The OpenCode `AgentHost` is wired in `boot.ts` (`lazyOpenCodeHost`): an `OpenCodeServer` and an `OpenCodeHost` with an empty agent list (no agent definitions exist yet). Both are built on the first agent step (or on the first friction-counter read for a run that has agent steps, e.g. one resumed after a restart), not at boot, so a host without agent workflows never spawns or probes `opencode`; a failed start is not cached and the next step retries. Shutdown closes the host and stops supervising the server, which keeps running for the next process (opencode-host README). `BootOptions.agentHost` replaces it in tests.

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

**An untracked route override** (which model and spend every run gets, e.g. an eval of another model): if `~/.config/agw/routes.json` exists, `launch.sh` exports its content as `AGW_ROUTES` (one JSON object of route id to partial route spec, the shape in the routes README). The file must be a regular file (a symlink or a directory is refused), owned by the user running the host and not group- or world-writable (mode 0644 is fine, 0664 is not). It is read once into a variable; that string is validated with `validateOverrides` from `@agent-workflows/routes` (run with the release's `bun`, the same check `boot` makes), and exactly that string is exported. A failure exits 78 with the validator's message, which names the file, the route id and the problem and never an override value or the parser's own message (it quotes the input); it can name route ids and keys taken from the file. The validator's stderr is dropped, so bun's own output never passes for a message about the file. 78 retries at the plist's `ThrottleInterval`, not in a tight loop, but a deploy whose new release refuses the file **is rolled back** to the previous release, which does not read `routes.json`: the deploy reports a healthy rollback while the override is silently off. Fix the file before the deploy. **Precedence:** when the file exists it replaces an `AGW_ROUTES` already in the environment; an empty file is refused; absent file, the environment is untouched and nothing changes. On start one line names the file and the route ids it touches (validated table ids only, no models). `boot` calls `validateOverrides` again before anything is opened, so a bad `AGW_ROUTES` from any source refuses the start the same way instead of failing the first run that resolves the route. A route override moves the run fingerprint of every workflow that uses the route (`routeFingerprint` covers the resolved entry), so runs before and after a change are not comparable as one series. Removing the file and redeploying (or restarting the LaunchAgent) restores the table. `launch-routes.test.ts` runs the block with a fake HOME.

`make verify` (`scripts/verify.sh`) exits 0 only if `/health` is ok, the deployed sha equals `origin/master` and is what the host reports, `AGW_PURPOSE=verify agw smoke ping` exits 0 with a `title`, and that run's row in `agw.runs` is `done` with a trace id and priced usage, and a direct `AGW_PURPOSE=verify agw llm title …` leaves a `cap.llm.title` row `done` with priced usage. It prints both run ids and, informationally, the friction job's state (never a failure).

## Friction job

`src/friction/`, started by `boot` when `config.friction.enabled` (set by `loadConfig`, so on in production and off for
the literal configs tests pass). Daily, first run ten minutes after boot:

1. **Follow-ups.** A top-level run that ended `done` with `purpose = 'prod'` (a user call: the HTTP door's default;
   `build`, `verify` and `eval` are not asks) gets `friction.followUps = 1` when the same workflow was started again
   as a top-level `prod` run with the same `cwd` and `scope` input, created within `followUpMinutes` (fractions of a
   minute work) after it finished. The later run must not be cancelled or refused (`admission_refused`,
   `invalid_input`); a failed run that is run again is a retry, not a follow-up. Workflows whose input has no `cwd`
   have no follow-up signal. Idempotent.
2. **Rate.** Per workflow over the last `windowDays` of finished **top-level user (`prod`)** runs with a delivered
   record: the share with any counter at or above its limit. Build, verify and eval traffic is not counted, so it
   neither dilutes nor inflates a rate. Default limits: `toolErrors` 5, `repeatToolCalls` 5, `nudges` 2, `schemaReasks`
   1, `overBudget` 1, `followUps` 1; `null` switches one off (printed `off` in an issue). Each is reachable as the
   first reason: one nudge alone is not friction (it fires at the 3rd identical call), two nudges without a 5-fold
   repeat mean two different calls repeated 3 times; tests pin every limit alone.
3. **Breach** = at least `minRuns` runs and a rate of at least `rate`. The job keeps its own record of what it filed in
   `friction_issues` (migration `0006_friction_issues.sql`: `repo`, `workflow`, `number`, `url`, `filed_at`,
   `closed_at`). For a breaching workflow:
   - the latest record is closed: only runs that **finished after `closed_at`** are looked at (the same runs never file
     the same breach twice); nothing breaches, nothing happens;
   - otherwise ask GitHub about that one issue **by number**, closed records included, since an issue can be reopened:
     open means skip (a reopened one gets its `closed_at` cleared; nothing is filed, commented or edited); closed
     means store its `closedAt` and look only at runs after it; **deleted** (GitHub's own "Could not resolve to an
     issue" answer, nothing else) means the evidence starts at `filed_at`. Any other failure (no `gh`, an unreachable
     repository, HTTP 404 on access) is an error: the workflow is skipped this tick and nothing is concluded;
   - no record, or evidence that breaches: file it (title `Friction: <workflow> above threshold`). Filing is not atomic
     with recording, so an **intent row** (no number) is written first and completed after `gh issue create`. A later
     tick that finds an intent without a number searches for the issue by its exact title (created since the intent)
     before it files anything: found completes the row, not found drops the intent. An intent younger than 5 minutes
     belongs to a tick that is still filing and is left alone, and a partial unique index (one unfinished intent per
     workflow) makes a racing second insert fail, which the job reads as "someone else is filing" and skips. A crash after the POST, or an
     unreadable URL, therefore never files twice.
   No scan of the repository's issues: no 500-issue limit, no search-index lag, nothing a human can edit to confuse it.
   The `gh` CLI is a port (`GhPort`: `issueState`, `findIssuesByTitle`, `createIssue`); tests pass a fake.
   **Before the rates**, the job recounts runs of the window whose friction document is `incomplete` (fewest attempts
   first, newest first among equals, at most 20 per tick; a run still incomplete after 3 recounts is marked `'gave-up'`
   and no longer returned, through the middleware's `frictionRecounter` and the OpenCode host), so an agent-server restart
   delays a count and does not erase one. The rates read only the counters of the document (`friction - 'sessions' -
   'events'`), not its per-session detail.
4. **Shutdown never waits for a job.** `close()` aborts the signal that the database and `gh` calls carry (the `gh`
   process is killed) and waits at most 10 s; `boot` then ends the pool with its own short cap. An in-flight query ends
   at its own statement timeout.

**State of the job.** `boot` returns `friction: { enabled, state, reason? }`. `state` is `on`; `off` (the flag, or a literal test
config); `misconfigured` (a bad `AGW_FRICTION_CONFIG` or `AGW_FRICTION_REPO`: the host stays up with the job off,
follow-up marking included); `no-repo` (enabled, but `AGW_FRICTION_REPO` is unset: counters, follow-ups and recounts run,
no issue is ever filed, which is not the same as working). `/health` serves `{ enabled, state }` only: it is
unauthenticated, so the reason, which can name a setting, stays in the process and its boot log. `make verify` prints the
state, never fails on it.

The issue holds counts, rates, limits and at most 20 run ids, and nothing else. The job reads only the `friction`
document, workflow id and run id; this repository is public and runs review private repositories, so no input,
output, path, repository name, prompt or transcript is ever selected. `friction.test.ts` asserts it with a recognisable
`cwd`, prompt, output and error in the run rows.

**Deploy note:** `AGW_FRICTION_REPO` must be set in the host's environment for issues to open; unset, nothing is filed. Point it at a repository whose issues may show workflow ids, run ids and friction rates (this repository is public, which is what the brief chose). One host process runs the job; two overlapping processes during a deploy could both file an issue for the same breach (the record is a read, not a lock).

## Token effect / cache effect

The research agent: its `AGENTS.md` and its four tool schemas are the cached prefix (identical across runs); the
question, depth directive, background and a follow-up's earlier report are the task message. The tool gate adds no
model-visible text beyond each tool's JSON answer (page text up to `maxChars`, 20k by default), which is where a
research session's tokens go; DeepSeek's prefix cache holds because the session's history is never edited (cache
reads recorded and priced at the route's rate).

The learnings read-back adds tokens only where a fact is active: the fenced block is appended **after the task message**, never
into `AGENTS.md`, so the agent's cached prefix (system prompt, skills) is untouched; the block costs its own tokens
(at most 25 facts of at most 400 characters, in practice a few hundred) on every step of that agent, and a changed fact set
changes the message tail only. Activating or retiring a fact changes the run fingerprint (one new fingerprint group, no
cold prompt cache: the prefix is unchanged). The retrospective is its own spend: one Haiku-class agent step per workflow and week
over at most ~30k input tokens of sampled records, no tools, plus at most one JSON retry; nothing runs when a workflow had no runs.
Otherwise none of its own beyond the OpenCode adapter's repeat-tool nudge (opencode-host README). The host adds no model-visible text and no tokens (the default scorers and drift are deterministic; `agw eval run --yes` costs what its case runs cost, tagged `purpose: eval`, and says so before it runs): workflow input goes to the runtime unchanged and capability calls go to the route table as the capabilities README describes. Held requests poll the journal, not a model. Two things to know: `agw schema <workflow>` now prints the workflow's output schema too (about a screenful for `review`), which a caller reading it spends context on once; a deploy that changes an `AGENTS.md`, skill, route or the OpenCode version changes the run fingerprint and costs one cold prompt cache (middleware README), and a capability called straight over HTTP (`agw llm title`) is a `cap.<id>` run of its own, recorded and in Argo like any run; one inside a workflow step counts on that step.

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
| `prose.test.ts` | `prose` on a fake registry: lint and review shape, the fenced review prompt and writer brief (no voice text inlined), identical prompts for identical input, `verdictFirst: false`, a missing voice guide fails before any call, German draft; the keep gate (faithful kept; lost URL/fence, added fence/URL, open fence, worsened rule, format switch, empty kept as original); the scorer; `rewrite gate` over HTTP |
| `prose-lint.test.ts` | agent-gateway's lint tests, ported: every rule fires and stays silent, German with English terms yields no findings, the fence parser, content-integrity helpers |
| `smoke.test.ts` | `smoke.ping` end to end behind the platform middleware: usage on the step, the row in Argo |
| `capability-runs.test.ts` | a direct `llm.title` call as a `cap.llm.title` run: same body and errors as without a run, usage and the Argo row, invalid input starts nothing, no nested run under `smoke.ping`, idempotent replay (success and failure), an unkeyed abort cancels the run, a keyed one does not (alone or as a retry of a running key), the journaled error wire format, opaque and refusal failures |
| `scorers.test.ts` | the review and check scorers on fixed fixtures: structure without a reference (failed angles, salvage, balance, invalid output), recall / precision / outcome against a reference |
| `eval.test.ts` | `eval.run` on a fake agent host with two check cases on a real git repo (plan without `--yes`, purpose `eval`, scores and fingerprint recorded, clones removed, bad ids and args refused), `eval.compare` with equal fingerprints by args and on synthetic runs with known deltas, drift scoring each sampled run once across two jobs |
| `eval-cli.test.ts` | the document as the CLI reads it: `agw eval run` and `agw eval compare` are commands with their flags, none skipped |
| `eval-resume.test.ts` | a resumed `eval.run` adopts its case runs (no new clone, a scored case not scored again, the running one's clone kept across the shutdown and removed by the adopting process); a cancelled one cancels its running case, starts no further case and removes a clone only after its run ended (a slowed cancel proves the order); an adopt-path failure and a scorer error are per-case errors outside the pass rate |
| `brain.test.ts` | the brain workflow on `FakeAgentHost` with the real `brain.*` capabilities on a temp vault behind the gate: grounding (an unread, search-only, refused or invented path dropped), ok / partial / notfound, the ledger rows, `$0` usage on the `tools` step, the re-ask, a parent calling it as a child, the agent's grant (agent.json, plugin, `BRAIN_TOOLS` agree on two tools), the scorer and the suite reader |
| `brain-opencode.test.ts` | the brain agent on the real `opencode` with a scripted model (skipped without the binary): offered exactly its two tools plus the denied file tools, the plugin reaches the gate, a refused read reaches the model, `read` and `grep` of the vault are denied |
| `main.test.ts` | config, `lazyOpenCodeHost` (nothing built before the first agent step, a failed start retried), `boot` (a taken port fails before the runtime opens), the process entry: refusals, SIGTERM leaves a run `running` with exit 0, a second process resumes it |
| `friction.test.ts` | the threshold job against Postgres rows: breach, no breach (rate, minimum, build/verify/eval traffic, window, cancelled, unrecorded), top-level only, every default limit alone, `off` limits, the issue record (open: skip by number; closed: only newer runs; reopened; deleted; a `gh` error; intent rows after a crash), a failing `gh`, incomplete runs recounted before the rates (capped), the timer and a bounded `close()`; follow-up detection incl. fractional minutes; config parsing and the running host's `friction` state in `boot` and `/health`; the money-rule prefixes against the real `limits` errors; the lazy host's counters source |
| `launch-override.test.ts` | the `launch.sh` IU override block in `/bin/sh` with a fake HOME: absent file, both names override, other lines warned by name only, CR and quote styles, refused with 78: a mode other than 0600, a missing name, an empty key, an unknown label |
| `launch-routes.test.ts` | the `launch.sh` route override block in `/bin/sh` with a fake HOME: absent file leaves the environment, a valid file is exported and logged by route id only, the file wins over the environment, refused with 78 (messages carry no content): malformed JSON, an unknown route id, a bad spec, a non-object or empty file, a group- or world-writable file, a symlink, a directory, a file owned by another user |
| `lifecycle.test.ts` | signals, the hard-exit backstop, second signal, uncaught exception vs unhandled rejection |
