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
| `AGW_MACHINE` | yes | the `machine` attribute of every usage row. The deploy sets it |
| `AGW_PG_URL` | yes | the journal database (`agent_workflows`) |
| `AGW_PG_SCHEMA` | no | journal schema, default `agw` |
| `AGW_PORT` | no | default `7791` |
| `AGW_DOOR_CALLERS_FILE` | yes (the deploy sets it) | the doors' caller tokens, `name=token` lines at mode 0600 (default `~/.agent-workflows/data/door-tokens`): the file the audio process reads, one for both doors. `main.ts` reads it before booting and refuses to start on a missing, wider-mode or malformed file, naming the file and the line, never a token |
| `AGW_VERSION` | no | reported by `/health` and `info.version`; default `dev`. A change changes the contract sha |
| `AGW_AGENTS_DIR`, `AGW_OPENCODE_BIN` | no | fingerprint source: compiled agent definitions and the `opencode` binary. Read only for workflows that reference agents. The fingerprint covers each agent's `AGENTS.md`, `agent.json` (route, permissions) and skills, plus the host's base session policy (`hostFingerprintSource`) |
| `IU_API_KEY`, `IU_BASE_URL` | for capabilities | read per call by the capabilities |
| `TAVILY_API_KEY`, `CONTEXT7_API_KEY` | for `web.*` | read per call: Tavily is `web.search`'s fallback and `web.fetch`'s Extract step, Context7 is `web.docs` (unset: it answers `NOT_CONFIGURED`). Optional `SEARCH_PROVIDER` (`tavily` skips Sonar), `SONAR_MODEL`, `GITHUB_TOKEN` |
| `HYPERDX_PROD_ACCESS_KEY`, `HYPERDX_DOMAIN` | for `hdx.*` on prod | read per call: the prod bearer key and the domain `https://hyperdx.<domain>` is built from (unset: that call is `NOT_CONFIGURED`, the rest of the host unaffected; a `.env.tpl` ref missing from the secrets cache stops the whole host, `launch.sh` exit 78). Optional `HYPERDX_PROD_URL` (replaces the composed base; https, or http on loopback only), `HYPERDX_LOCAL_ACCESS_KEY` (else `~/.config/hyperdx/local.env`), `HYPERDX_LOCAL_URL` (default `http://localhost:7707`) |
| `IU_KEY_ID` | no | non-secret label of the IU key above: `personal` (default; unset or empty) or `athena-team`; any other value refuses to start. Stamped on every run this process admits and written as `api_key` on its `usage.records` rows (`billing=api_key`); also forwarded to OpenCode servers, which do not read it |
| `AGW_RETRO_WEEKLY` | no | the weekly retrospective schedule; on unless `0`, `off` or `false` |
| `AGW_RETRO_FILE_ISSUES`, `AGW_RETRO_ISSUE_REPO` | no | scheduled retrospectives file their proposals as GitHub issues in `owner/name`. Off by default; the repository is required when it is on (the process refuses to start otherwise). `gh` authenticates from the host's environment (`GH_TOKEN`) |
| `USAGE_PG_URL` | yes (built by `scripts/launch.sh`) | the usage database (schema `usage` in `shared`, role `usage`): the middleware outbox writes `usage.records` and `usage.sessions` there. `scripts/launch.sh` builds it from `USAGE_PG_PASSWORD` (`.env.tpl`, `op://mini/vps-dev/SHARED_USAGE_DB_PASSWORD`, resolved by `secrets-run`), URL-encoded like `AGW_PG_URL`, and drops the raw password; the ref is a required deploy secret (an unresolved `USAGE_PG_PASSWORD` makes `launch.sh` exit 78, the process never starts), and only an embedder that builds the platform without it runs with the outbox off. Never logged, and scrubbed from `check` spawns |
| `ARGO_URL`, `ARGO_API_SECRET` | no | Argo: the agents overview push and the podcast's Slack notice (not usage) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` (or `…_TRACES_ENDPOINT`), `OTEL_EXPORTER_OTLP_HEADERS` | no | span export is off without an endpoint |
| `AGW_FRICTION_ISSUES` | no | the daily friction job (below): on unless `off`/`0`/`false`/`no` |
| `AGW_FRICTION_REPO` | for issues | `owner/name` the job opens issues in. Unset: the job still marks follow-ups but opens nothing (it says so in the log) |
| `AGW_FRICTION_CONFIG` | no | JSON overriding any of `windowDays` (7), `minRuns` (10), `rate` (0.25), `followUpMinutes` (10, fractions allowed), `limits` (`null` switches a counter off). A bad value of this or of `AGW_FRICTION_REPO` disables the job and says why (stderr, `RunningHost.friction`); it never stops the host |
| `AGW_ROUTES`, `AGW_WALLET_*` | no | route overrides (routes README), wallet gate (limits README) |
| `AGW_DRIFT_RATE`, `AGW_DRIFT_INTERVAL_S` | no | drift: the share of finished production runs scored after the fact (default `0.1`, `0` turns it off) and the tick (default 300 s); a bad value refuses to start |
| `AGW_EVAL_DIR`, `AGW_EVAL_HOME` | no | `agw eval run`: where `<workflow>/cases.jsonl` live (default `~/.local/share/agent-workflows/eval`) and the root a case's `repo` is relative to (default `$HOME`) |
| `AGW_VOICE_PATH` | no | the voice guide `prose` checks and names in its brief; default the brain vault's `voice.md`. Unreadable or empty: `prose` fails before any model call, naming this variable |
| `AGW_ARGO_PUSH`, `AGW_AGENT_STALE_HOURS`, `AGW_HERDR_BIN`, `AGW_CLAUDE_BIN`, `AGW_CLAUDE_ACCOUNT_BIN`, `AGW_CLAUDE_LOG_DIR` | no | the agents overview (§Host reads, `src/workflows/overview/README.md` §Environment): the Argo timer switch (`ARGO_URL` and `ARGO_API_SECRET` above are its target) and where the collectors read |
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
| `GET /routes` | bearer | `agw routes`: the route table as this process resolves it (`AGW_ROUTES` applied, from the environment `boot` validated): `{ routes: { <id>: entry }, table }`, `table` being what `--format plain` prints. Unjournaled (no run, no LLM). Served by the process that serves capabilities only (`HostOptions.routesEnv`): the CLI refuses a command two processes declare, so the audio process does not declare it. An override that no longer resolves is `500 ROUTE_OVERRIDE_INVALID` with the override error's message |

