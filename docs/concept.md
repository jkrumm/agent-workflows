# agent-workflows: platform concept

**TLDR.** `agent-workflows` is a fresh monorepo. It replaces agent-gateway, research-gateway and audio-gateway in a hard rewrite. The unit is the **workflow**: typed in and out, versioned, evaluated. Every workflow runs inside the same middleware, so journaling, cost, telemetry, spend gates and scoring are global standards, not per-service code. Claude Code and Hermes reach the platform through one `agw` CLI, and chrome-devtools is the only MCP left. The factory is re-planned afterwards, on top of this.

**Where to look:** workflow shape §3, middleware §4, porting a skill or a Hermes path §10, phase order §11.

> **v3.5, 2026-10-29:** review angles by depth (§4 route table). A review the caller asks to run at `depth: deep` runs its angles on route `review.angle.deep` (Sonnet 5.5 EU); every other review, a router-chosen deep included, stays on Haiku `review.angle`. Why: Wave 6's experiment on the 20 paired cases (recall 0.017 → 0.13, located +0.09, precision 0.10 → 0.50, cost per review $0.057 → $0.54, wall unchanged); ~10× the angle spend is an opt-in under N8, never a cheap router's call. The run fingerprint lists both angle routes (it is taken before the depth is known), and the `plan` step records which one a run used. No decision reversed.
>
> **v3.4, 2026-10-28:** scorer API as built (§3, §6). `ctx.continue` takes a literal step id like every step (`ctx.continue('research:reask', draft, feedback)`, named `<stepId>:reask[:<n>]` so the friction counters see it; the §3 example omits it), and `from` is the earlier agent step's output or its id. A scorer is an object (`version`, optional `reference` schema, `score(input, output, ctx)`), not a bare function, so the version and the reference schema travel with it; an LLM-judged sub-score goes only through the `judge` it receives, never on the inline path unless the scorer opts in. Regression replays `$AGW_EVAL_DIR/<workflow>/cases.jsonl` (cases are private, Wave 4), and an eval arm is a fingerprint plus the run's extra input, because an input such as `angleVariant` changes behaviour without changing the fingerprint. `agw eval run` answers the plan and an estimate unless `--yes`. No decision reversed.
>
> **v3.3, 2026-10-28:** per-route fallback on provider balance (§4 Money). A route may carry a `fallback` (a full route spec, resolved and overridable like the primary; model ids stay in the route table). A call refused for provider balance (HTTP 402, or 503 "Insufficient Balance") runs once on it instead of failing; an OpenCode step whose turn was refused before it did anything reopens once on it; review answers a typed `needs-human` / `spend` result with `degraded: "provider_balance"` when even that fails. Why: DeepSeek's IU balance ran out (Wave 3 retro; 503 "Insufficient Balance" until ~09:10 on 2026-10-28) and every review and check on it failed; the owner chose to pay for a fallback model (GPT-6.1 Terra, medium) over failing. Review's OCR child became an internal workflow (`review.ocr`, no command). No decision reversed.
>
> **v3.2, 2026-10-28:** §8 OpenCode wedge risk resolved (file-watcher boot; OPENCODE_DISABLE_FILEWATCHER=1); the OpenCode host (`packages/opencode-host`) enforces it and re-attaches across server restarts. One shared server and IU key for every agent stays an accepted risk carried from agent-gateway (a shell-capable agent can read anything the user can); shell is denied unless an agent opts in. No decision reversed.
>
> **v3.1, 2026-10-27:** Wave 1 verdicts folded in: S1 own journal (§3, §12.4), S2 telemetry and the Argo projection (§4, §5), S3 stack and P0b store (§8), the OpenCode wedge risk (§8). No decision reversed.
>
> **Status: concept v3, 2026-10-27. Canonical here** (moved from dotfiles `docs/agent-workflows/`). Supersedes dotfiles `docs/factory/design/gateways.md` (concept v2) for
> the platform. The factory (TDD v2.4) is **deferred** and gets re-planned around this setup.
> **Inputs:** owner voice note dotfiles `docs/factory/feedback/2026-10-27-owner-voice-note-platform-first.md`
> and the chat that followed; `docs/research/2026-10-27-{deepseek-harness,setup-inventory}.md`; the
> 2026-10-26 research and spike 7 cited in concept v2.
> **Next:** P1 (Wave 2, core runtime). §12 is resolved (owner 2026-10-27: name, Postgres, budget; the rest are my defaults).

