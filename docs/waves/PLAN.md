# Inference gateway, then review v2, its eval, central tiers and the maturity pass

**Goal:** every LLM call from the mini goes through one gateway that spends the Claude subscriptions' monthly API
credit first and records every request (Waves 1–4, design `docs/gateway.md`). Then the review is more effective while
cheaper and faster, measured by an eval that ranks models and pipeline variants on ground truth. The tier choices rest
on that data, and the gaps the 2026-10-31 audit found in accounting, telemetry, tests and docs are closed. Design:
`docs/review-v2.md`.
**Gate:** `make check`, `/review` on non-doc changes, `make deploy` + `make verify` after each wave, a live call per
changed route. Cross-repo changes pass that repo's own check. Own-repo pushes and deploys are routine.

Context (2026-11-01):

- **Gateway first** (owner, 2026-11-01): ~$400 a month of Claude API credit expires unspent, while agw's IU spend is
  over the personal key's $500 cap and runs on the Athena team key, which belongs to Athena Teamchat only. agw's seats
  move to Claude to spend the credit (Wave 3); the eval sweeps of Waves 7 and 9 then run mostly on credit. EU
  endpoints don't matter.
- **Gateway keys** (2026-11-01): `op://mini/claude-platform/{API,ADMIN}_KEY_{IU,ME,ME2}` are seeded on the mini. IU and
  ME resolve to real keys; ME2 holds a `REPLACE` placeholder until its 7-day claim window opens (~2026-11-02), so the
  `me2` pool stays disabled. Credit cycles (owner, from the Console Billing pages): `iu` credit expires 2026-11-21
  (`cycleDay` 21; payment day 18), `me` 2026-11-27 (`cycleDay` 27; payment day 24), `me2` unknown until claimed
  (payment day 27). The credit cycle is not the payment cycle: read it from the expiry shown in Billing. All three orgs: no payment method, monthly spend
  limit equal to the credit (owner, 2026-11-01), so a drained pool refuses instead of billing.
- The 2026-10-31 eval (`docs/evals/2026-10-31-review-claude-direct.md`) settled cost, wall time and failure modes per
  arm, but **cannot rank models**: its reference is a retired gateway's outcome. Lessons: `docs/evals/README.md`.
- **Review eval, owner answers (2026-11-01 19:30, via the software-factory program lead, on `docs/review-v2.md`):**
  (8) IU repos stay out of the eval cases. (9) The owner gives the two hours of labelling when Wave 6 reaches its owner
  session. (10) The native `/code-review` arm runs on Max as factory spawns; early is fine. Keep API spend on the
  review eval low: iterate on the Max subscriptions first, and start the API-priced sweeps of Waves 7 and 9 on a small
  `dev` slice before the full `test` set.
- Owner framing: greenfield, solo developer, optimal over compatible; the review pipeline may be reset.
- Tiers (owner, 2026-10-31): `FAST`, `EASY`, `HARD`, `DECIDE`. The picks Wave 3 sets and Wave 10 formalises stay
  provisional until Wave 9 measures the review. Other jobs keep provisional picks until their own evals exist.
- Audit (private numbers, outside the repo: `~/SourceRoot/agw-maturity-audit.md`). Findings carried below.

**Why the rework goes before the tiers.** A tier wave first would only relabel unmeasured picks, and the review is the
largest `HARD` consumer, so it would be redone after the sweep. The parts of the old tier and maturity waves that the
eval needs move into Wave 5. The rest waits.

## Wave 1 — Gateway spike and registry            <!-- status: done 2026-11-01, release 767f643 -->

- [x] **Passthrough spike** (`docs/spikes/gateway/`, excluded from tools): a minimal Bun proxy for `/anthropic/v1/messages`
  on the `iu` org's key (`op://mini/claude-platform/API_KEY_IU`). Replay a Claude-Code-shaped request (several
  `system` blocks, tools, `cache_control` with `ttl: 1h`, an `anthropic-beta` list) twice: the upstream bytes hash
  equal to the inbound bytes, the second call reports `cache_read_input_tokens` > 0, and the SSE tee parses `usage`
  from `message_start` / `message_delta` with no measurable TTFT cost. Streamed and non-streamed. Haiku only.
- [x] **Header probes.** Can an OpenCode provider (pinned build) send a per-session header, or does a step's session id
  reach the request any other way? Can Hermes' custom providers send extra headers? The answers decide OpenCode
  attribution (`docs/gateway.md` §Callers).