- **Trust model.** One trust domain: the API secret opens everything, and its holder may start, read and cancel any run. `x-agw-purpose` is a label for the run record, not a scope or a permission.
- **Auth.** `Authorization: Bearer <AGW_API_SECRET>` on everything but `/health`; missing or wrong is `401 UNAUTHORIZED`. Every key is sha256-hashed and compared with `crypto.timingSafeEqual`, whichever matched first. It runs before the contract check and before any handler, so an unauthenticated request starts nothing.
- **Door tokens are not API credentials.** Each process serves a door (the audio process the OpenAI-compatible speech and transcription door, this one the image door, §Image door) and its whole API on one port; the door-tokens file (`name=token`: studio, hermes, argo, …) is for the doors. The API has one credential, the API secret: a door token is `401` on every non-door path (start a workflow, `run get`, `/openapi.json`) on both processes while the door still accepts it (`packages/audio/test/door-api-isolation.test.ts`, `test/caller.test.ts`, `test/image-door.test.ts`). The caller-name rule (`CALLER_PATTERN`) and `PLATFORM_CALLER` live in `src/auth.ts`, the token-file parser and reader (`parseDoorTokens`, `readDoorTokens`) and the caller matching (`callerAuth`) in `src/door-tokens.ts`; both are the audio process's too (`@agent-workflows/host/auth`, `@agent-workflows/host/door-tokens`).
- **Caller attribution.** Every run carries `runs.caller`, `runs.project` and `runs.workspace` (migration `0011`; nullable, expand only, child runs inherit the parent's, no reader depends on them, so a rollback release runs unchanged):

  | Admitted by | `caller` | `project`, `workspace` |
  |-|-|-|
  | the API secret (this API) | `agw`, or `x-agw-caller` (`[a-z][a-z0-9-]{0,31}`) | `x-agw-project` (a bare name `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, never a path), `x-agw-workspace` (`work` or `private`) |
  | a door token (audio door, image door) | the token's name, from the credential, never a header | none |
  | nothing: the host started it (retrospective, eval harness, judge, recovery) | null | null |

  A malformed header is `400 BAD_REQUEST` and starts nothing. The door replaces whatever `x-agw-*` caller headers arrived with the validated ones before a handler runs; the audio door sets `x-agw-caller` from its own credential. The headers are not in the OpenAPI document (a label must not move the contract sha); the CLI sends them (CLI README). Accepted as the contract: the secret's holder may self-declare any sub-caller (Hermes runs with the secret and `AGW_CALLER=hermes`), an idempotent replay keeps the attribution of the first start, and a usage row names the caller in `lane_detail`.
- **Usage attribution.** `project_raw` = the run's project (NULL when it has none), `repo` = that project when it is a plain SourceRoot slug and the run is not `work`; `lane_detail.caller` and `raw.caller` = the caller, where a run no door admitted reads `eval` for purposes `eval` and `drift` and `host` otherwise. `workspace` is written only when the run declared it; the CLI declares `work` for a working copy under `IuRoot`, which names alone cannot show. Mapping: middleware README §Usage outbox.
- **Errors.** One body everywhere: `{ defined, code, status, message, data? }`. Codes: `BAD_REQUEST` 400, `UNAUTHORIZED` 401, `NOT_FOUND` 404, `CONFLICT` 409, `CONTRACT_MISMATCH` 412, the capability codes, `INTERNAL_SERVER_ERROR` 500. Input validation failures are `BAD_REQUEST`. `defined` is `true` only for errors a procedure declares (the capability codes, `NOT_FOUND`, `CONFLICT`); the host's own envelopes (`UNAUTHORIZED`, `CONTRACT_MISMATCH`, `SERVICE_UNAVAILABLE`) and the transport-level ones (`INTERNAL_SERVER_ERROR`, an unmatched route) are `false`.
- **Contract.** `info['x-contract-sha']` is the sha256 hex of the canonical JSON (keys sorted recursively, no whitespace) of the document without that field. A request header `x-agw-contract: <sha>` that differs is `412 CONTRACT_MISMATCH` with `data: { server, client }`; no header, no check. `/openapi.json` is never checked, so a stale client can always fetch the new document. The CLI sends the header on every call, so a stale cache is a 412 it refreshes from, and it fetches the document before printing any `--help` (which sends no call).
- **Workflows.** Headers: `Prefer: wait=<seconds>` (absent is 0, at most 240; Bun's `idleTimeout` ceiling is 255 s, verified against Bun's docs and `Bun.serve`, which rejects more), `Idempotency-Key` (a repeat with the same body returns the same run, scoped to the workflow; a different body is `409 CONFLICT` naming the key, with `data: { runId }` of the run that stands), `x-agw-purpose` (default `prod`), `traceparent` (joins the caller's trace). A body-less (or empty) `POST` starts a workflow whose input is all defaults; a body sent without a content type is read as JSON and validated like any other.
- **Capabilities are runs.** A capability called over HTTP (`agw llm title`) runs as the one-step workflow `cap.<id>` (step `call`; version: a hash of the capability's schemas and handler), so journal, run record, purpose, fingerprint, telemetry, the usage outbox and the limits apply as to any run (concept N6). `src/capability-runs.ts` builds the workflows (`createCapabilityWorkflows`, called once in `boot`, which hands the same map to the runtime and to `createHost`; they are not operations: no `/workflows/cap/…` route, no command) and the handler: input is validated first (a `400` starts nothing), then the run starts with the request's `x-agw-purpose`, `Idempotency-Key` (a repeat answers with the first run's output or error, no second model call) and `traceparent`; the request waits for it without a deadline and answers with its output or the capability's own typed error, the same body and status as a call without a run. The step journals the error as `CODE: message`, a newline and one JSON line `{"agwCapabilityError":1,"code","status","data"}`; only that last line is parsed, so a replay or another process rebuilds the same answer. A refused run (wallet gate, runaway cap: the kinds a workflow route reports in its failed run state) is `503 SERVICE_UNAVAILABLE` with the refusal's reason and `data: { runId, kind }`; any other failure is an opaque `500 run <id> failed`, its detail logged. The run id comes back in the `agw-run-id` header, on errors too. A client that goes away mid-run cancels the run only without an `Idempotency-Key` (that request alone created it); a keyed run finishes, and the retry with the key gets its result. A host shutdown leaves the run to recovery. The input is parsed again by the workflow and by the capability's `call`; no capability input uses a transform, so the parses agree. In-process calls (`registry.call` inside a step) stay plain calls whose usage belongs to the step.
- **Strict inputs.** Workflow inputs reject unknown keys like capability inputs (`400 BAD_REQUEST`, `additionalProperties: false` in the document), so a typo fails loudly instead of running on defaults.
- **Run state.** `{ runId, workflowId, status, output?, error?: { kind, message }, cost?, unpricedCalls?, costPending?, recordFailed? }` (the document types `output` with the workflow's own output schema on its start route, written in by `withOutputType` so `agw schema <workflow>` prints it, with refs inlined and its own description kept; a response shape or output schema it cannot write (a `$ref`/`$defs`, a cycle) fails the start, since the document is built at boot; the run operations serve any workflow and leave it open, and the host does not validate a stored output against it, so an older run still reads): `200` when `done|failed|cancelled`, `202` while `pending|running` (the OpenAPI document lists both). A failed run is a `200` with `status: 'failed'`; the failure is the run's state, not the request's. A done run whose output is `null` keeps `output: null`; a run without output has no `output` key. **The run's cost** is on an ended run's answer, as one of three things, read from `post_hooks_at` and `post_hooks_failed_at` (migration 0009; set only when the runtime gave up on the hooks after `maxPostHookAttempts`, null on every older row, whose hooks were delivered): `cost` (USD, `null` when the run priced nothing) and `unpricedCalls` (above 0 the cost is a lower bound) once the post hooks delivered; `costPending: true` while they have not; `recordFailed: true` when the runtime gave up on them, so the record may be missing and no cost is given. The cost is the run's own steps: a fan-out child is a run with its own record, and its parent's sums do not include it. `Runtime.finish` commits the terminal status first and `runPost` writes the record after it, so a wait that sees its run turn terminal (the start route with `Prefer: wait`, `run wait`) holds for the hooks up to 5 s (`RECORD_WAIT_MS`) beyond its own wait, restarting the poll backoff, retrying failed reads until that bound, and answering `costPending` when it passes. Only a wait that observed the transition holds, and no clock is compared: `run status`, `run cancel`, the capability routes (`/llm/title` and friends) and a wait that finds the run already ended answer the record as it is, so a run that ends before the first read of its start call answers `costPending` and `run status` later gives the cost. Running runs carry none of the fields. A held wait retries a failed journal read on the poll backoff, logging each, until the deadline or 5 failures in a row, then answers with the error. Unknown run: `404 NOT_FOUND`. Cancel of an ended run is `200` with its state; cancel of a running run waits (`Prefer: wait`, else up to 10 s) for the run to end, `202` if it has not by then.
- **`x-cli`.** Capabilities carry `kind: 'capability'`; workflows `{ command: id.split('.'), kind: 'workflow', mutating: false, defaultFormat: 'json', resume: { command: ['run','wait'], positional: ['runId'] } }`; run ops `kind: 'run'`, positional `['runId']`. A workflow declares `positional`, `stdin`, `mutating` in its `HostWorkflow.cli`.
- **Reserved flags.** The CLI's own `--format`, `--commit`, `--idempotency-key` and `--help` always win, so no capability or workflow input may have a property named `format`, `commit`, `idempotencyKey`, `idempotency-key` or `help`; the host refuses to start otherwise (`llm.summarize` takes `style`).
- **Collisions.** Two operations on the same command, or one command extending another (`agw run` next to `agw run wait`), the same operation id or `METHOD path` throw at `createHost`. `workflows`, `runs` and `routes` are reserved router keys: a capability id starting with `routes.` is refused.

## Image door

The MacBook studio app (`image-gateway/app`) generates, edits and plans images through the host instead of the VPS image-gateway. The host serves the studio's **existing wire contract** on its own port, so the app changes only its base URL and token. Anything else a client could ask of the host stays behind the API secret.

| Path | Method | Body | Answer |
|-|-|-|-|
| `/door/image/generate` | `POST` | JSON, the studio's `generateRequestSchema` (snake_case) | the JSON envelope; `text/event-stream` when `partial_images > 0` |
| `/door/image/edit` | `POST` | multipart: the fields of `editRequestSchema`, `image` (one) or `image[]` (several), optional `mask` | the same envelope; SSE when `partial_images > 0` |
| `/door/image/enhance` | `POST` | JSON, the studio's `planRequestSchema` (brief or `current_prompt` + `delta`, `style_guide`, `series_context`, `preserve_list`, `overrides`, `has_references`) | the plan response (`planResponseSchema`) |

Exactly these three. Every other path under `/door` (`/door`, `/door/`, a trailing slash, another case, an API path behind the prefix) is `404` in the studio's error envelope and never falls through to the API; another method on a door path is `405` with `allow: POST`.

- **Auth.** `Authorization: Bearer <token>` with a token from the door-tokens file or the API secret (the caller `agw`), compared hashed and in constant time (`bearerKeys`/`bearerCaller`, as the audio door). Missing or wrong is `401` with `WWW-Authenticate: Bearer`. A door token authenticates the door only: the API refuses it (tested). The caller of the run is the credential's name; `x-agw-caller` and the other caller headers a client sends are ignored. Tokens and request bodies are never logged.
- **One caller-token file.** The image door reads the file the audio process reads (`AGW_DOOR_CALLERS_FILE`, `~/.agent-workflows/data/door-tokens`): one parser (`src/door-tokens.ts`), one rotation procedure, one deploy check. The studio app is the caller `studio`. **Add or rotate a token:** edit the file (`name=token`, name `[a-z][a-z0-9-]*`, token at least 32 characters and unique, mode 0600), then restart both LaunchAgents (`launchctl kickstart -k gui/$(id -u)/com.jkrumm.agent-workflows-host` and `…-audio`); each reads the file once at start. `make deploy` creates the file with a `hermes` and a `studio` token when it is missing and appends a `studio` line to an existing file that has no `studio` caller; it never rewrites a line and never prints a token. Reading a token for the app is done on the mini by whoever seeds the app's settings, never from this repo.
- **Wire parity.** `src/image-door/contract.ts` mirrors the studio's schemas field for field; `test/image-door-contract.test.ts` parses fixtures written from the studio's `contract.ts` and `plan.ts` (`test/fixtures/image-door/studio.ts`), so a change on either side fails a test. The door maps to and from the capabilities' camelCase types (`src/image-door/convert.ts`): `model` is the studio's id of the seat that served the request (`gpt-image-2.5-flare` or `-sunburst`, whatever the route table maps the seat to), `routed` and `routing_reason` are the studio's wording (the retired `gpt-image-2` is routed like `auto` and says so), `cost` is `{ usd, source: 'computed' | 'none' }`, `usage` and `latency_ms` as the upstream answered.
- **Streaming.** With `partial_images > 0` the answer is `content-type: text/event-stream`, `cache-control: no-store`, frames `data: <json>\n\n`: previews (`partial_image`) as they arrive, then exactly one `completed` (the full envelope) or one `error` (`{ message, type }`), then the stream closes. Fewer previews than asked is normal, none is allowed. A failure before the first preview (validation, auth, upstream refused before any byte) is a plain JSON error with its status, not a stream. The client going away aborts the upstream call (`CANCELLED`); a stream that has started is never sent again.
- **Status and errors.** Every error is `{ error: { message, type } }`.

  | Status | `type` | When |
  |-|-|-|
  | 400 | `invalid_request_error` | body not JSON / not multipart, a field outside the studio's schema, no reference image, a wrong mime, a file over its limit, a size outside the envelope, a transparent jpeg, `input_fidelity` on a model without it |
  | 401 | `invalid_request_error` | no or wrong bearer (with `WWW-Authenticate: Bearer`) |
  | 404, 405 | `invalid_request_error` | another path under `/door`; another method on a door path |
  | 413 | `invalid_request_error` | body over the cap (below), refused from `Content-Length` without being read |
  | 502 | `upstream_error` | the upstream call or the planner failed; the message is the vendor's own. A moderation block also carries `code: "moderation_blocked"` and `moderation_details: { moderation_stage, categories }`, as the studio's gateway answered it |
  | 503 | `proxy_error` | shutting down; not configured; the run could not be recorded within 15 s (no work is done unrecorded); the request was cancelled by a shutdown |
  | 500 | `proxy_error` | anything unexpected, opaque (the detail is logged with the run id) |

  After the first preview the status is already 200: the same failure is the `error` frame, without the moderation extras (as the studio's stream).
- **Limits.** A JSON body is at most 2 MiB (a prompt is 32 000 characters). The studio's per-file limits hold (16 references, 50 MB each, a 4 MB png mask); 16 x 50 MB would be 800 MB, so a multipart request is capped at **100 MiB in total** (`MAX_MULTIPART_BYTES`): the body is buffered and copied once to rebuild the upstream form, about three times that in memory at the limit, and two full-size references fit. Bun's `maxRequestBodySize` is per server, not per route, so it cannot be raised for the door alone; it is set explicitly to its 128 MiB default (`MAX_REQUEST_BODY_BYTES`, every route of both processes) and the door's cap sits below it so an oversize request gets the studio's envelope, not Bun's bare 413. A multipart body that does not parse is `400`. The door lifts the server's idle timeout for its own requests (`server.timeout(request, 0)`): an image can take minutes, and the upstream calls carry their own hang guards (`streamIdleMs`, 30 minutes).
- **One run per request** (`src/image-door/door.ts`, the pattern of `packages/audio/src/process/door.ts` and `capability-runs.ts`). The workflows `door.image.generate|edit|enhance` are `internal` (no HTTP route, no CLI command, no schema entry). A request that passed validation gets a run id up front (`Bun.randomUUIDv7`, `StartOptions.runId`), returned in `agw-run-id`; the run is started in the background and its one step, `serve`, does the upstream work with the step's `addUsage` and `signal` (`requestImages` for generate and edit, `image.enhance` for enhance), pushing the SSE frames to the response as they happen, so spend, tokens and cost land on the run like on any other. The run input is JSON only: the caller, the endpoint, the path and the request's parameters (the prompt and settings, as `cap.image.generate` journals its input; for an edit the files' names, types and sizes, never bytes). The image bytes wait in an in-memory job found by run id and are dropped when the step ends. The output is a summary: `status`, `ended` (`done` or `client-gone`), the routed `model`, `costUsd`, `images`, `bytes`, `partials`. A run resumed in a process that never served the request fails with "the request was served by a process that has stopped". An upstream failure fails the run (message: status, type, the vendor's message); a client that went away ends it `done` with `ended: 'client-gone'`, status 499. Requests refused before any work (401, 400, 413) start no run. The response waits for the run to take its job (normally milliseconds, bounded at 15 s: a journal that is down is a `503`, never unrecorded spend); a run refused at admission by the wallet gate or the runaway cap takes the same 15 s to answer.
- **Not here.** The path-restricted tailnet block that exposes `/door/image/*` to the MacBook lives in the dotfiles Caddy registry, not in this repo; the door binds `127.0.0.1` like the rest of the host.

## Journal reads

Run state comes from `Runtime.getRun` and `Runtime.ping` (the runtime's public read API). The only SQL in the host is the learnings store and the retrospective's sampling (below), through one small pool of its own (2 connections, 30 s statement timeout) that never touches the run path. A held `Prefer: wait` polls `getRun`: one primary-key read per poll, backed off from 25 ms to 250 ms, so waiters cost the journal pool far less than the run writes. If that ever starves the pool (the runtime's `journalPoolSize`, default 10), the fix is a separate read pool inside the runtime, not more SQL in the host.

## Host reads

Three commands answer from the host without journaling a run, the way `run status` does: a herdr pane polls the first
every half minute and the statusline reports to the third on every render. They are operations handed to `createHost`
(`reads`, listed beside the run operations in the contract; the router key `reads` is reserved) and built by
`src/fleet/operations.ts`. Only the host process serves them (`ProcessDefinition.reads`; audio defines none): the CLI refuses a
command two processes declare unless every owner is a run command, and `packages/audio/test/read-operations.test.ts` boots both
processes and checks that rule. Settings reach them as closures over the process `env`, never `process.env` inside an operation.

| Command | Method, path | Does |
|-|-|-|
| `agw agents [--text] [--cols N] [--color]` | `POST /agents` | the agents overview, `{data}` (what agent-gateway's `GET /api/overview` returned under `data`, minus the retired dispatch fields, `summary.dispatch` included) or `{text}` for `watch` (`--format plain` prints it) |
| `agw quota` | `GET /quota` | `{data, accounts}`: the last `iu` report and every account's quota (the CLI numbers, overridden per window by a newer report, `stale` after 6 h) |
| `agw quota-report --five-hour-pct N [--five-hour-mins-left N] [--seven-day-pct N] [--account ID]` | `POST /quota/report` | the statusline's report, kept in memory (`account` default `iu`) |

`agents` is a POST because its flags are typed (`--cols` is an integer, `--text` a boolean) and a GET query string would
make the CLI send them as text. The host also pushes the same payload to Argo after each `overview` run and every ten
minutes (`startArgoSchedule`, stopped on close, off with `AGW_ARGO_PUSH=0`); a failed push is one log line. Details,
decisions and the environment: `src/workflows/overview/README.md`.

## Known gaps

- `/health` does not reflect stale recovery ticks: it says the runtime is open and Postgres answers, not that recovery is still running.

## Workflows

Each workflow lives in `src/workflows/<id>/`, its docs in `src/workflows/<id>/README.md`: `brain`, `check`,
`diagram`, `eval`, `otel`, `overview`, `prose`, `research`, `retrospective` (with the learnings commands), `review`. This file keeps
what they share (HTTP, the tool gate, process, deploy). `smoke.ping` (`src/workflows/smoke/`) is the reference: one
code step calling `llm.title` through `registry.call`, its usage passed to the step's `addUsage` so the run has priced
usage that reaches the `usage` schema.

## Adding a workflow

Adding one touches no shared file (`package.json`/`bun.lock` excepted):

1. `src/workflows/<id>/` with the workflow (`defineWorkflow`; input a `z.object`; its agents in `HostWorkflow.agents`
   so their files and routes feed the run fingerprint) and a `module.ts` whose default export is
   `defineWorkflowModule({ id: '<id>', create: (deps, context) => HostWorkflow[], suite?, phase? })`. `id` is the
   directory name. `suite: 'plain'` (or an object with `read(path)` for cases that need a tree, as `review` and `check`
   have; its types and `defined` are in `src/workflows/suite.ts`) puts `<id>` into the `agw eval run|compare` enum. `phase: 'last'` builds the module after all others, with
   their workflows as `context.peers` (the retrospective reads their agents); `context.suites` is every suite.
2. Its routes: `packages/routes/src/table/<group>.ts` (`packages/routes/README.md` §Table).
3. Its docs: `src/workflows/<id>/README.md`, including a §Route with each route's source seat.

`discoverWorkflowModules(dir)` (`src/workflows/registry.ts`) imports every `<dir>/*/module.ts` in sorted order;
`hostModules()` is the host's tree, discovered on first use and memoised (never at import, so importing
`workflows/index.ts` for a type loads nothing), and a second process (audio) calls `discoverWorkflowModules` on its own
tree. `await createWorkflows(deps, modules?)` builds them (default: `hostModules()`); a tree without suites serves no
`eval` commands. Boot fails, naming the file, on an empty dir, a default
export that is not a `defineWorkflowModule`, an id that is not its directory, a workflow id two modules register, a
suite whose module serves no workflow of its id, or an agent on a route the table does not have. The workflow then
appears as `POST /workflows/…` and `agw <id words>` with no other code.

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

## Process

`main.ts` binds the port first and only then opens the runtime, so a taken port (a deploy overlap) fails before any run is claimed; every resource registers its closer as it is created, and a failure anywhere in the start runs the same teardown as a signal. It builds the runtime with `platformMiddleware` (purpose, fingerprint, record, telemetry) followed by the wallet gate and the runaway cap, opens it (migrates the journal, starts the recovery tick), starts the outbox flush tick (30 s; always, on a deployed host) and serves. SIGTERM/SIGINT: stop accepting (held waits get 5 s to answer), `runtime.close()`, the cap's pool, `platform.close()` (flushes telemetry), exit 0. A second signal exits at once, and an unref'd timer (45 s, past the runtime's body grace) exits regardless if a close hangs. An uncaught exception shuts down the same way (exit 1); an unhandled rejection is logged and the process keeps serving. Until the runtime is open, `/health` is degraded and every other route is `503`. Runs stay `running` and the next process resumes them (concept §3: deploys need no drain); `test/main.test.ts` kills a process mid-run and watches a second one finish it.

The OpenCode `AgentHost` is wired in `boot.ts` (`lazyOpenCodeHost`): an `OpenCodeServer` and an `OpenCodeHost` with an empty agent list (no agent definitions exist yet). Both are built on the first agent step (or on the first friction-counter read for a run that has agent steps, e.g. one resumed after a restart), not at boot, so a host without agent workflows never spawns or probes `opencode`; a failed start is not cached and the next step retries. Shutdown closes the host and stops supervising the server, which keeps running for the next process (opencode-host README). `BootOptions.agentHost` replaces it in tests.

## Deploy

`make deploy` (`scripts/deploy.sh`) deploys `origin/master` on the mini as a **release**; `make deploy DRY_RUN=1` prints the plan and every rendered plist and changes nothing. A release runs every platform process (concept §8), each its own LaunchAgent from the same release: the host (`com.jkrumm.agent-workflows-host`, port 7791) and the audio process (`com.jkrumm.agent-workflows-audio`, port 7792, `packages/audio`). They are stopped, started, awaited and rolled back together, so one sha is live, never a mix.

| Path (under `~/.agent-workflows`) | Is |
|-|-|
| `repo` | the clone; fetch only, nothing runs from it |
| `releases/<sha>` | one immutable export of a commit (`git archive`) with its own `node_modules`; a `.complete` marker is written last, and the live release is never written to |
| `current` | symlink to the live release; the CLI link goes through it |
| `data/deployed-sha`, `data/previous-sha` | the live and the rollback release |

1. Preflight, before anything is built, stopped or written: the tools exist, `~/.local/bin/agw` is not a regular file, and the API secret reads through `secrets-run`.
2. `repo` is fetched; `origin/master` is exported to `releases/<sha>` and `bun install --frozen-lockfile` runs there. A failure removes the half-built release and leaves the running host untouched. The release's own `deploy.sh` takes over once, pinned to the same sha.
3. `data/door-tokens` (the doors' caller tokens, `name=token`, mode 0600, read by both processes) is created with a `hermes` and a `studio` token from `openssl rand` if it does not exist; an existing file keeps every line as it is, gaining one `studio=` line only when it has no `studio` caller (and only if it is a regular file at mode 0600); no token is printed (`test/deploy-door-tokens.test.ts`). It is then read with the release's own parser (`packages/host/src/door-tokens.ts`, `readDoorTokens`: mode, owner, every line; the module imports nothing beyond node and `auth.ts`): a bad file stops the deploy here, before anything is stopped, naming the file and line, and bun's own stderr is kept in the message. `test/deploy-rollback.test.ts` runs the rollback's plist handling in zsh with launchd stubbed. Each process's `deploy/<label>.plist.template` is rendered into `~/Library/LaunchAgents/` (`__HOME__`, `__RELEASE_DIR__`, `__SHA__`, `__DATA_DIR__`); every LaunchAgent is booted out, then each is bootstrapped. The plist points at the release path, not at `current`: it is the single statement of what runs, and moving the symlink can never change a running host's code. `KeepAlive`, `ExitTimeOut` 120 s (the host's own backstop is 45 s; the deploy waits `ExitTimeOut` + 10 s for the unload and refuses to bootstrap over a host that is still loaded), logs in `~/Library/Logs/agent-workflows-host.{out,err}.log`, env `AGW_MACHINE=mini`, `AGW_PORT=7791`, `AGW_VERSION=<sha>`, `AGW_DOOR_CALLERS_FILE=<data dir>/door-tokens`.
4. Every process's `/health` must answer `ok` with `version` equal to the new sha within `HEALTH_WAIT_SECS` (120, one deadline for all). If one never does, the deploy prints every process's log tails and **rolls back** all of them: the previous release is re-rendered, bootstrapped and awaited (version = previous sha) for each process it has a template for; a process the previous release predates is left booted out and the plist this deploy rendered for it removed, so `RunAtLoad` never starts the failed release at the next login (a plist this deploy did not write is never touched). Both outcomes are printed and the deploy exits 1, `deployed-sha` unchanged. With no previous release (the first deploy) every LaunchAgent is booted out and the plists this deploy rendered removed; a failed redeploy of the live sha (a transient health failure) keeps their plists (same sha, same release), bootstraps every process from them once more, waits for health again and names the processes up and down; it exits 1 either way. Either way `KeepAlive` does not loop a failing launch every 30 s.
5. Healthy: `current` moves to the release, `previous-sha` is written, `${XDG_CONFIG_HOME:-~/.config}/agw/env` is written at mode 0600 (created under `umask 077`; `AGW_URL`, `AGW_API_SECRET` and `AGW_PROCESSES=audio=http://127.0.0.1:7792`, the CLI's process list), `~/.local/bin/agw` is linked, and only then `deployed-sha`, so "deployed" means the CLI works too. The newest 3 releases stay, plus the live and the previous one; older ones are removed (only directories named like a full sha).

Each LaunchAgent runs `/bin/zsh scripts/launch.sh [host|audio]` (never a Homebrew binary: macOS BTM); the argument picks the entry (`packages/host/src/main.ts`, `packages/audio/src/main.ts`), everything else is the same per process. `launch.sh` exits 78 unless every ref in `.env.tpl` resolves through `secrets-run`, naming the refs that do not (refs, never values). Then `secrets-run run --env-file=.env.tpl` starts the host, with `AGW_PG_URL` built from `AGW_PG_PASSWORD` and `OTEL_EXPORTER_OTLP_HEADERS` from `OTEL_EXPORTER_OTLP_AUTHORIZATION` (secrets-run resolves whole-value refs only); the raw pieces are unset before the host starts.

**An untracked IU key override** (a team key for interim evals; the label goes with it): if `~/.config/agw/iu.env` exists, `launch.sh` reads `IU_API_KEY` and `IU_KEY_ID` from it and they replace the `.env.tpl` values before the host starts. The file must be a regular file at mode 0600, else `launch.sh` exits 78 and says why; it must set both names (a key without its label would be mis-attributed) with a non-empty `IU_API_KEY` and an `IU_KEY_ID` of exactly `personal` or `athena-team`, else 78. Values may be unquoted, double- or single-quoted; a trailing CR is stripped. Any other line is ignored with a warning that names the variable, never a value; values are never printed. Absent file: no override. `launch-override.test.ts` runs the block with a fake HOME.

**An untracked route override** (which model and spend every run gets, e.g. an eval of another model): if `~/.config/agw/routes.json` exists, `launch.sh` exports its content as `AGW_ROUTES` (one JSON object of route id to partial route spec, the shape in the routes README). The file must be a regular file (a symlink or a directory is refused), owned by the user running the host and not group- or world-writable (mode 0644 is fine, 0664 is not). It is read once into a variable; that string is validated with `validateOverrides` from `@agent-workflows/routes` (run with the release's `bun`, the same check `boot` makes), and exactly that string is exported. A failure exits 78 with the validator's message, which names the file, the route id and the problem and never an override value or the parser's own message (it quotes the input); it can name route ids and keys taken from the file. The validator's stderr is dropped, so bun's own output never passes for a message about the file. 78 retries at the plist's `ThrottleInterval`, not in a tight loop, but a deploy whose new release refuses the file **is rolled back** to the previous release, which does not read `routes.json`: the deploy reports a healthy rollback while the override is silently off. Fix the file before the deploy. **Precedence:** when the file exists it replaces an `AGW_ROUTES` already in the environment; an empty file is refused; absent file, the environment is untouched and nothing changes. On start one line names the file and the route ids it touches (validated table ids only, no models). `boot` calls `validateOverrides` again before anything is opened, so a bad `AGW_ROUTES` from any source refuses the start the same way instead of failing the first run that resolves the route. A route override moves the run fingerprint of every workflow that uses the route (`routeFingerprint` covers the resolved entry), so runs before and after a change are not comparable as one series. Removing the file and redeploying (or restarting the LaunchAgent) restores the table. `launch-routes.test.ts` runs the block with a fake HOME.

`make verify` (`scripts/verify.sh`) exits 0 only if `/health` is ok, the deployed sha equals `origin/master` and is what the host reports, `AGW_PURPOSE=verify agw smoke ping` exits 0 with a `title`, and that run's row in `agw.runs` is `done` with a trace id and priced usage, and a direct `AGW_PURPOSE=verify agw llm title …` leaves a `cap.llm.title` row `done` with priced usage. Then the audio process: `/health` ok at the same sha, `AGW_PURPOSE=verify agw audio ping` (routed by `AGW_PROCESSES`) leaves a `done` `audio.ping` row, an unauthenticated `POST /v1/audio/speech` gets 401 and one with the API secret and body `{}` gets the legacy 400 (`invalid_request_error`); the secret goes to curl on stdin, never the command line. It prints the run ids and, informationally, the friction job's state (never a failure).

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

Per workflow: its README. The host itself: none of its own beyond the OpenCode adapter's repeat-tool nudge (opencode-host README). The host adds no model-visible text and no tokens (the default scorers and drift are deterministic; `agw eval run --yes` costs what its case runs cost, tagged `purpose: eval`, and says so before it runs): workflow input goes to the runtime unchanged and capability calls go to the route table as the capabilities README describes. Held requests poll the journal, not a model. Two things to know: `agw schema <workflow>` now prints the workflow's output schema too (about a screenful for `review`), which a caller reading it spends context on once; a deploy that changes an `AGENTS.md`, skill, route or the OpenCode version changes the run fingerprint and costs one cold prompt cache (middleware README), and a capability called straight over HTTP (`agw llm title`) is a `cap.<id>` run of its own, recorded and in Argo like any run; one inside a workflow step counts on that step.

## Tests

`bun test packages/host` against a real Postgres (`AGW_TEST_PG_URL`, a throwaway schema per file) and the capabilities' fake IU server:

| File | Covers |
|-|-|
| `http.test.ts` | auth (missing, wrong, right, constant-time path, secret refusal), `/health` ok and degraded, the document and its sha, contract mismatch, collisions, `Prefer` parsing |
| `workflows.test.ts` | start 200 and 202, `run wait`, idempotency replay, purpose, failed runs, 404s, cancel of running and ended runs, a wait that stops with its client |
| `learnings.test.ts` | the store (propose, activate, retire at once, dedupe, a retired fact is never re-proposed and only a manual add revives it, activation order, the fence refused, the newest 25 read back), the read-back into the task message (proposed no, active yes, retired no on the next run), the fingerprint (unchanged without facts, moved by activate and retire), `agw learnings` over HTTP |
| `retrospective.test.ts` | sampling (window, eval/running/cancelled/child runs excluded, failed first, limit, null friction, no run input, preview cut), the agent step on `FakeAgentHost` with a fixture answer, dropped answers, the JSON retry (facts before the directive), no runs → no session, issues off/on/dedupe by marker/refused on a fake `gh` port, ISO weeks, weekly idempotency, failed-week retries and their bound |
| `retro-issue.test.ts` | the issue (structured fields only, hostile model text never in it, untracked targets refused, hash stability), `TrackedPaths` on a release tree and a git checkout, target shape, the prompt scrub |
| `registry.test.ts` | discovery on fixture trees (`test/fixtures/registry/`): a new module dir is discovered, its suite joins the eval enum, its route group the table; a duplicate workflow id, a duplicate route id, an agent on an unknown route, a non-module default export, an id that is not its directory and an empty dir each fail naming the file |
| `retro-wiring.test.ts` | config (`AGW_RETRO_*`), registration and fingerprint refs, the `gh` argument lists |
| `prose.test.ts` | `prose` on a fake registry: lint and review shape, the fenced review prompt and writer brief (no voice text inlined), identical prompts for identical input, `verdictFirst: false`, a missing voice guide fails before any call, German draft; the keep gate (faithful kept; lost URL/fence, added fence/URL, open fence, worsened rule, format switch, empty kept as original); the scorer; `rewrite gate` over HTTP |
| `prose-lint.test.ts` | agent-gateway's lint tests, ported: every rule fires and stays silent, German with English terms yields no findings, the fence parser, content-integrity helpers |
| `image-door.test.ts` | the host booted with the image door and a fake upstream fetch: the auth matrix (none, wrong, door token, platform secret, a door token on the API), the path restriction (404/405), generate (envelope against the mirrored schema, routing, the run with usage, cost and caller), edit (one and two references, a mask, every refusal), SSE ordering, one error frame, a failure before any byte as JSON, moderation mapping, the enhance mapping, a client that goes away, 413, a resumed run |
| `image-door-contract.test.ts` | the mirrored studio schemas against fixtures written from the studio's own (`fixtures/image-door/studio.ts`) |
| `deploy-door-tokens.test.ts` | `ensure_door_tokens` and `check_door_tokens` of `scripts/deploy.sh` under the real zsh |
| `caller.test.ts` | the caller headers: the secret's declaration, a malformed header a 400, a door token 401 on every API path, the usage row's `project_raw` and `raw.caller` |
| `smoke.test.ts` | `smoke.ping` end to end behind the platform middleware: usage on the step, the usage row |
| `capability-runs.test.ts` | a direct `llm.title` call as a `cap.llm.title` run: same body and errors as without a run, usage and the usage row, invalid input starts nothing, no nested run under `smoke.ping`, idempotent replay (success and failure), an unkeyed abort cancels the run, a keyed one does not (alone or as a retry of a running key), the journaled error wire format, opaque and refusal failures |
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
