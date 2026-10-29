# agent-workflows — build plan

**Goal:** every repetitive agent job runs as a workflow on this platform, verified live on the mini;
Claude Code and Hermes reach it only through `agw`; research-gateway, audio-gateway and agent-gateway are
retired and archived, `agw-legacy` included (concept §11, P1–P6; dispatch is unused, owner 2026-10-29).
**Gate (every wave):** `make check` green; the review flow in `AGENTS.md` done for every merged
change; deployed on the mini and proven live by `@verifier`; a retro entry in `docs/concept.md`.
**Fleet:** mother (Opus/high) → lead (Opus/high) → workers by model class (`AGENTS.md` §The fleet).
**Budget:** Max for every Claude session. IU for agent steps, `/review` and `/research`: spend what
the work needs, tagged `purpose=build`, report the figure in each retro. OCR stays off.
**IU constrained (owner, 2026-10-28):** the DeepSeek provider behind the IU endpoint is out of
balance. Until lifted: no gateway `/review` in the fleet (the lead's `/code-review high` on Max is the
review step); interim tests and evals use the Athena teamchat team key, kept out of this repo; routes
fall back to GPT-6.1 Terra at medium effort on a provider-balance failure; the ported `review`
degrades to "review in-session" on a balance failure.
**Scope (owner, 2026-10-29):** individual workflows only need to work properly — parity and
correctness, verified live. No tuning, experiments or quality rounds beyond that; big per-workflow
reworks (review especially) come later, outside this plan.
**Regions (owner, 2026-10-29):** EU runtime does not matter; routes are chosen by availability, cost
and quality, never pinned to EU variants.
**Review OCR (owner, 2026-10-29):** paused open-ended (`AGW_REVIEW_OCR=0`, default off) until the owner
re-enables it; not tied to the wallet gate's date.
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

## Wave 2 — Core runtime (P1a)            <!-- status: done -->
Workers: Opus/medium for runtime and middleware, Sonnet/high for routes and capabilities.

- [x] `defineWorkflow`, the three step kinds, journal and resume, effect keys, bounded-run rule;
  a replay test that crashes after every step. Closes S1's "Wave 2 must" list
  (`docs/spikes/s1-runtime/REPORT.md`): lease off the shared pool, 64-bit lock keys, retry policy,
  idle-rule step timeout, cancel/steer, concurrency limits, recovery tick, a lint for the step-id
  authoring rule; the kill harness stays as a regression test with concurrent runs
- [x] Middleware pipeline with the interception points `run/pre … run/post` (`runPre` carries a
  `resume` flag); run record and fingerprint, every run tagged with its `purpose`. S2's inputs: the
  middleware owns flush (crash handlers, signal re-raise), tokens from the OpenCode message API, Argo
  rows from an outbox
- [x] Route table (model + effort per route) — becomes the home of model ids; cost from `usage.cost`
- [x] `defineCapability` + registry (import, HTTP, CLI from one zod definition); first capabilities
  `llm.summarize|title|classify`, `decide`
- [x] Runaway caps and the wallet gate as middleware rules, both tested
- [x] Fleet tooling (dotfiles, Sonnet/high): the merge train installs before `make check` (or `make
  check` installs itself) and handles draft PRs; `rd wave` treats taken agent names as taken numbers
- [x] Investigation (Sonnet/high, parallel, report only): isolate the OpenCode 2.0.32 prompt wedge (S2,
  6/6) — replay the dotfiles spike script verbatim, bisect env/cwd/HOME; Wave 3's host design takes
  the cause as input
**Left behind:** all seven landed, reviewed (`--deep` + lead `/code-review high` on runtime, middleware,
limits), `make check` 257 tests green, CI green. `@verifier` on the mini against `agent_workflows`:
record, resume-without-re-run, spans (in-script receiver: local ClickStack was down), Argo rows (dry),
limits wired; the one FAIL (unpriced IU route) fixed by PR #11. The OpenCode "wedge" was the file-watcher
boot: `OPENCODE_DISABLE_FILEWATCHER=1`. Full evidence: `docs/waves/handoff/lead.md` at `5721ad7`.
Not ours, noted: agent-gateway restarted twice mid-review; IU `/models` times out ~1/3 of calls.
Known gaps carried in the package READMEs: >100K-token price tier unmodelled (`unknown` cost), limits'
admission burst overshoot and uncounted SIGKILLed usage.

## Wave 3 — CLI, agent host, deploy (P1b)            <!-- status: done -->
Workers: Opus/medium for the CLI generator and OpenCode re-attach, Sonnet/high for the rest.