- [x] **Admin API probe** on the `iu` org if `ADMIN_KEY_IU` resolves: `analytics/cost` and `cost_report` for this month,
  grouped by API key; record whether a one-person org gets the Admin API, the lag, and the units. Missing key: say so.
- [x] **Registry.** The `platform` block (`docs/gateway.md` §Picking a pool) in `dotfiles/config/claude-accounts.json`,
  `iu` enabled, `me`/`me2` disabled until their refs exist; `docs/claude-accounts.md` documents it. Find out how
  `make secrets-seed` treats a ref that does not exist yet before adding refs to `dotfiles-private/headless.refs`.
- [x] `isBalanceFailure` (`packages/routes/src/balance.ts`) learns Anthropic's "credit balance is too low" refusal, with tests.
- [x] `docs/spikes/gateway/REPORT.md` with the verdicts; anything that contradicts `docs/gateway.md` is fixed there.
**Left behind:** close-out in `docs/waves/handoff/lead.md` at the Wave 1 commit; verdicts `docs/spikes/gateway/REPORT.md`. Wave 2 also
  builds §Picking a pool step 0 (Claude-Code-shaped requests skip the credit pools) and the 20–70 min cost-API lag
  rule (verify never waits on the cost API).

## Wave 2 — Gateway            <!-- status: done 2026-11-02, release b25aac5 -->

- [x] `packages/gateway` as `docs/gateway.md` describes: IU's path layout, byte-exact passthrough with the usage tee,
  model aliases from `packages/routes`, pools with the meter, session binding and expiry-first order, the IU fallback
  and `x-agw-fallback: none`, door-token callers, one span per request, usage rows through the outbox
  (`source='gateway'`).
- [x] usage-tracker migration: `billing` `api_credit`, `credit_cycles`, `gateway_picks`; its writer and readers accept them.
- [x] Deploy: a third LaunchAgent `com.jkrumm.agent-workflows-gateway` on 7794, health and rollback with the other two;
  a release that does not change the gateway does not restart it. `make verify`: gateway `/health`, a Haiku call through
  the `iu` pool lands an `api_credit` row with priced cost, a repeat call reads the cache, and an IU passthrough call
  lands an `api_key` row.
- [x] `packages/gateway/README.md`; AGENTS.md (processes, Validate/Deploy rows, gotchas) in the same commits.
**Left behind:** close-out in `docs/waves/handoff/lead.md` at `34ee3f2`. Wave 3 inherits: the host's `ANTHROPIC_API_KEY` is the
  iu credit key and spends outside the gateway until moved; agw's own usage prices 1 h cache writes as 5 m; concept v3.14
  (departures, port 7794) and the stale "402/503" at `docs/concept.md:337` and `docs/factory-input.md:17`. Wave 4: `stats
  --by account` mixes Max and `api_credit`. Flaky `packages/middleware/test/platform.test.ts` "concurrent runs" failed once on CI.

## Wave 3 — Callers move, seats onto Claude            <!-- status: done 2026-11-02, release 3e6026e -->

- [x] agw: every transport and OpenCode provider on the gateway with the `agw` door token and attribution headers.
  `iu-anthropic` becomes the `anthropic` wire (the gateway decides credit or IU). agw stops writing `usage.records` for
  gateway calls. `IU_KEY_ID`, `~/.config/agw/iu.env` and `athena-iu.env` leave agw: the gateway holds the `personal` key.
- [x] Seats onto Claude (owner, 2026-11-01), provisional until Waves 9–10: `TRIVIAL`/`EASY` → Haiku 5.5, `STRONG` →
  Sonnet 5.5, each with `x-agw-fallback: none` and a GPT-on-IU route fallback, so credit runs out into GPT, not into
  IU's Claude. A live call per changed route.
- [x] Hermes, dotfiles `oc` and modelpick on the gateway, each with its own door token; the `-eu` model ids go; Hermes
  vision moves to `anthropic_messages`.
