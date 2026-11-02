# Lead handoff — Wave 6 (Claude seats, measured): CLOSE-OUT

Lead `agent-workflows-w1-r9` (pane t7r), 2026-11-02 ~14:05 → ~17:00 local. Briefs on the mini (not in git):
`~/.local/state/agent-workflows/briefs/gw6/` (credit-pacing, tiers, podcast-messages-loop, seat-picks); arm files
`~/.local/state/agent-workflows/arms/gw6/`, eval ledger `~/.local/state/agent-workflows/evals-gw6/ledger.txt` (suite, arm,
eval run id). Branch prefix `gw6/`. Wave 5's close-out is in git history (`88cea3b`).

## Live state

agent-workflows release `9cf9625` (host, audio), gateway build `79a92cca80ce1264` (restarted at each of the three
deploys: it bundles the route table and pacing). `make deploy` OK and `make verify` PASS at `e8205e5` (pacing),
`61b7687` (review hotfix) and `9cf9625` (picks). `make live-routes` PASS 33 routes at `9cf9625`. Commits after it are
docs only (`759a49e` report, `00d64b8` AGENTS.md and eval lessons). Every fan worktree of the wave cleaned.

Pools at close (`/health`): `iu` metered $111.24 of $200, no eval draw (under its pro-rata reserve all day); `me` $6.91
of $100 (all of it this wave's evals), `evalAvailableUsd` $12.57; `me2` disabled.

## Per-step verdicts

| Step | Verdict | PRs | Review |
|-|-|-|-|
| Principles in `docs/gateway.md` §Seats | **PASS.** Claude primary for every text and agent seat; reviewers of Claude output on another lab; speech, transcription, image and `decide` on IU; Opus only beyond the CI; pick order score → wall → cost past the pacing line | `d48e054` (lead, docs) | doc |
| Credit pacing | **PASS.** `/health` per pool: `creditLeftUsd`, `daysLeft`, `runwayUsdPerDay`, `evalReserveUsd` (default `credit × daysLeft / cycleDays`; unknown cycle = whole credit; registry `evalReserveUsd` overrides, warned when above credit), `evalAvailableUsd`, `evalEligible`. Purpose `eval` draws only on pools above their reserve and is never sent to IU: forced or Claude-Code-shaped eval requests too; no pool → 403 `permission_error` with `x-agw-pick-reason` (`eval-reserve`/`eval-forced`/`eval-claude-code`), not a 402 (no silent GPT fallback, no retry). Other purposes unchanged. Fallback order documented in §Picking a pool. Live: the brain baseline's 35 Haiku calls `api_credit` on `me` while production stayed on `iu`; 723 eval rows on `me`, none on `iu`, no refusal | #105 | agw review (clean, 5 improvements) + `/code-review high` (10 findings: eval beat by `forceIu`, misleading 403 figures, a ledger read on the refusal path, Claude-Code eval blamed on the reserve, in-flight overshoot undocumented; 6 fixed, in-flight bound documented, binding/typo/typing items declined) |
| Tiers | **PASS.** `FAST`/`EASY`/`HARD`/`DECIDE` in `_shared.ts`, each `{call, agent}` with its GPT-on-IU fallback; cross-lab constants (`CRITIC`, `DEEPSEEK_FLASH`, `GEMINI_FLASH`, `GEMINI_FLASH_LITE`); guard: a text route's group file holding a `model:` literal fails with file:line (media routes exempt by list), every Claude route deep-equals a tier step. Pure refactor: all 51 route fingerprints identical (checked by the lead) | #106 | agw review (clean, 5 improvements; 5 fixed) |
| Arms on the suites | **PASS.** 42 eval runs, six suites (research 20 of 28 cases, otel 8, brain 10, check 7, diagram 6, prose 10), baseline + Haiku none/high + Sonnet low/medium, Opus medium where Sonnet led (research, otel), small slices widened only where close. Picks: research and otel → Sonnet medium (HARD); diagram → Haiku none (FAST); brain, check unchanged; prose.review unchanged (DeepSeek, cross-lab); no Opus. Podcast stages by principle (no suite): Sonnet medium, metadata Haiku high, `review.b` Terra medium | #107 (Messages tool loop), #108 (picks, every Claude model served on OpenCode) | #107 agw review (clean; 5 fixed incl. a tail cache breakpoint: round 3 read 13,138 cached tokens, stored rows); #108 agw review ×2 (clean) |
| Report and modelpick | **PASS.** `docs/evals/2026-11-02-claude-seats.md`; modelpick `b4ebc82` (31 agw rows to the live table, `verify-deployments` 19 → 2 broken, the 2 outside agw) and `c44c89b` (`agw-text-seats.md`: Current verdict, re-open triggers, old GPT-stack sections marked superseded); modelpick `make check` green | — | docs |
| Live call per changed route | **PASS.** `make live-routes` 33/33 at `9cf9625`: `diagram.agent` Haiku, `research.agent`/`otel.agent` Sonnet, `podcast.{research,editorial,outline,write}` Sonnet, `podcast.metadata` Haiku, `podcast.review.b` Terra, `review.angle` Haiku | — | — |

**Owner hotfix (mother, 16:10), ahead of the rest:** `review.angle` → Haiku 5.5 high (EASY), deep angles and synthesis
stay Sonnet, a guard test pins the split. PR #109, release `61b7687`, verify PASS; live standard review (run
`01a19cda-2ee6-…`, 4 angles) $0.158 from stored gateway rows: angles $0.077 on Haiku `api_credit`, synthesis $0.045,
adversary $0.032 (IU), router $0.004. Reported to the mother. #108 was held until it landed.

