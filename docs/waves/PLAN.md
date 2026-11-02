# Inference gateway, then review v2, its eval, central tiers and the maturity pass

**Goal:** every LLM call from the mini goes through one gateway that spends the Claude subscriptions' monthly API
credit first and records every request (Waves 1–4, design `docs/gateway.md`). agw then runs on measured Claude seats and Argo shows the new money flow (Waves 6–7). Then the review is more effective while
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
  (8) IU repos stay out of the eval cases. (9) The owner gives the two hours of labelling when Wave 8 reaches its owner
  session. (10) The native `/code-review` arm runs on Max as factory spawns; early is fine. Keep API spend on the
  review eval low: iterate on the Max subscriptions first, and start the API-priced sweeps of Waves 7 and 9 on a small
  `dev` slice before the full `test` set.
- Owner framing: greenfield, solo developer, optimal over compatible; the review pipeline may be reset.
- Tiers (owner, 2026-10-31): `FAST`, `EASY`, `HARD`, `DECIDE`. The picks Wave 3 sets and Wave 12 formalises stay
  provisional until Wave 11 measures the review. Other jobs keep provisional picks until their own evals exist.
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
- [x] Seats onto Claude (owner, 2026-11-01), provisional until Waves 11–12: `TRIVIAL`/`EASY` → Haiku 5.5, `STRONG` →
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

## Wave 4 — Reconcile and Argo            <!-- status: done 2026-11-02, release 2e7d5f2 -->

- [x] usage-tracker pass: `usage.platform_cost` from each org's cost API (admin key; a missing key skips that org), and
  `credit_cycles` closed per cycle with metered, reconciled and unspent. The gateway's meter takes the reconciled
  figure when higher.
- [x] Argo: payers `iu-credit`, `me-credit`, `me2-credit`; a Credits tab (burn-down per pool against its cycle,
  projected unspent, picks and fallbacks, cache-hit rate per caller); `accounts.ts` says `iu` is Ultra.
- [x] Docs to the new shape: dotfiles `docs/architecture.md`, `docs/agent-platform.md`, `docs/claude-accounts.md` (`me2`
  is live), `config/global.CLAUDE.md` (the IU-tokens line names the gateway), brain `wiki/engineering/model-routing.md`
  (the gateway; the retired `ca`/`cap`).
**Left behind:** close-out in `docs/waves/handoff/lead.md` at `e27b8d4`. me2 still disabled (placeholder keys; steps in
  dotfiles `docs/claude-accounts.md` §Platform). Not ours: dotfiles `make check` red (homebridge unmapped, herdr-core
  version skew). brain's tracked relative symlinks dangle in worktrees (vault-lint noise). Argo's cache-hit rate is dragged
  by modelpick's 251 zero-token catalog rows. `agw routes --format json` lacks the alias map. The Codex lane keeps the
  personal IU key outside the gateway (documented).

## Wave 5 — Eval foundations            <!-- status: done 2026-11-02, release bf76dc4 -->

Disjoint changes, one fan-out batch:

- [x] **Run-scoped overrides.** `agw eval run --arm <file>`, where an arm is `{ routes?: patch, params?: {...} }`. It is
  layered over the table for that run and its children only, and recorded in the input and the fingerprint. Workflows
  read params with a default. Removed: `AGW_ROUTES`, `~/.config/agw/routes.json` and their handling in
  `scripts/launch.sh`.
- [x] **Eval cost rolls up.** Case replays become children of `eval.run`, so its `cost` is their sum (today null).
- [x] **Structured agent output.** Agent steps return JSON through a tool call or a structured final turn, not through
  `parseStructured` on free text.
- [x] **Schema output on the `anthropic` wire** (Wave 3): `output_config.format` json_schema from the capability's zod type
  via `z.toJSONSchema`; zod parse stays as the last check. The OpenAI wire moves from `json_object` to `json_schema`
  where IU supports it. Sonnet guard: effort `none` on a Sonnet route is a config error. Spend is the gateway's rows.