- [x] Concept version note and retro entry for the gateway as built.
**Left behind:** close-out in `docs/waves/handoff/lead.md` at `9897cd9`. For the owner, not deleted: 34 duplicate
  `source='agent-workflows'` rows ($0.19, query in the close-out); `~/.config/agw/iu.env` and `athena-iu.env` on the mini
  (a pre-Wave-3 rollback reads `iu.env`); ≈ $9.3 team-key review spend before the deploy; Hermes now has no lane outside
  the gateway. Wave 4 inherits: Hermes liveness and `make verify` do not check the gateway door; `scripts/live-routes.sh`
  copies the alias map; triage reasoning tokens read 0 on the `anthropic` wire; flaky hook timeouts under load. `make
  verify` gains a smoke review (the reviewer broke unseen).

## Wave 4 — Reconcile and Argo            <!-- status: active -->

- [ ] usage-tracker pass: `usage.platform_cost` from each org's cost API (admin key; a missing key skips that org), and
  `credit_cycles` closed per cycle with metered, reconciled and unspent. The gateway's meter takes the reconciled
  figure when higher.
- [ ] Argo: payers `iu-credit`, `me-credit`, `me2-credit`; a Credits tab (burn-down per pool against its cycle,
  projected unspent, picks and fallbacks, cache-hit rate per caller); `accounts.ts` says `iu` is Ultra.
- [ ] Docs to the new shape: dotfiles `docs/architecture.md`, `docs/agent-platform.md`, `docs/claude-accounts.md` (`me2`
  is live), `config/global.CLAUDE.md` (the IU-tokens line names the gateway), brain `wiki/engineering/model-routing.md`
  (the gateway; the retired `ca`/`cap`).

## Wave 5 — Eval foundations            <!-- status: pending -->

Disjoint changes, one fan-out batch:

- **Run-scoped overrides.** `agw eval run --arm <file>`, where an arm is `{ routes?: patch, params?: {...} }`. It is
  layered over the table for that run and its children only, and recorded in the input and the fingerprint. Workflows
  read params with a default. Removed: `AGW_ROUTES`, `~/.config/agw/routes.json` and their handling in
  `scripts/launch.sh`.
- **Eval cost rolls up.** Case replays become children of `eval.run`, so its `cost` is their sum (today null).
- **Structured agent output.** Agent steps return JSON through a tool call or a structured final turn, not through
  `parseStructured` on free text.
- **Schema output on the `anthropic` wire** (Wave 3): `output_config.format` json_schema from the capability's zod type
  via `z.toJSONSchema`; zod parse stays as the last check. The OpenAI wire moves from `json_object` to `json_schema`
  where IU supports it. Sonnet guard: effort `none` on a Sonnet route is a config error. Spend is the gateway's rows.
- **One model id per model** (normalise provider-echoed ids) and the route id on every step, so reports group by route.

## Wave 6 — Ground truth            <!-- status: pending -->

- `agw eval mine review`: SZZ over `~/SourceRoot` with the filters in `docs/review-v2.md` §Ground truth, two
  cross-vendor labeler calls per candidate, clean controls, the `dev`/`test` split. Cases go only under `$AGW_EVAL_DIR`.
- `eval.judge` on its own pinned route, scorer v3 (recall, false alarms, noise, severity calibration), and `agw eval
  import` for an external arm's findings. The token-overlap matcher only preselects pairs.
- **Owner session (owner decision 2):** confirm 70 mined cases and label 100 judge pairs. Bars: accepted cases ≥ 90 %
  right, judge κ ≥ 0.8. Below either, tighten the filters or add a second judge.
- Target 200 bug cases and 100 controls. Seeded defects only below 150.

## Wave 7 — Baseline            <!-- status: pending -->

- Today's pipeline (v1) on the full `test` set and the controls, on its live seats: the first real numbers.
- Native `/code-review high` on 60 `test` cases through herdr-core sessions (owner decision 3).
- **OCR arm** (owner, 2026-11-02: OCR stays off until measured). `alibaba/open-code-review` (pinned v1.13.3) on the
  `test` set and the controls, on Haiku 5.5 and Sonnet 5.5 through the gateway (its own door token, so its spend is
  priced for the first time) and on Terra: recall, false alarms, cost and wall per arm. Wave 9 keeps OCR only as an
  arm that beats v2 on recall beyond the CI at a cost the owner accepts; otherwise its deletion stands.
- Committed report `docs/evals/<date>-review-baseline.md`. It sets how much headroom v2 has to beat.

## Wave 8 — Review v2            <!-- status: pending -->