## 0. Principles

- **The optimal outcome over the plan.** The plan is a hypothesis. When a spike, an eval or a phase shows a better shape, the concept gets a new version that says why. We migrate to it cleanly: the superseded path is deleted, no compatibility shim stays behind, no half state survives a phase.
- **Every phase ends with a short retro:** what we learned, and whether this page still holds.
- **Round over fast.** A phase is done when its callers work well on the new path, not when the code exists.
- **Limits teach, they don't interrupt** (D5, §4).

## 1. Decisions

Carried from concept v2 (still hold):

| # | Decision |
|-|-|
| D2 | No MCP. chrome-devtools stays until a browser CLI exists |
| D3 | Cheap models may draft (review findings, otel explanations); the caller re-derives |
| D4 | Yolo by default; `profile: focused` is an opt-in quality lever |
| D5 | Per-run budgets, turns, steps and wall time are report-only and feed self-improvement (§7). Only runaway caps, far above normal, stop a run (§4) |
| D6 | Agents run code; artifacts come back as `[{path, kind}]` |
| D7 | Capability layer in-house, not Mastra |

New on 2026-10-27:

| # | Decision |
|-|-|
| N1 | **Platform first.** The factory waits and is re-planned on top |
| N2 | **Warden off now**, as its own step (P0), not inside a factory wave |
| N3 | **Hard rewrite in a fresh repo.** Old services freeze (fixes only) and keep running until each workflow is cut over, then they are deleted. No code is migrated; behaviour is, through eval sets |
| N4 | **Workflow is the unit.** "Station" and "engine" are retired (§2) |
| N5 | **Middleware wraps every workflow and every step** (§4) |
| N6 | **The platform is the system of record for its own runs.** Argo gets a usage projection; usage-tracker keeps only runtimes outside the platform |
| N7 | **otel needs no MCP.** HyperDX has an HTTP API; `/otel` already uses it |
| N8 | **IU budget is tight.** OCR stays gated (paused to 2026-11-02, then off while IU 30-day spend ≥ $400). The rebuild spends what it needs, tagged `purpose=build` for visibility, without a cap of its own |
| N9 | **Postgres on the mini is a maintained instance**, not a dev mirror: the vps repo's local Postgres grows prod-like roles, schemas, backups and upgrades (P0b). agent-workflows first; the factory and Argo later |

## 2. Vocabulary

| Term | Meaning |
|-|-|
| **workflow** | the unit: `id`, typed `input` and `output`, a `run` procedure, a scorer, an eval set. Called as `agw <workflow>` |
| **step** | one journaled unit inside a run. Three kinds: `code`, `agent`, `workflow` |
| **agent** | a reusable definition: `AGENTS.md`, skills, route. Several workflows reference the same agent (`brain` serves research and podcast) |
| **capability** | a typed function defined once, exposed as import, HTTP and CLI. Used by code steps directly and by agents through `agw` |
| **run** | one execution of a workflow; owns a run record (§5) |

A former "station" is a workflow with one agent step. A former "engine" is a workflow that is mostly code steps. The distinction was never about the thing, only about the ratio.

## 3. A workflow

Target API, not built yet. The shape is the owner's: prepare → agent → score → nudge → finish → post-process.