- [x] **One model id per model** (normalise provider-echoed ids) and the route id on every step, so reports group by route.
**Left behind:** close-out in `docs/waves/handoff/lead.md` at `88cea3b`. A rollback past migration 0015 ignores `runs.arm`
  (drain armed evals first). `docs/review-v2.md:175` and `scripts/launch-gateway.sh:7` still name `AGW_ROUTES`. AGENTS.md's
  status line stops at Wave 3. Flaky `platform.test.ts` "concurrent runs" again. Carried: me2 placeholder keys, `agw
  routes` without the alias map, Codex lane IU key.

## Wave 6 — Claude seats, measured            <!-- status: done 2026-11-02, release 9cf9625 -->

Owner, 2026-11-02: agw runs on Claude with deliberate model and effort choices everywhere, not only where Wave 3
swapped them. This wave pulls the structural half of Wave 12 (tiers) forward; Wave 11's review sweep still sets the
review's own seats.

- [x] **Principles in `docs/gateway.md` §Seats:** Claude primary for every text and agent seat; a reviewer of
  Claude-written output stays on another lab (`prose.review`, `podcast.review.a`/`.b`, `review.adversary`); speech,
  transcription, image and `decide` stay on IU. Opus only where an arm shows it beats Sonnet beyond the CI.
- [x] **Arms on the existing suites** (`$AGW_EVAL_DIR`: research, otel, brain, check, diagram, prose) with Wave 5's
  `--arm`: Haiku 5.5 (`none`/`high`), Sonnet 5.5 (`low`/`medium`), Opus 5.5 where Sonnet leads, and today's seat as the
  baseline. Pick per workflow on score, then wall time; cost counts only past the credit pacing line. The DeepSeek
  seats go (`research.agent`, `otel.agent`, the podcast pipeline), `podcast.write` leaves Terra.
- [x] **Tiers** in `packages/routes/src/table/_shared.ts` (`FAST`, `EASY`, `HARD`, `DECIDE` with Claude primaries and
  GPT-on-IU fallbacks); routes spread a tier, a guard test fails a route that names a model (the eval judge excepted).
- [x] **Credit pacing.** The gateway exposes runway per pool (credit left against days left). Runs with
  `purpose=eval` stop drawing credit below a reserve (default: the pro-rata share of the remaining days for
  production), so an eval sweep cannot push production onto the over-cap IU key. The fallback order is documented.
- [x] Committed report `docs/evals/<date>-claude-seats.md`; picks recorded in `modelpick/docs/decisions/agw-text-seats.md`;
  a live call per changed route.
**Left behind:** owner decision 2026-11-02 16:10, a hotfix ahead of this wave's arms: review burned the credit (67 reviews
  in 2 days = $52.50, $0.78 each; `review.angle` on Sonnet $46.29). `review.angle` back to Haiku 5.5 high (the v3.5
  split), `review.angle.deep` and synthesis stay Sonnet; target ~$0.13 per review. This wave's arms leave `review.*`
  alone: Wave 11 decides the review seats, with Wave 9's native `/code-review` arm on Max as the subscription candidate.
  Close-out in `docs/waves/handoff/lead.md` at `15a9d91`; evals $6.91 credit + $0.36 IU. PR #83 (shop, another track)
  must spread a tier in its `vision.ts` before it merges (the new guard fails a `model:` literal). modelpick rows
  `claude-code/interactive-iu` and `hermes/stt` fail `verify-deployments`. Flaky: prose writer-fence test, `platform.test.ts`.

## Wave 7 — Usage view v7 spec (Argo)            <!-- status: done 2026-11-02, spec argo 84053e8 -->

Owner, 2026-11-02: the usage page needs a new UX concept for the gateway era, not a fifth tab. Spec first, build
after the owner signs the spec (the one stop of this wave).