## Gate evidence

- `make check` in the train after every rebase (last: #108 green, 3831 tests), CI green on every merge; one CI flake on
  #107 (prose "writer's fence … at most 50 findings", passed locally and on rerun: `gh run rerun --failed`).
- Deploy + verify at `e8205e5`, `61b7687`, `9cf9625`; live-routes 33/33 at `9cf9625`.
- Usage proven from stored rows: eval picks (`usage.records` by run tree, `gateway_picks`), the podcast loop's cache
  reads, the hotfix review's per-step cost.

## Spend

| What | Credit (`api_credit`) | IU (`api_key`) |
|-|-|-|
| Eval arms, 42 runs (journal tree $7.58) | $6.91 (`me`) | $0.36 (DeepSeek and GPT arms, the `decide` judge) |
| agw reviews: #105, #106, #107, #108 ×2, #109 | $1.88 | $0.14 (adversary) |
| Verify smoke reviews ×3, live-routes, the loop probe | ≈ $0.25 | < $0.10 |

IU for evals: **$0.36**, far under the $20 line. No eval request was refused or sent to IU.

## Departures and lead decisions (for the mother)

- **Pacing reserve is pro-rata of the credit**, not production's measured burn: a pool over its even-spend line (`iu`
  today) gives evals nothing; `me` gave ~$19. An unknown cycle gives evals nothing unless `evalReserveUsd` is set.
- **The eval refusal is a 403**, not the 402 the transports fall back on: an arm must fail by name rather than silently
  measure GPT on IU.
- **Every Claude model is served on OpenCode** (Opus included, no route on it), so an arm can name Opus; the guard keeps
  every route on a tier.
- **otel on Sonnet is the close call**: score ties Haiku high, Sonnet wins on wall (the rule's tie-breaker) at 6x the
  cost and one `invalid_output` in 16 runs. Re-measure when otel gains cases.
- **Podcast stages moved without an eval** (none exists; Wave 15): by principle, proven per route by live-routes and the
  worker's 3-round Messages loop probe, not by a full episode.
- `prose.review` stays DeepSeek: the plan named three DeepSeek seats to remove; the prose reviewer is a cross-lab seat
  and DeepSeek scored best among the other-lab arms.

## Left behind

- `feat/shop-amazon-2` (PR #83, another track) adds `packages/routes/src/table/vision.ts`: Wave 6's guard fails a group
  file with a `model:` literal, so that branch must spread a tier or a `_shared.ts` constant before it merges.
- Sonnet 5.5 at effort low/medium spends ~0 reasoning tokens in OpenCode agent steps (adaptive thinking); effort arms on
  Sonnet are nearly one arm (eval README lesson).
- otel Sonnet medium `invalid_output` once (the agent ended without `submit_result`).
- Flaky prose test "the writer's fence > … at most 50 findings and 30 notes" (CI once); `platform.test.ts` "concurrent
  runs" still known flaky.
- modelpick rows `claude-code/interactive-iu` and `hermes/stt` still fail `verify-deployments` (not agw routes).
- The `review.angle` hotfix review's cosmetic items (dated figures in the route comment, a long test name) not applied.
- Carried: `me2` placeholder keys, `agw routes --format json` without the alias map, Codex lane IU key, Argo cache-hit
  drag, dotfiles `make check` red outside the fleet.

## Retro notes for the mother

- **Pacing first paid off**: with the reserve live before any arm, the sweep could not touch `iu`, and sizing slices to
  `evalAvailableUsd` kept the whole wave at ~$7 of credit.
- **The suites are cheap except where they are not**: research on DeepSeek cost $0.007 a case, not the $0.15 history
  mean (the early cases are lookups); start every sweep with a 3-case slice to measure before planning the budget.
- **A refactor proven by fingerprints** (51 identical) let tiers merge with a light review; the picks then changed
  exactly the 9 fingerprints the brief named.
- **Workers left tests pinned to the old table outside their owned files** (host OpenCode tests, eval-arm): a picks
  brief should own the tests that pin the moved routes, found with `git grep` on the route ids first.
- **Factory "workers done" fired early again**; the PR head and the pane were the reliable signals. A worker ended a
  turn on a background `make check` once more.
