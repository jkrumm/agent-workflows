# Lead handoff — Wave 2 (Core runtime, P1a)

Lead `agent-workflows-w1` (pane w40:p8), 2026-10-27 20:50 → 2026-10-28 ~00:50. Wave 2 is complete: all seven steps
landed on master (dotfiles master for the fleet tooling), each reviewed, plus one fix found by live verification
(route rates). The mother writes PLAN.md's Left behind, the retro entry and the status flips; this file is the source.

## Per-step verdicts

|Step|Verdict|Evidence|
|-|-|-|
|Runtime (Opus/medium)|**done**|PR #7. `defineWorkflow`, code/effect/agent/workflow steps, journal on Postgres (numbered migrations `0001`, `0002`), resume by step id, effect keys, re-attach order via an `AgentHost` port, middleware hooks (`runPre.resume`, `stepPre.replay`, post hooks after commit), lease = advisory lock on its own connection pool (64-bit keys) **plus** `lease_token` fencing on every journal write, infra vs step errors, retry policy, idle-rule timeout, cancel/steer, per-workflow concurrency, recovery tick (`pg_locks` filter), persistent crash-loop cap, literal-step-id lint. Kill harness kept as a regression test: every b-/m- kill point, 3 deploy shapes and **25 concurrent runs**, all done, 0 completed steps re-run, each effect once, each session prompted once. Closes every S1 "Wave 2 must" and "still to build" item|
|Middleware (Opus/medium)|**done**|PR #10. Run record (wall_ms, tokens incl. cache write, cost, unpriced/tool calls), fingerprint at admission (workflow version, agent files by mtime, route fingerprints, OpenCode version via a port), purpose on spans and Argo rows, OTel run/step spans with owned flush (signals re-raised, crash handlers, export failures logged; `OTEL_EXPORTER_OTLP_HEADERS` is read by the exporter itself on Bun), `usageFromOpenCodeMessages`, Argo outbox (short claim tx, post outside on its own pool, 400/422 quarantine, auth/5xx transient, additive token normalisation). Carried a runtime follow-up: `0002` migration, `StepPostArgs.handle`, bounded runPost redelivery, **`toolPre` throw fails the step (`ToolRefused`)**|
|Route table (Sonnet/high)|**done**|PR #5 + PR #11. The only home of model ids (guard test). `AGW_ROUTES` overrides for model/effort/limits/rate; `wire` cannot be overridden (lead decision: transport is code). `costFromUsage`: provider `usage.cost` wins, else per-route rate incl. cache read/write rates, else `unknown`, never 0. Rates for the Haiku 5.5 EU routes from agent-gateway `models.ts` (source and date cited)|
|Capabilities (Sonnet/high)|**done**|PR #6 (+ cacheWrite in PR #11). `defineCapability` → in-process `call` and HTTP through the same oRPC validation/middleware, OpenAPI with `x-cli`, typed error codes. IU transports `iu-openai`/`iu-anthropic`/`iu-decision` behind a port with fakes (billing on failed attempts, retryable body-read failures). `llm.summarize|title|classify`, `decide`. Live run 5/5|
|Caps + wallet gate (Opus/medium)|**done**|PR #9. Runaway cap = 10 × p95 of the workflow's done runs per root tree (static ceilings $5 / 50 M tokens / 3 h / 500 steps below 20 runs, numbers sourced from agent-gateway jobs and usage-tracker), stale-while-revalidate, enforced in `stepPre` and in-step via `toolPre`. Wallet gate: admission only (`resume: false`), IU rolling-30d ≥ $400 or pause date, snapshot file, fails closed on missing/stale/malformed/negative/throwing source; resumed runs always admitted (concept §4)|
|Fleet tooling (dotfiles, Sonnet/high)|**done**|dotfiles PR #33 (`8db5cd0`). Train installs from the present lockfile (time-boxed 600 s) before the check, readies draft PRs, prints gh's real error; `rd wave` skips live `<repo>-w<n>` names, refuses an explicit taken one, fails closed on an unreadable roster; worker template opens ready PRs. **Proven:** every later merge ran bare `make check` in the train|
|OpenCode wedge investigation (Sonnet/high)|**done: cause isolated**|PR #8, `docs/spikes/opencode-wedge/REPORT.md`. Not a hang: the file-watcher boot (one watcher per ancestor dir, sequential) queues the first request for a location 2.5–109 s; S2's 45 s ceiling called it a wedge. **`OPENCODE_DISABLE_FILEWATCHER=1`**: boot ~38 ms, prompt 0.46 s median, SIGTERM 31–90 ms, 54/54. Detect with `GET /api/info` (2 s timeout); SIGKILL always works; a session survives a server restart and re-attaches by id. IU ≈ $0.002|