- The pipeline in `docs/review-v2.md`: prepare, finders, group, verify vote, assemble, ledger. Levels
  `quick|standard|deep`, `REVIEW.md` loading, REVIEW_OUTPUT v3, re-review diff-only, `stepBack` from round 3,
  `agw review dispose`.
- Built beside v1 as workflow `review-v2`, so Wave 9 can compare both. Prompts iterate on `dev` only.
- The `/review` skill rewritten for v3: the fix loop, dispositions, `stepBack`. Every other caller moves to v3 here.
- The stale lines in `docs/review-v2.md` §Docs to fix are fixed.

## Wave 9 — Arm sweep and cutover            <!-- status: pending -->

- v2 variants on `test` with run-scoped arms: finders 1, 3 or 5; K 1 or 3; voters as agent steps or single calls; seats
  on GPT or Claude per stage. The decision rule is in `docs/review-v2.md` §Metrics.
- The pick becomes `review`. Deleted: v1, the 12 angle agents, the router, the adversary, synthesis, OCR (and
  `review.ocr`), react-doctor inside review, and the 138 legacy review cases. A concept version note says why.
- Committed report. The review's seats give the measured `HARD` and `EASY` picks. The `--deep` native merge in
  `/review` stays only if the native arm beat v2's `deep` on recall beyond the CI.
- `REVIEW.md` seeded in the five busiest repos.

## Wave 10 — Central tiers            <!-- status: pending -->

Provisional picks (2026-10-31, from cost, wall time, failure modes and the AA index). Wave 9 replaces `HARD` and
`EASY` with measured ones. Since 2026-11-01 Claude seats run on credit while a pool has it
(Wave 3), so a Claude pick costs nothing up to ~$400 a month: the sweep weighs that, not list price:

| Tier | Primary | Fallback (other vendor) | Why |
|-|-|-|-|
| `FAST` | Haiku 5.5, effort `none`, direct single call | Luna low (IU) | same price as Luna ($0.10 / $0.50), higher index, 36 s per review-sized load without thinking |
| `EASY` | Haiku 5.5, effort `high` | Terra low (IU) | the only Haiku effort whose verdicts move; $0.15 per deep review; 10x cheaper tokens than Terra |
| `HARD` | Terra medium (IU) | Sonnet 5.5 low (direct) | decisive, $0.43 and 83 s per deep review; Sonnet low is as fast and cheap as DeepSeek |
| `DECIDE` | `decision-1` (IU decision API) | none | unchanged |

- `packages/routes/src/table/_shared.ts`: the four tiers with their fallbacks. Routes spread a tier and nothing else;
  the per-route effort and output-limit overrides (podcast.write, image.enhance, the agents' `maxOutputTokens`)
  become tier properties or go. A guard test fails a route that names a model. The eval judge is the one exception:
  its own pinned route, by design.
- DeepSeek flash leaves the primaries; Haiku `max` and `low` are out for agent steps. Research and otel move to `HARD`.
- Picks recorded in `modelpick/docs/decisions/agw-text-seats.md`; a live call per tier after deploy.
- Research's 28 cases get a golden-answer check.

## Wave 11 — Accounting and telemetry            <!-- status: pending -->

- Failed agent steps keep their tokens and cost (lost today, mostly on compaction overflow).
- `cost` null means unknown only; free steps record 0. Door errors (`door.speech` HTTP 400/503) are run failures, not
  `done`.

## Wave 12 — Harness robustness            <!-- status: pending -->

- Compaction overflow: an output limit for the compaction summary, or a context budget per agent step, so a long
  exploration ends with a result instead of a failed step.
- The runaway cap (wall 10x p95, cost 10x p95), reviewed against the deep reviews it has killed and against v2's new
  p95.
- Review convergence sub-eval: a fix loop over 20 `test` cases (review, fix, diff-only re-review) measuring
  rounds-to-pass and the share of late findings on old code, next to rounds-to-pass from real dispositions.

## Wave 13 — Coverage and debt            <!-- status: pending -->

- Eval cases and a scorer for the uncovered workflows (narrative, overview, prose-polish, image-icon, retrospective,
  podcast) and scorers for speech and transcriptions.
- Test fakes consolidated into `packages/testing` (they live in four packages today).
- Dead code: `IU_ANTHROPIC_BASE` in `packages/opencode-host/src/server.ts`, Claude leftovers the tiers make obsolete.
- Docs: concept notes and `otel.ts` comments brought to the code.