- [x] **Spec v7** in `argo/docs/design/usage-tracking.md`, superseding v6 and the Credits tab bolted on in Wave 4. The
  mental model to test: **supply** (subscription windows, credit pools with expiry, IU keys with caps) → **router**
  (the gateway's picks, fallbacks, cache) → **demand** (callers and workflows: Claude Code lanes, agw workflows,
  Hermes, Iris, MacWhisper). Athena Teamchat is shown apart, never mixed in. One headline: are we on pace to use
  every credit dollar before it expires without touching the over-cap IU key?
- [x] The spec names each question the page answers, the view that answers it, and the endpoint behind it. The
  frontend rules (`rules/frontend-routing.md`) and basalt-ui apply. Mock screens in the spec. **Stop for the owner's
  sign-off.**
**Left behind:** close-out in `docs/waves/handoff/lead.md` at `fdeea26`. Spec `argo/docs/design/usage-tracking.md` v7 and mocks
  `argo/docs/design/usage-v7/`; five owner decisions at the top of the spec. The build moved to Wave 7b, after the
  owner's sign-off. Found: agw still writes its own `usage.records` for agent steps the gateway already recorded ($5.01
  on 11-02 since 08:10 UTC), so personal-key spend is overstated: fixed first in Wave 8.

## Wave 16 — Accounting and eval import (runs before Wave 8 closes)            <!-- status: active -->

Pulled forward 2026-11-02 while the owner labels (former Wave 13, plus Wave 8's `agw eval import`). No eval sweeps.

- [ ] `agw eval import` for an external arm's findings (Wave 9's native `/code-review` arm needs it), scored by scorer v3.
- [ ] Failed agent steps keep their tokens and cost (lost today, mostly on compaction overflow).
- [ ] `cost` null means unknown only; free steps record 0. Door errors (`door.speech` HTTP 400/503) are run failures, not
  `done`.
- [ ] `eval.mine`'s cost-history port wired in `boot.ts` (its label estimate prints `unknown`).

## Wave 8 — Ground truth            <!-- status: pending -->

- [x] **Double usage rows (from Wave 7):** agw stops writing `usage.records` for agent steps the gateway recorded;
  proven on stored rows of both writers after deploy. The 11-02 duplicates stay (owner's call, like Wave 3's 34).
- [x] `agw eval mine review`: SZZ over `~/SourceRoot` with the filters in `docs/review-v2.md` §Ground truth, two
  cross-vendor labeler calls per candidate, clean controls, the `dev`/`test` split. Cases go only under `$AGW_EVAL_DIR`.
- [ ] `eval.judge` on its own pinned route (judge, scorer v3 done; `agw eval import` moved to Wave 16), scorer v3 (recall, false alarms, noise, severity calibration), and `agw eval
  import` for an external arm's findings. The token-overlap matcher only preselects pairs.
- [ ] **No owner labelling (owner, 2026-11-02 21:00: 155 items is too much friction).** Ground truth is validated
  without the owner: a third labeller on another vendor breaks the two labellers' disagreements; a second judge on
  another vendor replaces the owner's judge labels, and judge κ is read between the two judges (bar κ ≥ 0.8, else
  disagreements score `unclear`). Accepted cases need both labellers (or 2 of 3) to agree. The limit (LLM consensus,
  no human check) is stated in every report. The owner pack and `agw eval gt pack|ingest` go (no shim).
- [ ] Target 200 bug cases and 100 controls. Seeded defects only below 150.
**Left behind (pre-session):** close-out in `docs/waves/handoff/lead.md` at `e637fcc`, release `e51fc17`. Pack: 35 accepted
  + 20 rejected cases, 100 judge pairs (27 positive): `me` eval credit ran out ($12.05 credit, $3.32 IU spent). After the
  session: ingest, the bars, then ~165 more accepted cases ≈ $49 ($13 IU, over the $20 IU line: the mother decides).

## Wave 7b — Usage view v7 build (Argo)            <!-- status: running beside Wave 8 as argo PLAN Wave 8 -->