## Review verdicts

Every PR: the worker's own check (most also ran their own gateway review and `/code-review`), the lead read the diff, agent-gateway review, and the lead's own `/code-review high` on runtime, middleware and limits (core and cross-package interfaces). `--deep` on runtime, middleware, limits.

|PR|Reviews (lead-run)|Outcome|
|-|-|-|
|#5 routes|gateway standard|needs-human → decided by lead (no `wire` overrides); 1 blocking (shared mutable `rate`) + 4 fixed|
|#6 capabilities|gateway standard|clean; 5 improvements taken (sync throws, billing on failure, retryable body reads, effort `none`, probability range). Registry HTTP auth deferred to the Wave 3 host that mounts it|
|#7 runtime|gateway deep + /code-review high, 2 rounds|3 blocking (persistent crash-loop counter, lease held until a detached body settles, …) + 11 more fixed; 1 false positive (Makefile `$$(`)|
|#8 wedge|gateway light|1 blocking (non-timeout errors counted as wedges) fixed, counts re-derived; numbers reconciled|
|#9 limits|gateway deep + /code-review high, 3 rounds|needs-human → decided by concept §4 (resumed runs admitted during a pause); toolPre race, per-root caps, fail-closed config, sink isolation fixed|
|#10 middleware|gateway deep ×2 + /code-review high|needs-human (outbox tx across HTTP; 2 angles timed out) → fixed; then 3 blocking (cost-only usage dropped, auth 4xx quarantined the backlog, duplicate run span on redelivery) fixed; 1 false positive (tsc self-reference: tsc green)|
|#11 route rates|gateway standard|clean; taken: opencode routes carry no (inert) rate and no false fallback comment, inconsistent cache counts and prompts > 100K tokens price as `unknown`, never under-priced|
|dotfiles #33|gateway standard|clean; fail-closed roster + install timeout taken|

## make check

`make check` green on final master `e5a53c0` from the main checkout: 257 tests / 28 files, 0 fail, 5 skip (live-only). CI green on every master push (GitHub-hosted, `postgres:18` service). The first main-checkout run failed (`no-unnecessary-type-assertion` in capabilities) only because its `node_modules` was stale; `bun install --frozen-lockfile` fixed it. Every train run since the fleet-tooling merge used bare `make check`.

## Live verification (`@verifier`, on the mini, master `b5d6356`)

One workflow `verify.w2` (code step calling `llm.title` live on IU, an effect, a fan-out of 2 children with one failing) with `platformMiddleware` + `runawayCap` + `walletGate`, journal schema `agw` of the maintained `agent_workflows` DB, purpose `build`:

- **Record in Postgres: PASS.** Runs `01a17fab-2cb0-…` and `01a17fab-30fe-…` `done`, fingerprint, version_started/finished, wall_ms 890/1378, tokens, trace ids, post hooks delivered; failing child's slot `null`.
- **Resume without re-run: PASS.** SIGKILL right after `title` was journaled (exit 137); a fresh process finished the run; `title` attempts 1, one IU call total, `drives=2`.
- **Spans: PASS against an in-script OTLP receiver.** Local ClickStack was **not running** (nothing on :431x); not started. Span tree per run, resumed run linked to its admission span and without a `title` span.
- **Argo projection: PASS (dry).** `ARGO_URL` unset, outbox off; rows built and validated against Argo's input schema; steps pending.
- **Limits wired: PASS.** Runaway decisions on every step; wallet probes allowed at $12, refused at $450.
- **IU cost: FAIL → fixed.** `cost` null, `unpriced_calls=1`: `cheap.title` runs on IU Messages, which reports no cost, and the route had no rate. PR #11 adds rates; its live run prices `llm.summarize` at $0.000063 (`costSource: rate`).

## IU spend (purpose=build)

