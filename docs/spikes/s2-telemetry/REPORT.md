# Spike S2: telemetry shape (run span, step spans, traceparent, Argo record, OpenCode)

Date 2026-10-27. Bun 1.4.3, OpenCode 2.0.32, local ClickStack on the mini. Concept refs: §4 (Telemetry row), §5 (run record), §11 (S2), N6.

## Verdict

**The shape holds; build it as specified.** Items 1 to 4 are proven end to end; item 5 is proven for HTTP-level joining only.

- **Run span + step spans via OTLP into ClickStack: works on Bun.** One trace of 21 spans, 1 root, 0 orphans, across 5 processes. Parent/child read back out of ClickHouse.
- **`traceparent` in and out: works.** In via env (`TRACEPARENT`) and HTTP header; out via child-process env and outbound HTTP header. One tree spans caller, CLI run, HTTP run, grandchild process and a stub gateway.
- **Packages:** `@opentelemetry/sdk-trace` 3.0.0 + `@opentelemetry/exporter-trace-otlp-proto` 0.300.0 + `@opentelemetry/context-async-hooks` 3.0.0 on `@opentelemetry/api` 1.10.0. **The spike brief's `sdk-trace-base` / `BasicTracerProvider` is the dead line**: `sdk-trace-base` is a deprecated 2.x shim, its peer range is `api <1.10`, and the 3.x line has `TracerProvider` in `@opentelemetry/sdk-trace`. http/protobuf is the transport. gRPC and sdk-node also work on Bun 1.4.3 but buy nothing here.
- **Flush:** works on `beforeExit`, explicit `shutdown()`, SIGTERM and SIGINT; **fails without a handler** (span lost on `process.exit`, on a natural exit and on SIGTERM). The middleware must own the handlers.
- **Receiver:** `:4319` (unauthed) for local and dev; the authed HTTP tier with `OTEL_EXPORTER_OTLP_HEADERS` for anything that leaves the box. The platform code reads only the standard env, so the choice is deployment config, not code.
- **Argo record:** one `usage_record` row per agent step, source `agent-workflows`, validates against Argo's own input schema (copied verbatim, zod). Run-level facts (fingerprint, scores, friction, trace id) have no Argo column and ride in `raw`. 12 gaps below; two need a decision before P1.
- **OpenCode: not fully proven.** It emits its own OTLP spans on 2.0.32 with only `OTEL_EXPORTER_OTLP_ENDPOINT` set (no config key), and its HTTP server spans parent to our step span. **No model, token or tool-call spans were captured**: six prompt attempts (three with `experimental.openTelemetry`, three without) wedged the throwaway server (details and risk below). Take tokens, cost and tool calls from the OpenCode message API, not from spans.

## Evidence

Reproduce (ClickStack up, `:4319` answering):

```text
cd docs/spikes/s2-telemetry && timeout 120 bun install && timeout 120 bun run spike
timeout 60 bun run tree          # prints the last trace from ClickHouse (loopback HTTP :8123)
bun run argo                     # run record + Argo rows validated locally, writes sample/
bun run probe:packages | probe:flush        # SPIKE_INGEST_KEY=<local ingestion key> for the authed cases
bun src/probe-opencode.ts --no-prompt && bun src/query-opencode.ts
```

### 1 + 2. One trace tree (`evidence/trace-tree.out.txt`, trimmed)

`bun run spike` plays a caller: it spawns the CLI run with `TRACEPARENT` in env, then POSTs to a running host with a `traceparent` header. Each run does four steps; `research` spawns a child process (env propagation), `notify` calls a stub gateway (header propagation), `title` is a child workflow.

```text
trace 1b042c5d8b89749419586a3cf4ae4c89: 21 spans, 1 root(s), 0 orphan(s)
caller.invoke  [caller]
  caller.cli  [caller]
    agw.run research.report  [agw-cli]  workflow.id=research.report run.id=run_fdf5… tokens.input=1200 tokens.output=340 cost.usd=0.0123
      agw.step prepare   [agw-cli]  step.kind=code
      agw.step research  [agw-cli]  step.kind=agent  tokens.input=1200 tokens.output=340 cost.usd=0.0123
        leaf.work  [leaf-process]                      <- TRACEPARENT via child env
      agw.step notify    [agw-cli]  step.kind=code
        http.server POST /v1/ping  [stub-gateway]      <- traceparent via outbound HTTP header
      agw.step title     [agw-cli]  step.kind=workflow
        agw.run title.generate  [agw-cli]
          agw.step name  [agw-cli]  step.kind=agent
  caller.http  [caller]
    agw.run research.report  [agw-host]                <- traceparent via inbound HTTP header
      … same four steps, same two cross-process children
```