- [x] `agw` generated from OpenAPI + `x-cli` (spike-7 runner as reference): exit codes, typed errors,
  `pending` → resume, `schema`, `contract_mismatch`, a conformance suite
- [x] OpenCode host: locations compiled outside any repo, warm/evict, sessions re-attached after a
  restart, DeepSeek wire rules on cheap routes (concept §8). Inputs from the wedge report:
  `OPENCODE_DISABLE_FILEWATCHER=1`, liveness via `GET /api/info` plus the idle watchdog, SIGTERM then
  SIGKILL, re-attach by session id; concept §8's wedge risk rewritten as resolved (version note)
- [x] agent-gateway's CLI renamed `agw-legacy` (its repo, one commit), every caller of today's `agw`
  swept to it; the new `agw` on PATH
- [x] LaunchAgents (`host` process: registry HTTP with bearer auth, fail closed; `AGW_MACHINE` set),
  `make deploy|verify`, Kuma heartbeat, dotfiles architecture map and herdr groups entry; `make check`
  installs its own deps
- [x] Fleet tooling (dotfiles, Sonnet/high): `rd say` verifies the agent left `idle/done` and dismisses
  known modals (the "compact earlier" modal swallowed messages in Wave 2)
- [x] Moved to Wave 4 (owner-gated): telemetry and usage live, and the end-to-end proof
**Left behind:** CLI, host, OpenCode host, deploy tooling (release dirs + rollback), `agw-legacy` rename
with its sweep across five repos, `rd say` delivery check: all merged and reviewed, `make check` 450
tests green. **Not deployed:** `make deploy` fails closed in preflight on the missing
`op://mini/agent-workflows/*` item; owner request `20261028T005518-15306` is queued (MacBook
unreachable all night). Nothing on the mini changed; today no `agw` is on PATH (`agw-legacy` is).
The deploy chain is Wave 4's first item, in the order in `docs/waves/handoff/lead.md` at `5fea43e`.
IU/DeepSeek "Insufficient Balance" since ~04:05 removed the review's cross-family critic; lead
`/code-review high` on Max stood in (owner top-up already queued by another fleet).

## Wave 4 — Review and check cut over (P1c)            <!-- status: done -->
Workers: Haiku to extract past runs, Sonnet/high to port, Opus/medium for the comparison harness.

- [x] **Owner-gated, carried from Wave 3:** once request `20261028T005518-15306` is answered — refs in
  `headless.refs`, reseal, `make deploy`, `make verify`, `@verifier` (run record, spans in ClickStack on
  the VPS tier, usage row in Argo, CLI end to end), dotfiles PR #34 merged. Retry the push between
  steps; every step below that needs no live host proceeds meanwhile
- [x] Direct capability calls (`agw llm title` outside a run) recorded like runs — a one-step run or
  a usage record into the journal and Argo — so N6 holds before review and check call them
- [x] Route fallback on provider-balance failures (GPT-6.1 Terra, medium effort), concept version note;
  the team key on the mini for interim tests and evals (untracked env, never in git)
- [x] IU key label (usage-tracker contract, 2026-10-28): top-level `iu_key: 'personal' | 'athena-team'`
  on every Argo row with `billing='iu'` (null otherwise), never in `raw`, never `account` (that is the
  Max account id); from a non-secret env `IU_KEY_ID` next to `IU_API_KEY`, default and fallback
  `personal`; OpenCode servers stamp it from their own start env (`serverEnv` forwards it)
- [x] Eval sets for review and check from recorded agent-gateway runs (findings, cost, wall time)
- [x] `review` and `check` ported as workflows, depth gating included, OCR behind the wallet gate
- [x] Side-by-side against agent-gateway on the eval sets: not worse on findings, cost, wall time
- [x] `/check` and `/review` skills switched; agw MCP `check` and `review` tools removed;
  from here the fleet reviews with the new `agw review`