**≤ $2.67**, upper bound from usage-tracker `usage.db`, every agent-gateway review row 19:40Z–23:05Z (review angle $1.30, adversary $1.07, synthesis $0.16, router $0.14) plus decide/triage < $0.01; other fleets reviewed in the same window. Live runs: capabilities ≈ $0.0002, wedge spike ≈ $0.002, verifier 2 Haiku calls. The legacy gateways still cannot tag `purpose=build`; the new runtime persists `purpose` on every run (the verifier's runs carry `build`).

## Left behind for the next wave

1. **Telemetry receiver for Wave 3.** Local ClickStack is down; spans were proven against an in-script receiver only. Wave 3's deploy needs a reachable receiver (local ClickStack via its Makefile target, or the authed VPS tier with `OTEL_EXPORTER_OTLP_HEADERS` from `secrets-run`) and a read-back.
2. **`ARGO_URL` has no 1Password ref**, so the outbox is off (`ARGO_API_SECRET` is in `.env.tpl`). Create the field, then add it to `dotfiles-private/headless.refs` **only after the field exists**, then `.env.tpl`.
3. **OpenCode host inputs (Wave 3):** `OPENCODE_DISABLE_FILEWATCHER=1` on every server; liveness via `GET /api/info` plus the idle watchdog; SIGTERM then SIGKILL; re-attach by session id. Verify file-change events are not needed. agent-gateway's server env allow-list (`scripts/opencode-server-env.ts`) would need the same variable — frozen repo, not ours.
4. **Registry HTTP auth** (bearer, constant-time, fail closed) belongs to the Wave 3 host that mounts `registry.fetch`.
5. **`AGW_MACHINE`** must be set in the deploy config (Argo upsert key); unset falls back to the hostname with a warning.
6. **Pricing gaps:** the >100K-token price tier is not modelled, so such calls report `unknown` cost; iu-openai relies on IU's `usage.cost`; OpenCode agent steps take cost from the message API only (no rate fallback). Argo totals for `cheap.*` step up once rows flow (they were unpriced).
7. **Limits known gaps** (README): admission burst overshoot within one snapshot interval; a SIGKILLed in-flight attempt's usage is not counted; resumed-run wall time estimated low (needs step liveness in the runtime); schema-name/logger duplicated from the runtime.
8. **Fleet tooling, new defect:** Claude Code's "compact earlier" modal swallows `rd say` while `rd say` still returns `agent_prompted`; two review rounds sat undelivered until the lead sent `esc` via `herdr pane send-keys`. Fix: `rd say` verifies the agent leaves `idle/done` and dismisses known modals; or the launcher pins `/autocompact`.
9. **Main checkout `node_modules` goes stale** after merges that add deps; `make check` there then fails in oxlint type-aware. `bun install --frozen-lockfile` first (or `make check` installs itself).
10. **Verification rows** (4 runs of `verify.w2`, purpose `build`) stay in schema `agw` of `agent_workflows` as evidence.
11. **Max accounts:** both were out of room 22:07–22:51 (me2 5 h window; `me` at 97–98 % weekly until 10-29 06:00). Batch 2 waited ~45 min; `rd fan` paused correctly, never spilled.
12. **agent-gateway restarted twice mid-review** (a worker saw a parse error at `server/jobs/handlers/review.ts`; the file is clean now). Jobs re-ran from scratch. Not ours.
13. **Flaky test, once:** a capabilities `llm.title` test failed once in 86 runs; the worker suspects a reused port with keep-alive and made the fake server send `connection: close`. Unconfirmed.
14. IU `/models` endpoint times out ~1/3 of calls while chat completions work (wedge spike side finding).

## Retro notes

**What we learned**

- Lead reviews on Max earned their cost again: the runtime's second round found a lease released while a detached step body still ran (a double effect after lease loss), and the middleware review found the outbox posting before the run record existed. Neither shows in single-run tests.
- Live verification found what 247 green tests did not: a route with neither a provider cost nor a rate. "Cost unknown, never 0" held: it showed as `unpriced_calls`, not as a silent zero.
- The OpenCode "wedge" was a measurement artefact of a 45 s ceiling against a 30–109 s watcher boot. One env var fixes it. A ceiling that is shorter than a slow-but-healthy phase reports a hang.
- Splitting the runtime follow-up onto the middleware worker (one owner of `packages/runtime` per round) kept the cross-package changes coherent and conflict-free.
- Fleet friction cost real time: the account picker paused for 45 min, and a UI modal silently ate four `rd say` messages. Delivery of a message must be verified, not assumed.

**Does the concept still hold?** Yes. No decision reversed; no concept change needed. Two refinements are implementation detail, recorded in the package READMEs: lease fencing uses both the held lock and a `lease_token`, and a `toolPre` throw fails the step (concept §4's interception points, now enforcing).