- [ ] Build v7 in argo: endpoints on `usage.*` (gateway rows, picks, credit cycles, platform cost, quota samples),
  the views, tests; v6 views it supersedes are deleted, not hidden. Screenshots light and dark through `@verifier`.
  Spec signed 2026-11-02 18:20 (argo `9fd63c7f`): decisions 1–4 as recommended, 5 deferred, plus §Insights. Runs as
  argo `docs/waves/PLAN.md` Wave 8 in the argo checkout, beside this repo's Wave 8.

## Wave 9 — Baseline            <!-- status: pending -->

- Today's pipeline (v1) on the full `test` set and the controls, on its live seats: the first real numbers.
- Native `/code-review high` on 60 `test` cases through herdr-core sessions (owner decision 3).
- **OCR arm** (owner, 2026-11-02: OCR stays off until measured). `alibaba/open-code-review` (pinned v1.13.3) on the
  `test` set and the controls, on Haiku 5.5 and Sonnet 5.5 through the gateway (its own door token, so its spend is
  priced for the first time) and on Terra: recall, false alarms, cost and wall per arm. Wave 11 keeps OCR only as an
  arm that beats v2 on recall beyond the CI at a cost the owner accepts; otherwise its deletion stands.
- Committed report `docs/evals/<date>-review-baseline.md`. It sets how much headroom v2 has to beat.

## Wave 10 — Review v2            <!-- status: pending -->

- The pipeline in `docs/review-v2.md`: prepare, finders, group, verify vote, assemble, ledger. Levels
  `quick|standard|deep`, `REVIEW.md` loading, REVIEW_OUTPUT v3, re-review diff-only, `stepBack` from round 3,
  `agw review dispose`.
- Built beside v1 as workflow `review-v2`, so Wave 11 can compare both. Prompts iterate on `dev` only.
- The `/review` skill rewritten for v3: the fix loop, dispositions, `stepBack`. Every other caller moves to v3 here.
- The stale lines in `docs/review-v2.md` §Docs to fix are fixed.

## Wave 11 — Arm sweep and cutover            <!-- status: pending -->

- v2 variants on `test` with run-scoped arms: finders 1, 3 or 5; K 1 or 3; voters as agent steps or single calls; seats
  on GPT or Claude per stage. The decision rule is in `docs/review-v2.md` §Metrics.
- The pick becomes `review`. Deleted: v1, the 12 angle agents, the router, the adversary, synthesis, OCR (and
  `review.ocr`), react-doctor inside review, and the 138 legacy review cases. A concept version note says why.
- Committed report. The review's seats give the measured `HARD` and `EASY` picks. The `--deep` native merge in
  `/review` stays only if the native arm beat v2's `deep` on recall beyond the CI.
- `REVIEW.md` seeded in the five busiest repos.

## Wave 12 — Central tiers            <!-- status: pending -->

Provisional picks (2026-10-31, from cost, wall time, failure modes and the AA index). Wave 11 replaces `HARD` and
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

## Wave 13 — Accounting and telemetry            <!-- status: pending -->

- [ ] Moved into Wave 16 (2026-11-02); tick when Wave 16 is done.

## Wave 14 — Harness robustness            <!-- status: pending -->

- Compaction overflow: an output limit for the compaction summary, or a context budget per agent step, so a long
  exploration ends with a result instead of a failed step.
- The runaway cap (wall 10x p95, cost 10x p95), reviewed against the deep reviews it has killed and against v2's new
  p95.
- Review convergence sub-eval: a fix loop over 20 `test` cases (review, fix, diff-only re-review) measuring
  rounds-to-pass and the share of late findings on old code, next to rounds-to-pass from real dispositions.

## Wave 15 — Coverage and debt            <!-- status: pending -->

- Eval cases and a scorer for the uncovered workflows (narrative, overview, prose-polish, image-icon, retrospective,
  podcast) and scorers for speech and transcriptions.
- Test fakes consolidated into `packages/testing` (they live in four packages today).
- Dead code: `IU_ANTHROPIC_BASE` in `packages/opencode-host/src/server.ts`, Claude leftovers the tiers make obsolete.
- Docs: concept notes and `otel.ts` comments brought to the code.