The tree is built from `ParentSpanId` in `default.otel_traces`; an orphan would show as an extra root. Attributes on every run/step span: `agw.workflow.id`, `agw.run.id`, `agw.step.id`, `agw.step.kind`, `agw.tokens.{input,output,cache_read,cache_write,reasoning}`, `agw.cost.usd`, `agw.tool_calls`; agent steps also `gen_ai.request.model` and `opencode.session.id`.

- Context across `await` is automatic: step spans nest under the run span with no explicit parent passing, so `AsyncLocalStorageContextManager` works on Bun for this shape.
- The host process and the stub were stopped with SIGTERM and their spans still landed (signal flush in a long-lived server).
- http/json gives the identical tree (`evidence/trace-tree.json-protocol.out.txt`: 21 spans, 0 orphans).
- Ingestion lag: spans appear in ClickHouse 2 to 8 s after export (collector batch). Queries must poll; `src/query-trace.ts` does.
- Query used (any client; the `/otel` skill's `query.py --env local` runs the same SQL):

```sql
SELECT SpanId, ParentSpanId, ServiceName, SpanName, round(Duration/1e6,1) AS ms, SpanAttributes
FROM default.otel_traces WHERE TraceId = '<trace id>' ORDER BY Timestamp, SpanId
```

### Receiver choice

|receiver|probe result|
|-|-|
|`:4319` unauthed http|200, proto and json both ok|
|`:4318` authed http, no key|`Unauthorized`|
|`:4318` authed http, ingestion key|ok|
|`:4317` gRPC, ingestion key|ok (Bun 1.4.3 + `@grpc/grpc-js` 1.14.6)|
|`:4317` gRPC, no key|`16 UNAUTHENTICATED` in 16 ms, no hang|

**Use `:4319` for the local ClickStack, and the authed HTTP tier (`OTEL_EXPORTER_OTLP_HEADERS` from `secrets-run`) for any export that leaves loopback.** Why: 4319 is bound to loopback here (docker bridge on the VPS), so the trust boundary is the host and no key sits in the process env; the authed tier is the one place a key is justified. Both are http/protobuf, so the code is identical and only `OTEL_EXPORTER_OTLP_ENDPOINT` and `_HEADERS` differ. gRPC works but adds `@grpc/grpc-js` for nothing and the research found open Bun/grpc-node hang reports; it did not hang here, but there is no reason to take the risk.

Not verified: that the exporter reads `OTEL_EXPORTER_OTLP_HEADERS` itself on Bun (the probes pass headers explicitly). One-line check for P1.

### 3. Packages on Bun (`/research` job 8868e268, then measured)

|package|version|role|Bun 1.4.3|
|-|-|-|-|
|`@opentelemetry/api`|1.10.0|API; **pin 1.10.x**, 3.x packages peer `>=1.10 <1.11`|ok|
|`@opentelemetry/sdk-trace`|3.0.0|`TracerProvider`, `BatchSpanProcessor`|ok|
|`@opentelemetry/core`|3.0.0|`W3CTraceContextPropagator`, `CompositePropagator`|ok|
|`@opentelemetry/context-async-hooks`|3.0.0|`AsyncLocalStorageContextManager`|ok|
|`@opentelemetry/resources`|3.0.0|`resourceFromAttributes`|ok|
|`@opentelemetry/exporter-trace-otlp-proto`|0.300.0|**http/protobuf, the choice**|ok|
|`@opentelemetry/exporter-trace-otlp-http`|0.300.0|http/json (a separate package, not an alias)|ok|
|`@opentelemetry/exporter-trace-otlp-grpc`|0.300.0|gRPC|ok, not recommended|
|`@opentelemetry/sdk-node`|0.300.0|all-in-one, env-driven|ok: constructs, starts, emits through the global API, shuts down|
|`@grpc/grpc-js`|1.14.6|gRPC transport|ok|
|`@opentelemetry/sdk-trace-base`|2.12.0|**deprecated shim; peer `api <1.10`**|do not use|
|`@opentelemetry/sdk-trace-node`|removed in 3.0|—|—|

3.x API changes that break old snippets: `BasicTracerProvider`/`NodeTracerProvider` are gone (`TracerProvider`), `new BatchSpanProcessor({ exporter, … })` takes one options object, processors are passed at construction (`spanProcessors: [...]`, no `addSpanProcessor`), `new Resource()` is `resourceFromAttributes()`. `sdk-trace` reads **no** `OTEL_*` env, so sdk-node's only real advantage (env parsing for sampler and span limits) must be hand-done; the middleware needs none of it. The module is ~130 lines (`src/telemetry.ts`).

**sdk-node or hand-composed?** Hand-composed `sdk-trace` + `-proto` (no patches). sdk-node works on Bun but drags in the metrics, logs and prometheus exporters and a resource-detector graph the platform does not use, and it has no `forceFlush`. Revisit only if auto-instrumentation is wanted.

Known Bun limits from the research, **not exercised here**: AsyncLocalStorage context is lost across `Worker`/`MessagePort`/`BroadcastChannel`, inside `process.on('unhandledRejection')` (oven-sh/bun#44650) and during dynamic `import()` (#32693). The middleware should not run steps in Workers, or must pass context explicitly there. `module.register` is a no-op, so no ESM auto-instrumentation.

### 3b. Flush matrix (`evidence/probe-flush.out.txt`)

Batch delay set to 30 s, so only an explicit flush path can deliver the span.

|case|delivered|
|-|-|
|no handler, `process.exit(0)` right after span end|**NO**|
|no handler, event loop empties|**NO** (the batch timer is `unref()`'d)|
|`beforeExit` handler calls `shutdown()`|yes|
|`await shutdown()` then `exit`|yes|
|no handler, SIGTERM|**NO** (exit 143, 2 ms)|
|SIGTERM handler: `shutdown()` then `exit(0)`|yes (22 ms)|
|SIGINT handler|yes|

The module installs `beforeExit`, `SIGTERM`, `SIGINT` once per process and caps `shutdown()` at 8 s (`Promise.race`), swallowing the array-rejection `forceFlush` throws on timeout.

### 4. Run record and Argo (`sample/`, `evidence/argo-validate.out.txt`)

`src/run-record.ts` holds the run record schema (concept §5) and `toArgoRows`. `bun run argo` parses the record the spike wrote, projects it, and validates the rows against a verbatim copy of `UsageRecordInputSchema` (`argo/apps/api/src/routes/usage.ts`, zod). A negative control (float token count, missing `billing`) is rejected. Nothing is posted. Samples: `sample/run-record.sample.json`, `sample/argo-usage-rows.sample.json`.

Posting path (N6): the platform posts directly, the way email-gateway does (`POST /usage/records`, bearer, fire-and-forget), not through usage-tracker's SQLite. Upsert key in Argo: `(source, source_id, machine)`.

Field mapping:

|run record (concept §5)|Argo `usage_record`|note|
|-|-|-|
|workflow id|`sub_tool`|same slot `check`, `review:angle` use today|
|run id + step id|`source_id` = `<runId>:<stepId>`; also `raw`|replay is a no-op; one row per agent step|
|—|`source` = `agent-workflows`, `grain` = `step`|new values; both free text in Argo|
|input hash|`raw` only (not shipped in the sample)|Postgres keeps it|
|output|none|never leaves the platform|
|outcome `ok`/`error`/`invalid_output`|`outcome` `ok`/`error`|`invalid_output` → `error`, original in `raw.runOutcome`|
|wall time|`duration_ms` (step); `raw.runWallMs` (run)||
|tokens input/output/cache read/cache write/reasoning|`input_tokens`/`output_tokens`/`cache_read_tokens`/`cache_write_tokens`/`reasoning_tokens`|additive contract, see gap 1|
|model|`model`, `model_norm`|route table holds canonical ids|
|cost|`cost_usd`, `cost_source` = `reported`|gateway `usage.cost`; Argo never reprices `reported`|
|tool calls|`raw.toolCalls`||
|friction counters, scores|`raw.friction`, `raw.scores`||
|trace id, span id|`raw.traceId`, `raw.spanId`|joins an Argo row to the ClickStack trace|
|fingerprint|`raw.fingerprint` (hash)|group-by is `raw->>'fingerprint'`|
|caller project / machine|`project`, `machine`|`workspace` set explicitly (`private`)|
|—|`billing` = `iu`, `account` = null|IU API lane|

Gaps:

1. **Token normalisation is the platform's job.** Argo's contract is additive (`input` = fresh uncached only; `reasoning` separate and added on top of `output` in `tokens_output`). IU/OpenAI-shaped usage is not: one live IU call returned `completion_tokens: 5` with `reasoning_tokens: 5` inside it and `prompt_tokens` including cached. The step recorder must subtract (input − cached, output − reasoning) before the row, as usage-tracker's collectors do. Get this wrong and Argo double-counts reasoning.
2. **No column for run id, trace id, fingerprint, scores, friction, tool calls.** They live in `raw` JSONB, unindexed. Fingerprint comparisons run on the platform's Postgres (system of record); Argo only needs cost and tokens. If Argo ever filters on fingerprint, add an expression index.
3. **Double counting with usage-tracker.** Its `agent-gateway-opencode` collector reads an OpenCode store at message grain and posts those tokens to Argo. If the platform's OpenCode store is ever added there while the platform also posts step rows, every agent step counts twice. Rule: platform posts, no tracker collector for the platform store (P4 already deletes "usage-tracker's platform collectors"); keep that order.
4. **A step can use more than one model** (nudge, continue, fallback). Key is `<runId>:<stepId>` here, one model per row. Needs `<runId>:<stepId>:<model>` and one row per model.
5. **Code-step capability costs** (search, TTS, image) have no agent step, so no row. Today research-gateway posts `sonar` rows with reported cost. Decide per capability whether it posts its own row; the run record carries the cost either way.
6. **Delivery.** email-gateway drops a record when Argo is down (5 s timeout, no retry). Platform runs are the system of record, so post from an outbox: `argo_synced_at` on the step row, retried by the host. Not built.
7. **`workspace` must be explicit.** Argo derives it from `project` only for path-driven sources and leaves NULL otherwise, which its Private/Work filter never matches. `project` needs the caller's repo; the CLI must carry the cwd (same gap Argo's usage doc records for agent-gateway).
8. **`machine` must be set.** A NULL machine is a different upsert key (Argo migration 0024 cleaned up exactly this).
9. **Int32 columns.** Token columns are `integer`; fine per step, would overflow on a run-grain row of a long cache-heavy run.
10. **`cost_usd` is `real` (float4).** Seven significant digits; sub-cent costs are fine, summing millions of rows drifts slightly.
11. **`billing`.** Platform steps are IU API (`iu`). A workflow step routed to a Max Claude account would need `billing: max` plus `account`; N8/Max-only-for-dev means none exist, but the route table must say which billing each route has.
12. **`grain: step`** is a new value. `GrainEnum` in Argo is the time-bucket enum for queries, not this column, so nothing breaks; the dashboards' "messages" vs "sessions" wording has no step notion.

### 5. OpenCode 2.0.32

Research (job bd391040) and probes, kept apart:

**Established by probe (`evidence/probe-opencode.*`):**

- OpenCode exports OTLP/HTTP **spans only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set in its env**. No config key was needed (flag off).
- `service.name` = `opencode`. **`OTEL_RESOURCE_ATTRIBUTES` is honoured** (`probe.run=…` landed on all its spans). New vs the dotfiles spike, which marked that low-confidence.
- **It reads inbound `traceparent` on every HTTP request**: 5 `http.server` spans (`POST /api/session`, `GET /api/info`, `/api/session`, `/api/session/active`, `/api/session/:sessionID/message`) have our step span as parent, in our trace.
- A server boot adds its own trace: 17 spans, root `ServerProcess.start` (Effect-runtime spans such as `SessionStore.list`, `Project.resolve`), plus a few single-span traces.
- Spans are exported only on a **clean exit**. A server that ignored SIGTERM exported nothing.

**Not established:**

- Whether a session run emits model, token or tool-call spans on 2.0.32. Research: the only documented switch is `experimental.openTelemetry: true`, which hands the AI SDK an `experimental_telemetry` tracer (spans `ai.streamText`, `ai.streamText.doStream`, `ai.toolCall`, with `ai.usage.*`, `gen_ai.*`, tool name/args/result). That wiring was read at **v1.19.0 only**; the schema marks it `deprecated`, the v2 docs omit it, and the code path moved in the v2 tree. No `ai.*` spans were seen.
- I tried to produce them. **Six prompt attempts**, cheapest route (IU chat, `deepseek-v4.1-flash`; the route itself answered a direct call in 1.1 s for $0.0000078): three with the flag, three without, the last sending the prompt through `curl` instead of Bun `fetch`. In every run the prompt or `wait` call hung until its ceiling, later requests to the same server (`GET …/message`) also timed out, and the server ignored SIGTERM. The earlier dotfiles spike got `prompt: 200` on the same build, so this is not simply "2.0.32 cannot prompt". Cause not isolated; candidates are the env passed by `Bun.spawn` versus `env -i`, and first-run work in a cold scratch HOME. No completion was observed, so no meaningful IU spend beyond the one direct call.

**Answer to "can our step span parent them":** at the HTTP boundary yes, if every request to the server carries `traceparent` (the per-request client must inject it, not just the first call). Work that the session forks from the server's boot context is **not** nested under the request: the dotfiles spike found the LLM `http.client` span and runner spans in the server-process trace; link them by session id (`x-opencode-session*` header attributes on the LLM span), and record the session id on the step span (`opencode.session.id`, already emitted by the spike). Do not design anything that needs request-level nesting of model spans.

**Implication for the run record:** read tokens, cost and tool calls for an agent step from the OpenCode message API (`/api/session/:id/message`, the same data usage-tracker's collector reads from the store), not from spans. Spans are for latency and joining; the record is the source of truth.

**Volume:** OpenCode adds ~17 spans per boot and one `http.server` span per request; the dotfiles spike counted 601 spans for a boot plus one prompt. If volume matters, drop `Effect` internals at the collector and keep `http.server` and the LLM client span.

## Risks

|risk|severity|handle|
|-|-|-|
|OpenCode server wedges on a prompt and ignores SIGTERM (6/6 here, 0/1 in the earlier spike)|**high for P1**|find the cause first: replay the dotfiles script verbatim against 2.0.32, then bisect env/cwd/HOME. The agent-step runner needs a hard ceiling, SIGKILL and re-attach regardless|
|no proof of OpenCode model/tool spans|medium|tokens from the message API; treat spans as optional enrichment|
|Argo token double-count if usage is not normalised|medium|unit-test the normaliser against the IU shape; gap 1|
|usage-tracker double-counts the platform's OpenCode store|medium|gap 3, rule in P4|
|`sdk-trace` 3.x is new; API names changed months ago and most examples online are 2.x|low|pin exact versions (`bun.lock` committed); copy `src/telemetry.ts`|
|ALS context lost across Workers / unhandledRejection|low|no Workers in steps; explicit context there|
|`OTEL_EXPORTER_OTLP_HEADERS` read by the exporter on Bun not verified|low|one-line check at P1|
|ClickStack cold start: `:4319` did not come up until `make clickstack-restart` (the collector supervisor gave up while ClickHouse seeded, log: `collector's OpAMP client never connected`)|low, dev only|after `clickstack-up` poll `:4319`; if dead, `clickstack-restart`|

## Layout

```text
src/telemetry.ts      init, propagation, withSpan, flush handlers (the module P1 lifts)
src/workflow.ts       fake run: run span, step spans, run record
src/run-record.ts     run record schema, Argo schema copy, toArgoRows
src/spike.ts          caller; agw-run.ts (CLI and --serve), stub.ts, leaf.ts are the processes
src/query-trace.ts    prints a trace tree from ClickHouse
src/probe-*.ts        packages, flush, opencode; query-opencode.ts reads the opencode run back
sample/               run record and Argo rows (validated)
evidence/             outputs of the runs above
```

The spike started ClickStack (it was down) and stops it again at the end.