**Left behind:** every step done; master `fd03b01` deployed, `make verify` PASS, 769 tests. Side-by-side
not-worse: check 7/7 on reproducible trees, review on 20 cases paired against a legacy rerun (recorded
findings were no baseline: legacy's own rerun recovered 0 % of its recorded blockers). `/check` and
`/review` run on `agw` (dotfiles #38); agent-gateway's MCP `check`/`review` removed (#37). Route fallback
and the `iu_key` label live; fallback has not fired yet. Open: review angles lack legacy's read-only
shell (Wave 5's experiment tests it); the adversary dominates review wall time (200–550 s); `agw schema
review` output untyped; harness `--resume` takes a bare path; 11 unpriced calls; Argo must accept
`iu_key` (usage-tracker's side). Full evidence: `docs/waves/handoff/lead.md` at `8581501`.

## Wave 5 — Evals and self-improvement (P2)            <!-- status: done -->
Workers: Opus/medium for scorers and compare statistics, Sonnet/high for the rest.

- [x] Scorer API used three ways (inline gate, regression, sampled drift); `agw eval run|compare`
- [x] Friction counters incl. the repeat-tool nudge (3, 5, 8); threshold → a GitHub issue with evidence
- [x] Retrospective workflow (weekly per workflow) and the per-agent learnings store
- [x] First experiment on review: one model or effort question answered with numbers (started by the
  owner's direct ask: angle variants baseline / callers / read-only shell on the 20 paired cases).
  Answer: neither changes findings (3 arms × 20, inside baseline noise); next question: Sonnet angles
- [x] Eval sets get a reproducibility check first (self-agreement of reruns) before they count as a baseline
- [x] Wave 4 leftovers (Sonnet/high): `agw schema review` output typed; harness `--resume` resolves a
  timestamp under the reports dir; the 11 unpriced calls explained or priced; `roles/worker.md` gains
  "never end a turn on a background shell"
- [x] Cleanup: the experiment's `angleVariant`/`repoShell` removed; OpenCode agents deny webfetch,
  websearch and subagent by default (a security gap the eval runs exposed)
**Left behind:** all merged (#23–#27); master `85b326f` deployed, `make verify` PASS, `@verifier` 6/6.
Scorers with `agw eval run|compare`, friction counters and threshold issues, weekly retrospective and
learnings store, reproducibility check, deny-by-default OpenCode sessions (webfetch/websearch/subagent),
`agent.json` and the base policy in the run fingerprint. The experiment changed no findings (callers,
read-only shell): a prompt/tool answer, not yet the model/effort answer P2's gate asks for — Sonnet
angles carried into Wave 6. **CI on master red since `fd03b01`** on two Linux-only tests (one may be a
real credential leak on Linux): the merge train gated on the mini's `make check` only. Team key ≈ $4.64.
Evidence: `docs/waves/handoff/lead.md` at `f562b05`.

## Wave 6 — Research (P3a)            <!-- status: done -->
Workers: Opus/medium for the comparison design, Sonnet/high for the port.

- [x] **First:** CI green on master — the Linux-only failures fixed at their cause (`credentials of the
  host never reach make check` may be a real leak: treat as security), `run-step` idle kill; the merge
  train gates on CI as well as on the mini's `make check` (dotfiles); load-aware test timeouts
  (done: #28, dotfiles #39; not a leak — make recursion state, `run-step.sh` under dash)
- [x] P2's gate: Sonnet angles vs today's on the 20 paired review cases (`agw eval run|compare`, ≈ $5).
  Answer: recall 0.017 → 0.13, located +0.09, cost 9.4×. Decision (mother): Sonnet angles for `--deep`
  reviews only, Haiku stays the default
- [x] Three-way comparison on research-gateway's 28 golden questions: code-led pipeline vs pure
  agent vs agent on the pipeline, yolo vs focused — correctness, cost, wall time.
  Decided by the pre-registered rule: pure agent, yolo — supported +0.185 [0.065, 0.321] vs the engine,
  golden level held, $0.028 vs $0.138 per question, p50 39 s vs 171 s; 420/420 runs, team key $12.57
- [x] `research` ported in the winning shape, follow-up on a finished report included
- [x] `/research` switched; research-gateway's `/mcp` deleted and its MCP registration removed
**Left behind:** all done; release `0c360db` on the personal key, `make verify` PASS, `@verifier` 8/8, CI
green and gating the train. Research is one OpenCode agent with the platform's web tools in the host
process; `/research` runs on `agw research`; research-gateway's `/mcp` deleted (live 404), its MCP
registration removed on the mini (MacBook: ask-human `20261029T033409-656` queued). Review angles on
Sonnet for caller-asked deep reviews. Team key $26.13. Carried: CONTEXT7_API_KEY still resolves via
research-gateway's 1Password item (move before P6); engine columns 0007/0008 kept for rollback (drop
later, expand/contract); CLI's synchronous answer lacks final cost; one sleep-synchronised test left.
Evidence: `docs/waves/handoff/lead.md` at `57ef3ab`.

## Wave 7 — otel, brain, diagram, prose (P3b)            <!-- status: done -->
Workers: Sonnet/high.

- [x] `otel` workflow with `hdx` as a capability (HyperDX HTTP API, no MCP); cost per query recorded
- [x] `brain` agent shared by workflows; `diagram` (excalidraw) ported
- [x] `prose`: lint + cross-lab review + keep gate as a workflow; the rewrite in the calling session on Max
- [x] `/otel`, `/excalidraw-diagram`, `/prose` switched; their agw MCP tools removed
- [x] Wave 6 leftovers (Sonnet/high; the CONTEXT7 move carried to Wave 8, owner-gated): the CLI's synchronous answer carries the final cost; the last
  sleep-synchronised test (`opencode-host` abort) on an in-flight signal; `rd fan --clean` scoped to the
  fleet's own worktrees (dotfiles); CONTEXT7_API_KEY moved off research-gateway's 1Password item
**Left behind:** all four ports passed their pre-registered rules (`docs/research/2026-10-29-wave7-ports.md`);
release `adc586d` on the personal key, `make verify` PASS, `@verifier` 11/11. `/otel`, `/excalidraw-diagram`,
`/prose` run on `agw`; their agw-legacy MCP tools removed. Concept v3.7. Carried: CONTEXT7 move (owner
request `20261029T070930-17518`, MacBook unreachable); `clickstack_sql` stays CLI-only until proven
read-only; legacy `research/gate.json` and agent-gateway routing rows go in P6; workers ran `agw review`
three times against the owner direction ($0.46). Evidence: `docs/waves/handoff/lead.md` at `f8671d5`.

## Wave 8 — Audio, image, podcast (P4a)            <!-- status: done -->
Workers: Sonnet/high; Opus/medium for the pipeline's durable stages.

- [x] **First:** workflows, eval suites and routes register by directory (or one entry per file), so
  parallel ports stop colliding in shared registry files; the load-scaled test timeout sampled per test
- [x] CONTEXT7_API_KEY: field created and resealed (owner request `20261029T080529-10120`); swap the
  `.env.tpl` ref and deploy
- [x] Audio pipeline as a workflow in its own process; an OpenAI-compatible TTS/STT door for Hermes
- [x] `podcast` (writers' room, TTS, mastering, publish) and `image` ported
- [x] `/podcast`, `/img`, Hermes TTS/STT switched; one episode produced end to end on the new path
- [x] The TTS/STT door serves every audio caller, not only Hermes: iris (its own fleet switches it)
  (argo moved to Wave 9); the contract (endpoints, auth, env names) sent to iris-mother
- [x] All review off Max (owner, 2026-10-29): agent-gateway's review routes lose their `claude -p` Max
  fallback now; its review tool refuses with a pointer to `agw review` once iris (its last caller) has
  switched to `agw review --pr N`; review OCR off by default (`AGW_REVIEW_OCR=0`)
- [x] `triage` ported as-is for iris (schema-constrained call: destination + transcript excerpt + reply →
  {headline ≤60, detail ≤240, spoken ≤2 sentences}); `triage` and `decide` cancel, attribute the caller,
  return usage + `cost_usd`, never route via Requesty; contract sent to iris-mother (unblocks iris Wave 17)
**Left behind:** every step done and live; release `927dc85`, `make verify` PASS, `@verifier` 10/10, CI green.
Registration by directory; audio process with an OpenAI-compatible door (Hermes and iris on it); `image`,
`podcast` (two episodes, rule passes on the second) and `triage` ported; `/img`, `/podcast`, Hermes TTS/STT
switched. iris no longer calls agent-gateway or audio-gateway at runtime (its Wave 16). All review off Max:
agent-gateway's review lost its Max fallback and now refuses with a pointer to `agw review`; review OCR
off unless `AGW_REVIEW_OCR=1` (owner-gated). Spend ≈ $6.1 team key, ≈ $0.02 personal (+ ElevenLabs/Gemini
for two episodes). Carried: Requesty and EU route sweep, caller identity beyond `x-agw-purpose`, two
CI flakes in runtime tests, judge calibration shifted by `decide`'s model move (no re-tuning), fan tabs
for `rd reap`. Evidence: `docs/waves/handoff/lead.md` at `bdcd841`.

## Wave 9 — Usage (P4b)            <!-- status: done -->
Workers: Sonnet/high.

- [x] Usage projection from run records into Argo's usage ingest
- [x] Wave 8 leftovers: the two runtime CI flakes (lease-grace clock comparison, `toolPre` sleep-as-sync)
  fixed at their cause; fan tabs reaped (`rd reap`)
- [x] Route table without region pinning: EU-only model ids re-pointed to the best available ids on
  the endpoint (probe + header check per route), prices updated, one `make verify`
- [x] Usage rows correct (argo audit 2026-10-29): 99 review rows unpriced (`cost_source=none`, Haiku/Sonnet EU
  routes) priced; reasoning tokens checked not to be counted inside output too (fresh tokens double
  counted otherwise); every row carries its caller/project (`agw` CLI session, iris, Hermes, eval) so
  spend is attributable per caller
- [x] ~~argo's `/ai` audio proxy on the new audio door~~ dropped (owner, 2026-10-29): argo needs no audio
  integration; the door-only listener built for it is deleted; argo's audio routes go with audio-gateway (Wave 11)
- [x] usage-tracker's research-gateway collector removed; its agent-gateway OpenCode/IU collectors stay until
  a full week of overlap exists (moved to Wave 11)
**Left behind:** release `f84fa7a`, `make verify` PASS. Argo projection matches the journal to $0.0001; usage
rows fixed (123 steps backfilled, $13.56; reasoning counted once; caller/project live: claude-code, iris,
host); route sweep done (no EU ids, review's four Requesty hops moved, long-prompt tier); runtime CI flakes
fixed at their cause; the argo bridge dropped and fully unwound. Kept on Requesty with the Terra fallback,
by decision (parity): research, otel, prose, podcast routes. Evidence: `docs/waves/handoff/lead.md` at `06f0af1`.

## Wave 10 — Claude Code and Hermes slimmed (P5)            <!-- status: done -->
Workers: Sonnet/high; Haiku for the sweeps.

- [x] Global CLAUDE.md, skills and the Makefile MCP registration per concept §10; agw MCP server deleted
- [x] Hermes scripts and skills call `agw`; narratives and overview ported as workflows
- [x] A sweep shows no skill, doc or script naming an MCP gateway tool
- [x] Tab hygiene: worker tabs closed right after merge; `herdr-reap.py` closes merged fan tabs even while
  a plan wave is active; the dispatch lane dropped from the global CLAUDE.md
- [x] Every runtime caller of the old gateways moved (inventory 2026-10-29): iris (`agw` jobs
  `triage`/`decide`, audio STT/TTS; its fleet does the switch, we port what it lacks), argo audio proxy,
  hermes-agent scripts (`overview`, `narrative`, `prose`, `/api/usage`) and skills (research, podcast,
  briefing TTS), dotfiles usage push, `wave-watch.sh` job polling, health checks and Caddy doors,
  modelpick (`agw routing`, a direct audio-gateway import), homelab Kuma monitors, warden's client
  (retired: archive or delete), stale `mcp__research-gateway__*` permissions in other repos
**Left behind:** all done and live; `make verify` PASS, `@verifier` PASS. Global CLAUDE.md and skills on `agw`,
the dispatch lane gone; agent-gateway's MCP server and Argo push deleted; Hermes scripts and skills on `agw`
(overview, narrative ported at parity); `agw routes`, `agw quota-report`, `agw agents` replace the legacy
reads; warden archived; herdr-reap closes merged fan tabs. No live MCP-gateway reference anywhere. Every
remaining caller is a Wave 11 retirement item (list in `docs/waves/handoff/lead.md` at `c30f318`).

## Wave 11 — Retire and hand over (P6)            <!-- status: active -->
Workers: Haiku for the sweeps, Sonnet/high for the rest.

- [ ] research-gateway, audio-gateway and agent-gateway retired: LaunchAgents removed, repos archived,
  `agw-legacy` CLI and its PATH link deleted; the `dispatch` lane removed everywhere (unused, owner 2026-10-29)
- [ ] argo's `/ai` audio proxy routes and dashboard audio calls deleted (no bridge; owner 2026-10-29)
- [ ] usage-tracker's agent-gateway OpenCode/IU collectors removed right after agent-gateway stops (they
  read its own store, so no overlap can accrue; Wave 9 proved journal = Argo); historical rows stay
- [ ] The last callers removed before the services stop (Wave 10 list): Hermes `dispatch` skill and the
  `brain-drift-audit` cron prompt, hermes-agent `make doctor` probe, dotfiles `install-cli`, `wave-watch.sh`
  job poll, `remote-dev.sh` hint, Caddy rows, devhost probes, Kuma pushes/monitors, modelpick's agent-gateway
  rows, the eval harness's legacy adapter, argo's `/ai` audio proxy (above)
- [ ] Architecture map and `make doctor` clean on the mini
- [ ] Final retro and `docs/factory-input.md`: what the factory re-plan can build on
**Left behind:**
