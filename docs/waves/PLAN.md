# agent-workflows — build plan

**Goal:** every repetitive agent job runs as a workflow on this platform, verified live on the mini;
Claude Code and Hermes reach it only through `agw`; research-gateway and audio-gateway are archived
and agent-gateway is down to `dispatch` (concept §11, P1–P6).
**Gate (every wave):** `make check` green; the review flow in `AGENTS.md` done for every merged
change; deployed on the mini and proven live by `@verifier`; a retro entry in `docs/concept.md`.
**Fleet:** mother (Opus/high) → lead (Opus/high) → workers by model class (`AGENTS.md` §The fleet).
**Budget:** Max for every Claude session. IU for agent steps, `/review` and `/research`: spend what
the work needs, tagged `purpose=build`, report the figure in each retro. OCR stays off.
**Stops:** only the four in `roles/mother.md`.

Outside this repo: **P0 (warden off)** runs as dotfiles Wave 1, orchestrated from the owner's main
session. Nothing here edits dotfiles until `dotfiles/docs/waves/PLAN.md` shows it `done`.

## Wave 1 — Foundations            <!-- status: done -->
Workers: Opus/medium for S1, Sonnet/high for the rest. Spikes live in `docs/spikes/<id>/` with a
`REPORT.md` verdict; spike code is thrown away, not promoted.

- [x] **S1 workflow runtime:** our own journal on Postgres vs Vercel Workflow (`workflow` package) on
  Bun vs DBOS TypeScript. Fake agent step (no IU). Kill the process after every step and on deploy;
  measure resume correctness, effect-key behaviour, re-attach to a long step, lines of code, deps.
  Library facts via `/research` first.
- [x] **S2 telemetry:** run span + step span from a Bun process into ClickStack (local collector),
  `traceparent` in and out, one run record shaped for Argo's usage ingest; does OpenCode 2 emit its
  own OTel, and does it survive the current version.
- [x] **S3 stack:** HTTP framework with OpenAPI emission from zod (oRPC vs Elysia vs Hono +
  zod-openapi), test runner, lint/format — `/research` with current versions; pick what makes the
  spike-7 CLI generator and typed workflows simplest.
- [x] **P0b Postgres** (vps repo): the mini's local Postgres becomes a maintained instance — roles and
  schemas via `setup-postgres.sh` as on the VPS, nightly backup to the HomeLab, restore drill,
  upgrade target, heartbeat component, database `agent_workflows` with its own role; whole-DB
  `sync-from-prod` retired for `pg-sync-schema`; the stray brew `postgresql@18` default instance resolved.
- [x] **Scaffold:** Bun workspaces, `make check|deploy|verify` skeletons, CI on GitHub-hosted runners,
  AGENTS.md Validate/Deploy/Verify filled.
- [x] **Concept v3.1:** spike verdicts folded into `docs/concept.md` with a retro entry.
**Left behind:** all six landed and reviewed; full evidence in `docs/waves/handoff/lead.md`
(Wave 1 section, kept in git history). Verdicts: own journal on Postgres; telemetry shape holds; oRPC
1.16.1 + zod 4, bun test, Biome + oxlint, TS 7; P0b live (`agent_workflows` DB and role, nightly
backup with restore drill, `com.jkrumm.vps-pg-backup` mapped); scaffold with `make check` and CI.
The brew `postgresql@18` on :5433 is weatherorb's, not stray: kept. Concept v3.1. Not ours and left
red: dotfiles architecture-check rows for `com.iu.athena-postgres`, `com.iu.teamchat-*`, collie pin,
tailscale drift. Housekeeping noted, not done: Docker leftovers `p0b-postgres_*` (no Makefile target),
an unrestorable test backup `20261027T165644Z` (retention ages it out), unowned role `modelpick`.

## Wave 2 — Core runtime (P1a)            <!-- status: active -->
Workers: Opus/medium for runtime and middleware, Sonnet/high for routes and capabilities.

- [ ] `defineWorkflow`, the three step kinds, journal and resume, effect keys, bounded-run rule;
  a replay test that crashes after every step. Closes S1's "Wave 2 must" list
  (`docs/spikes/s1-runtime/REPORT.md`): lease off the shared pool, 64-bit lock keys, retry policy,
  idle-rule step timeout, cancel/steer, concurrency limits, recovery tick, a lint for the step-id
  authoring rule; the kill harness stays as a regression test with concurrent runs
- [ ] Middleware pipeline with the interception points `run/pre … run/post` (`runPre` carries a
  `resume` flag); run record and fingerprint, every run tagged with its `purpose`. S2's inputs: the
  middleware owns flush (crash handlers, signal re-raise), tokens from the OpenCode message API, Argo
  rows from an outbox
- [ ] Route table (model + effort per route) — becomes the home of model ids; cost from `usage.cost`
- [ ] `defineCapability` + registry (import, HTTP, CLI from one zod definition); first capabilities
  `llm.summarize|title|classify`, `decide`
- [ ] Runaway caps and the wallet gate as middleware rules, both tested
- [ ] Fleet tooling (dotfiles, Sonnet/high): the merge train installs before `make check` (or `make
  check` installs itself) and handles draft PRs; `rd wave` treats taken agent names as taken numbers