```ts
export default defineWorkflow({
  id: "research.report",
  input: z.object({ question: z.string(), depth: z.enum(["standard", "deep"]) }),
  output: Report,
  scorer: reportScorer,
  async run(ctx, { question, depth }) {
    const plan = await ctx.step("plan", () => caps.decide({ question, options: PLAN_OPTIONS }));
    let draft = await ctx.agent("research", { prompt: brief(question, plan), output: Draft });
    const verdict = await ctx.score("gate", draft);
    if (!verdict.pass) draft = await ctx.continue(draft, verdict.feedback);
    const title = await ctx.step("title", () => caps.title({ text: draft.body }));
    return { ...draft, title };
  },
});
```

- **Journal.** Each step's result is stored under `(runId, stepId)`. After a restart or deploy, the run resumes at the first unfinished step. Completed steps are not re-run.
- **Agent steps re-attach.** An agent step's durable handle is its OpenCode session id. A restarted workflow process re-attaches to the session instead of re-prompting. This replaces today's 30-minute drain on research-gateway deploys.
- **Effects need keys.** A step with an outside effect (send, publish, write) carries an idempotency key derived from `(runId, stepId)`. No recovery can prove an interrupted effect didn't happen.
- **Bounded runs only.** A workflow run lasts seconds to tens of minutes. Anything that lives for days, such as a factory Issue, is an entity state machine that *starts* workflows, never one long run. This is the lesson behind rejecting DBOS for the factory. It does not argue against durable steps here.
- **Failure split** (from DeepSeek Harness): a failing step is fatal. A failing child workflow in a fan-out returns `null`, and the parent decides.
- **Our own journal, decided by S1** (`docs/spikes/s1-runtime/REPORT.md`): two Postgres tables, `runs` and `steps` keyed `(run_id, step_id)`, a lease per top-level run held as a Postgres advisory lock (released the moment the holder's connection dies, no heartbeat; the lease needs its own connection budget and fencing, `docs/spikes/s1-runtime/REPORT.md` §Wave 2 must), children driven by their parent's step. It passed every kill and deploy scenario. DBOS strands in-flight runs on a code change unless the old version drains them; Vercel Workflow's Postgres world fails a run with `CORRUPTED_EVENT_LOG` when a step is inserted before recorded ones, and after a mid-step crash leaves it behind a job lock graphile-worker expires only after 4 h.
- **Replay is by step id, so a deploy needs no drain:** SIGTERM, restart, continue on the new code. The rule that keeps this safe: **a change to a step's meaning or output shape takes a new step id.** `runs.version_started` and `version_finished` show which runs crossed a deploy. Step ids are literals; fan-out adds an index.
- **Re-attach order:** create the session, journal its handle, then prompt; on resume, a handle with a prompt sent waits, a handle without one prompts (the send checks the session's messages first), no handle opens a new session.

## 4. Middleware

The workflow author writes `run`. Everything below belongs to the platform and is the same for every workflow.

| Layer | Workflow level | Step level |
|-|-|-|
| Contract | auth, input/output validation (one re-ask, then `invalid_output`), idempotency key | output schema for agent steps |
| Durability | journal, resume, re-attach | step result stored, effect keys |
| Record | run record with fingerprint (§5) | step timing, tokens, cost, tool calls |
| Telemetry | one OTel span per run, `traceparent` accepted | child span per step |
| Money | budget report; **runaway cap** (far above the workflow's normal, e.g. 10× its p95); **wallet gate** for optional expensive work (OCR) at admission, never mid-run | cost from `usage.cost` |
| Control | cancel, steer, concurrency limit per workflow | step timeout, retry policy |
| Quality | scorer sampling on production runs | friction counters (§7) |

Interception points follow DeepSeek Harness's taxonomy, before and after each run, step and tool call: `run/pre`, `step/pre`, `tool/pre`, `tool/post`, `step/post`, `run/post`. The OCR spend gate that is hand-built in review today becomes one middleware rule that protects every workflow.

**Telemetry, as proven by S2** (`docs/spikes/s2-telemetry/REPORT.md`):

- Packages: `@opentelemetry/sdk-trace` 3.x with `exporter-trace-otlp-proto` and `context-async-hooks`, http/protobuf. `sdk-trace-base` is the dead 2.x line. Context nests across `await` on Bun without explicit parents.
- The middleware owns flush: exit, SIGTERM, SIGINT and the crash handlers. Without a handler spans are lost. Export failures and dropped spans are logged, never silent; after a signal flush the signal is re-raised.
- Receiver is deployment config, not code: the unauthed loopback `:4319` locally, the authed tier (`OTEL_EXPORTER_OTLP_HEADERS` from `secrets-run`) for anything leaving the host.
- OpenCode 2.0.32 exports its own spans when `OTEL_EXPORTER_OTLP_ENDPOINT` is set and parents its `http.server` spans to an inbound `traceparent`. Model and tool-call spans were not observed. **Tokens, cost and tool calls come from the OpenCode message API**, not from spans; spans are for latency and joining, linked by `opencode.session.id` on the step span.

## 5. Run record and fingerprint

Every run writes one record: workflow id, input hash, output, outcome, wall time, steps, tokens (input, output, cache read, reasoning), cost, tool calls, friction counters, scores, trace id.

The **fingerprint** is a hash over everything that can change behaviour:

- the workflow code version
- each referenced agent's `AGENTS.md` and skills
- route (model + effort)
- OpenCode version

"Did the change help?" becomes a query: score, cost, latency, tokens and tool calls grouped by fingerprint.

**Argo projection (S2).** One Argo `usage_record` row per agent step and model: `source` `agent-workflows`, `source_id` `<runId>:<stepId>:<model>`, `sub_tool` the workflow id, step start as `ts`; run-level facts (fingerprint, scores, friction, trace id) ride in `raw`. Two rules the projection must hold:

- **Tokens are normalised to Argo's additive contract** before the row (input minus cache read, output minus reasoning); provider usage is not additive, and getting it wrong double-counts reasoning.
- **Rows leave through an outbox** (`argo_synced_at` on the step row, retried by the host), because the platform is the system of record and Argo may be down. No usage-tracker collector reads the platform's OpenCode store (P4 order).

## 6. Evals

One scorer per workflow, used three ways:

1. **Inline gate:** the `ctx.score` step that decides whether to nudge the agent.
2. **Regression:** `agw eval run <workflow>` replays `eval/cases.jsonl` against the current fingerprint. A change to code, prompt, skill, route or OpenCode version must not lose.
3. **Drift:** sampled production runs are scored after the fact.

`agw eval compare <workflow> --a <fp> --b <fp>` answers model, effort and prompt questions with numbers: better, cheaper, faster, fewer tokens, fewer tool calls. Eval replays spend IU money under N8.

Eval sets today: research-gateway has 28 regex-checked golden questions. **Review and check have none.** P1 builds them from recorded past runs before the cutover can be judged.

## 7. Self-improvement

Three tiers, cheapest first:

1. **Friction counters, every run, no LLM:** schema re-ask, over budget, repeated identical tool call (nudge at 3, 5, 8 — DeepSeek Harness), tool error, a follow-up the user had to ask. A threshold breach per workflow opens an Issue with the runs as evidence.
2. **Retrospective workflow, weekly per workflow:** samples run records and transcripts and finds:
   - code the agent keeps writing → a capability
   - recurring mistakes → `AGENTS.md` or skill
   - tool pain → CLI change

   Output: proposals as Issues, never edits.
3. **Fixes land as PRs behind the eval gate.** Nothing rewrites itself in place.

Learned facts ("this shop blocks at TLS") go into a per-agent learnings store and are read back on the next run — reversible and immediate. The same retrospective later points at Claude Code sessions: per-repo setup, skills, basalt-ui, alerts. The factory, when it exists, owns the Issues.

## 8. Runtime and deployment

- **Everything on the mini.** email-gateway may stay on the VPS and consume the shared packages.
- **Agent steps run on one OpenCode server**, one location directory per agent, compiled outside any repo. Otherwise an ancestor `AGENTS.md` leaks in.
- **Processes by deploy unit, not per workflow:** one `host` process (light workflows, capabilities, HTTP API), plus own processes for heavy pipelines (research, audio). A review deploy never waits on a research run, and a research memory spike can't take review down.
- **Store:** Postgres, the matured mini instance (N9, §12.2). Since P0b: database `agent_workflows` with its own least-privilege role, nightly backup to the HomeLab that ends in a restore drill on exact snapshot counts, a minor-upgrade target, a heartbeat probe; the whole-DB `sync-from-prod` is gone. Runbook: vps `docs/mini-postgres.md`.
- **Stack (S3,** `docs/spikes/s3-stack/REPORT.md`**):** oRPC 1.x with zod 4 for every route and capability, because only oRPC calls one definition in-process (`call`) through the same validation and middleware as HTTP, which is what "import, HTTP and CLI from one definition" (§2) needs. `x-cli` rides on each procedure's `spec` callback behind one helper; the CLI generator maps oRPC's typed `code` to exit codes and dereferences `$ref`. Handlers stay plain functions of `(input, ctx)` so the framework coupling stays in the procedure layer. Toolchain: `bun test`, Biome (format, lint), oxlint `--type-aware` for typed rules, TypeScript 7 `tsc`, all pinned exactly.

### OpenCode stays the agent runtime

DeepSeek Harness is a reference only (`docs/research/2026-10-27-deepseek-harness.md`). Why not the runtime:

- Node 24 only.
- Pre-1.0, with announced breaking changes.
- stdio-only server.
- Its workflow engine has no journal, resume or budget — our middleware would still be the point.
- Its default session-log upload to DeepSeek rules out running it unconfigured.

Taken from it:

- the event taxonomy (§4)
- "model-visible means logged"
- the repeat-tool nudge
- the failure split
- a "token effect / cache effect" note in every package README
- the DeepSeek wire rules for our cheap routes: pass reasoning back verbatim, never edit history, append system and tool changes instead of rewriting the head, record cache-read tokens

**OpenCode wedge (S2), resolved:** it was not a hang. On the first request for a directory, 2.0.32 boots one file watcher per ancestor directory, one after the other, and answers nothing for that location until the last is up: 2.5 s to over 150 s on a loaded host, against S2's 45 s ceiling; SIGTERM is not acted on until the boot ends (`docs/spikes/opencode-wedge/REPORT.md`). The fix is `OPENCODE_DISABLE_FILEWATCHER=1` in the server env (boot 38 ms median, 54 of 54 trials prompted). The host (`packages/opencode-host`) sets it in its env allow-list on every server it spawns, probes liveness with `GET /api/info` (2 s guard) on a tick, and on three misses SIGTERMs, SIGKILLs after a grace and restarts on the same port and store; a wait in flight re-attaches by session id and resumes a cut-off turn with one appended synthetic note, never a second prompt. Liveness of a session stays the idle watchdog (no new session message for N minutes means wedged; never a turn or wall-clock cap). One server and one IU key serve every agent, an accepted risk carried from agent-gateway: a shell-capable agent can read anything the user can, so the shell tool is denied unless an agent's definition opts in, and the server runs with its own `HOME` and an env allow-list.

## 9. The `agw` CLI

Generated from each process's OpenAPI document plus an `x-cli` extension per operation (spike 7 runner, 536 lines). Every workflow and capability appears without hand-written CLI code.

Contract (ADR-004, proven in spike 7):

- machine output by default
- unknown flags exit 2
- exit codes 0–10
- typed error line
- long runs exit `pending` with the exact resume command
- offline `agw schema`

Today's `agw` (1,557 hand-written lines in agent-gateway) is renamed `agw-legacy` for the transition, so the new binary owns the final name from day one.

## 10. Claude Code and Hermes target picture

Facts in `docs/research/2026-10-27-setup-inventory.md`.

| Item | Today | Target |
|-|-|-|
| `check`, `review` skills | MCP + `job_wait` | `agw check` / `agw review`; skill shrinks to when-to-use (P1) |
| `research` skill | research-gateway MCP | `agw research` (P3) |
| `otel` skill | agw MCP `otel` + `hdx.py` / `query.py` | `agw otel` workflow; `hdx` becomes a capability in the repo (P3) |
| `excalidraw-diagram` | agw MCP | `agw diagram` (P3) |
| `prose` | `agw prose`: lint → cross-lab review → Opus rewrite → keep gate, all on IU (~$0.05/call) | `agw prose` does lint + cross-lab review + keep gate; **the rewrite moves into the calling Claude Code session on Max** (P3) |
| `podcast` | `bun run podcast` in audio-gateway | `agw podcast` (P4) |
| `img` | `imgcli` | `agw image` (P4) |
| `implement`, `wave`, `remote-dev` | name `mcp__agent-gateway__dispatch` | name `agw-legacy dispatch` until the factory replaces it |
| `browse` | chrome-devtools MCP | unchanged |
| agw MCP server | 16 tools | deleted per tool as ported; server gone at P5 |
| research-gateway MCP | `/mcp` | deleted at P3 |
| Unused agw tools (`triage`, `decide`, `update_pr`, `read_image`, `read_drawing`) | MCP, no caller by name | ported only when a caller appears; `decide` returns as a capability |
| hooks, rules, `@implementer`, `@verifier` | — | unchanged |
| CLAUDE.md lanes | four, incl. `warden run` | three after P0 |
| CLAUDE.md "Async jobs" | `mcp__…` → `job_wait` | one line: `agw` waits itself; on `pending`, run the printed resume command |
| Hermes → warden | `hermes-cc.sh`, `warden` skill | deleted at P0 |
| Hermes → gateways | HTTP from scripts and skills; HyperDX via `/api/mcp` | `agw` commands via `terminal` (P5) |
| Hermes TTS/STT | audio-gateway OpenAI-compatible URL | an OpenAI-compatible door on the new audio process (P4) |
| Hermes narratives, overview | agw HTTP | ported workflows (P5) |

## 11. Order

Every phase moves at least one real caller and deletes the old path. A phase with no caller moved is not done.

| Phase | Builds | Caller moved / deleted | Gate |
|-|-|-|-|
| **P0** | warden off: the checklist in dotfiles `docs/factory/tdd/10-surfaces.md` §What is switched off, and when; Kuma and HyperDX alerts go raw to Slack | warden lane, Hermes shim and skill, warden LaunchAgents | `make doctor` green, no caller of warden left |
| **P0b** | the mini's Postgres (vps `compose.dev.yml`) matured: roles and schemas through `setup-postgres.sh` as on the VPS, nightly backup to the HomeLab, a restore drill, upgrades by make target, a heartbeat component; database `agent_workflows` with its own role. Whole-DB `sync-from-prod` is retired in favour of per-schema `pg-sync-schema`. The stray brew `postgresql@18` default instance is resolved | — | restore drill passes; `make doctor` green |
| **S1, S2** | spikes, about a day each: workflow runtime (§12.4), telemetry (run span + step span into ClickStack, record into Argo) | — | a written verdict each |
| **P1** | repo, workflow runtime, middleware, run record, route table with effort, capabilities, CLI generator, OpenCode host; review and check ported incl. depth gating and the OCR gate | `/check`, `/review` skills; agw MCP `check`, `review` | review and check eval sets built and not worse than the old service on findings, cost, wall time |
| **P2** | scorers, `agw eval run/compare`, friction counters, first retrospective — on review, the biggest IU spender | — | one model or effort question on review answered with numbers |
| **P3** | research (the three-way comparison picks the design), otel, brain, diagram, prose | `/research`, `/otel`, `/excalidraw-diagram`, `/prose`; research-gateway MCP | research golden set held; otel cost per query recorded |
| **P4** | audio pipeline and TTS/STT door, image, podcast; usage projection to Argo; usage-tracker trimmed | `/podcast`, `/img`, Hermes TTS/STT; usage-tracker's platform collectors | one episode produced end to end on the new path |
| **P5** | Claude Code and Hermes slimmed (§10); narratives and overview ported | agw MCP server, research MCP registration in the Makefile | CLAUDE.md and skills reference no MCP gateway tool |
| **P6** | retire research-gateway and audio-gateway; agent-gateway shrinks to `dispatch` | old repos archived | `make doctor` and architecture map clean |
| **then** | factory re-plan on this base | — | — |

## 12. Decisions resolved 2026-10-27

Owner-decided:

1. **Name:** repo `agent-workflows`, CLI stays `agw`, today's becomes `agw-legacy`.
2. **Store:** Postgres — the matured mini instance (N9, P0b).
3. **Budget:** spend what is needed, no separate cap; runaway caps only (N8, §4).

Defaults I set (open to a flip, revisited at each phase retro):

4. **Workflow runtime:** our own journal on Postgres (S1, 2026-10-27; §3). Vercel Workflow and DBOS TypeScript measured and rejected on deploy and crash behaviour.
5. **Processes:** `host` plus research and audio; split more only on evidence.
6. **`dispatch`:** stays on `agw-legacy` until the factory replaces it; not ported.
7. **Factory in the same monorepo:** decided at the factory re-plan; bias yes.
8. **email-gateway:** stays on the VPS, consumes the packages, moves last or never.
9. **"agent"** means an OpenCode agent definition here, not a Claude Code subagent; the context disambiguates.

## Retro log

One entry per phase: what we learned, what changed on this page, and why.

### Wave 1 — Foundations (S1, S2, S3, P0b, scaffold), 2026-10-27

- **Learned.** The starting bias held on evidence: our own journal (163 lines, 1 dep) is the only
  runtime that survives a redeploy without a drain. DBOS parks in-flight runs on any code edit, and
  Vercel corrupts its event log when a step is inserted. Replay by step id makes "a changed step
  meaning takes a new id" a load-bearing authoring rule. The one-definition capability contract picked
  oRPC by itself. OpenCode telemetry is a join aid; tokens come from its message API. A single-run
  spike harness hides concurrency bugs (the lead's read found a journal pool deadlock at 20 runs).
- **Changed.** v3.1: §3, §4, §5, §8 and §12.4 detailed; no decision reversed. Agent-step liveness is
  the idle watchdog, not a ceiling.
- **Risks carried.** OpenCode 2.0.32 wedged on every prompt in S2 (6/6): isolate before the OpenCode
  host is built (Wave 3, first step).
- **Spend.** IU ≤ $1.35 (research $0.64, review $0.68), reconstructed from a time window: the legacy
  gateways cannot tag `purpose=build`. The new platform tags it natively from Wave 2.
- **Does the page hold?** Yes.

### Wave 2 — Core runtime (P1a), 2026-10-28

- **Learned.** Lead reviews on Max caught what single-run tests cannot: a lease released while a
  detached step body still ran, and an outbox posting before its run record existed. Live verification
  caught what 257 green tests did not (a route with neither provider cost nor rate); "cost unknown,
  never 0" made it visible. The OpenCode "wedge" was a 45 s ceiling against a 30–109 s file-watcher
  boot: a ceiling shorter than a slow-but-healthy phase reports a hang (D5 holds). One owner per
  package per round kept cross-package changes conflict-free.
- **Changed.** Nothing on this page; lease fencing (lock plus `lease_token`) and `toolPre` refusal are
  implementation detail in the package READMEs. §8's wedge risk is resolved; Wave 3 rewrites it.
- **Friction.** Max accounts out of room for 45 min (`rd fan` paused, never spilled); a UI modal
  silently swallowed four `rd say` messages.
- **Spend.** IU ≤ $2.67 (reviews), reconstructed from a time window; the new runtime already
  persists `purpose` on every run.
- **Does the page hold?** Yes.

### Wave 3 — CLI, agent host, deploy tooling (P1b), 2026-10-28

- **Learned.** Fixing the host↔CLI HTTP contract in the briefs let both build in parallel; the only
  drift was a contract gap (reserved flag names) caught in review. Lead reads on Max again found what
  gateway reviews missed: a 30 s client abort on synchronous calls, a pin timer dropping eviction
  protection on long turns, a deploy that overwrote the live tree with no rollback (now release
  directories with rollback). The secrets path is a deploy's critical path: request 1Password items at
  the start of a wave, while the owner is awake. Sweeps across repos need an explicit "never push to a
  work remote" rule. A lead ending its turn on a background shell stalls the fleet.
- **Changed.** §8: the OpenCode wedge is resolved (file-watcher boot), and the shared OpenCode server
  credential is an accepted, documented risk (v3.2 note).
- **Not done.** The deploy: blocked only on the owner's 1Password item; carried into Wave 4.
- **Friction.** All three Max accounts near their limits; the lead paused an hour at a 5-hour reset.
  IU/DeepSeek balance ran out mid-wave.
- **Spend.** IU ≈ $2.31 + earlier rounds on reviews (upper bound, shared gateway).
- **Does the page hold?** Yes.

### v3.3 — provider-balance fallback, 2026-10-28

- **Learned.** An empty provider account is a routing fact, not a run failure: one classifier (402, or 503 "Insufficient Balance") and one fallback per route keep review and check working while DeepSeek is out; the in-session `/code-review` is the last resort, typed so callers branch on it.

### Wave 4 — Review and check cut over (P1c), 2026-10-28

- **Learned.** A recorded corpus is not a baseline: legacy's own rerun recovered none of its recorded
  blockers, so ten paired cases on the same trees said more than nineteen against records. Eval sets
  need a reproducibility check before they judge anything (now a Wave 5 step). Each fix round needs its
  own review: a round-3 fix introduced two regressions. Deep gateway reviews (~$2 each) added little once
  their cross-family critic was dead; lead reads on Max kept finding what tests and gateways missed.
- **Changed.** Per-route fallback on provider-balance failures and an in-session degrade for `review`
  (owner direction, IU constrained); the IU key label on usage rows. Callers moved: `/check`, `/review`;
  agent-gateway's MCP `check` and `review` deleted.
- **Friction.** The DeepSeek provider behind IU ran out of balance; interim evals ran on the Athena team
  key. A worker ended its turn on a background shell (one `rd say` fixed it). The merge train flakes on
  timing under load.
- **Spend.** IU ≈ $11 on gateway deep reviews before the owner stopped them, plus eval runs on the team key.
- **Does the page hold?** Yes. P1's gate (review and check not worse) is met.

### Wave 5 — Evals and self-improvement (P2), 2026-10-28

- **Learned.** An experiment that changes nothing is still an answer: neither a caller instruction nor
  a read-only git shell moved review findings (3 arms × 20 cases, inside noise; the grep tool already
  covers it). Text-matched shell allowlists are no boundary (three escapes found by reading one), so
  OpenCode sessions now deny webfetch, websearch and subagent by default. The eval tooling paid off at
  once: one `run` + `compare` was the cleanup's regression check and exposed that the fingerprint
  ignored `agent.json`. Fix rounds converge when the lead asks for a design change instead of patching
  findings one by one. A gate that reads only the mini hid a red CI for a whole wave.
- **Changed.** Deny-by-default agent sessions; `agent.json` and the base policy in the fingerprint.
- **Friction.** Host load from parallel fleets (40–200) forced reruns of every merge; a host-wide
  `pkill` by a lead may have hit another fleet's test run (kills are scoped to a PID from now on).
- **Spend.** Team key ≈ $4.64; personal key for deploy verification only.
- **Does the page hold?** Yes. P2's model/effort question moves into Wave 6 (Sonnet angles).