- [ ] Investigation (Sonnet/high, parallel, report only): isolate the OpenCode 2.0.32 prompt wedge (S2,
  6/6) — replay the dotfiles spike script verbatim, bisect env/cwd/HOME; Wave 3's host design takes
  the cause as input
**Left behind:**

## Wave 3 — CLI, agent host, deploy (P1b)            <!-- status: pending -->
Workers: Opus/medium for the CLI generator and OpenCode re-attach, Sonnet/high for the rest.

- [ ] `agw` generated from OpenAPI + `x-cli` (spike-7 runner as reference): exit codes, typed errors,
  `pending` → resume, `schema`, `contract_mismatch`, a conformance suite
- [ ] OpenCode host: locations compiled outside any repo, warm/evict, sessions re-attached after a
  restart, DeepSeek wire rules on cheap routes (concept §8)
- [ ] agent-gateway's CLI renamed `agw-legacy` (its repo, one commit); the new `agw` on PATH
- [ ] LaunchAgents (`host` process), `make deploy|verify`, Kuma heartbeat, dotfiles architecture map
  and herdr groups entry
- [ ] One trivial workflow end to end, proven live: run record, spans, usage
**Left behind:**

## Wave 4 — Review and check cut over (P1c)            <!-- status: pending -->
Workers: Haiku to extract past runs, Sonnet/high to port, Opus/medium for the comparison harness.

- [ ] Eval sets for review and check from recorded agent-gateway runs (findings, cost, wall time)
- [ ] `review` and `check` ported as workflows, depth gating included, OCR behind the wallet gate
- [ ] Side-by-side against agent-gateway on the eval sets: not worse on findings, cost, wall time
- [ ] `/check` and `/review` skills switched; agw MCP `check` and `review` tools removed;
  from here the fleet reviews with the new `agw review`
**Left behind:**

## Wave 5 — Evals and self-improvement (P2)            <!-- status: pending -->
Workers: Opus/medium for scorers and compare statistics, Sonnet/high for the rest.

- [ ] Scorer API used three ways (inline gate, regression, sampled drift); `agw eval run|compare`
- [ ] Friction counters incl. the repeat-tool nudge (3, 5, 8); threshold → a GitHub issue with evidence
- [ ] Retrospective workflow (weekly per workflow) and the per-agent learnings store
- [ ] First experiment on review: one model or effort question answered with numbers
**Left behind:**

## Wave 6 — Research (P3a)            <!-- status: pending -->
Workers: Opus/medium for the comparison design, Sonnet/high for the port.

- [ ] Three-way comparison on research-gateway's 28 golden questions: code-led pipeline vs pure
  agent vs agent on the pipeline, yolo vs focused — correctness, cost, wall time
- [ ] `research` ported in the winning shape, follow-up on a finished report included
- [ ] `/research` switched; research-gateway's `/mcp` deleted and its MCP registration removed
**Left behind:**

## Wave 7 — otel, brain, diagram, prose (P3b)            <!-- status: pending -->
Workers: Sonnet/high.

- [ ] `otel` workflow with `hdx` as a capability (HyperDX HTTP API, no MCP); cost per query recorded
- [ ] `brain` agent shared by workflows; `diagram` (excalidraw) ported
- [ ] `prose`: lint + cross-lab review + keep gate as a workflow; the rewrite in the calling session on Max
- [ ] `/otel`, `/excalidraw-diagram`, `/prose` switched; their agw MCP tools removed
**Left behind:**

## Wave 8 — Audio, image, podcast (P4a)            <!-- status: pending -->
Workers: Sonnet/high; Opus/medium for the pipeline's durable stages.

- [ ] Audio pipeline as a workflow in its own process; an OpenAI-compatible TTS/STT door for Hermes
- [ ] `podcast` (writers' room, TTS, mastering, publish) and `image` ported
- [ ] `/podcast`, `/img`, Hermes TTS/STT switched; one episode produced end to end on the new path
**Left behind:**

## Wave 9 — Usage (P4b)            <!-- status: pending -->
Workers: Sonnet/high.

- [ ] Usage projection from run records into Argo's usage ingest
- [ ] usage-tracker's agent-gateway, research-gateway and agw-OpenCode collectors removed; Argo
  totals reconciled for one week of overlap
**Left behind:**

## Wave 10 — Claude Code and Hermes slimmed (P5)            <!-- status: pending -->
Workers: Sonnet/high; Haiku for the sweeps.

- [ ] Global CLAUDE.md, skills and the Makefile MCP registration per concept §10; agw MCP server deleted
- [ ] Hermes scripts and skills call `agw`; narratives and overview ported as workflows
- [ ] A sweep shows no skill, doc or script naming an MCP gateway tool
**Left behind:**

## Wave 11 — Retire and hand over (P6)            <!-- status: pending -->
Workers: Haiku for the sweeps, Sonnet/high for the rest.

- [ ] research-gateway and audio-gateway LaunchAgents removed, repos archived; agent-gateway down to `dispatch`
- [ ] Architecture map and `make doctor` clean on the mini
- [ ] Final retro and `docs/factory-input.md`: what the factory re-plan can build on
**Left behind:**
