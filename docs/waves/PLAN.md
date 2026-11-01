# Review v2, its eval, then central tiers and the maturity pass

**Goal:** the review is more effective while cheaper and faster, measured by an eval that ranks models and pipeline
variants on ground truth. The tier choices rest on that data, and the gaps the 2026-10-31 audit found in accounting,
telemetry, tests and docs are closed. Design: `docs/review-v2.md`.
**Gate:** `make check`, `/review` on non-doc changes, `make deploy` + `make verify` after each wave, a live call per
changed route. Own-repo pushes and deploys are routine.

Context (2026-11-01):

- The 2026-10-31 eval (`docs/evals/2026-10-31-review-claude-direct.md`) settled cost, wall time and failure modes per
  arm, but **cannot rank models**: its reference is a retired gateway's outcome. Lessons: `docs/evals/README.md`.
- Owner framing: greenfield, solo developer, optimal over compatible; the review pipeline may be reset.
- Tiers (owner, 2026-10-31): `FAST`, `EASY`, `HARD`, `DECIDE`. The provisional picks below (Wave 6) stay provisional
  until Wave 5 measures the review. Other jobs keep provisional picks until their own evals exist.
- Audit (private numbers, outside the repo: `~/SourceRoot/agw-maturity-audit.md`). Findings carried below.

**Why the rework goes before the tiers.** A tier wave first would only relabel unmeasured picks, and the review is the
largest `HARD` consumer, so it would be redone after the sweep. The parts of the old tier and maturity waves that the
eval needs move into Wave 1. The rest waits.

## Wave 1 — Eval foundations            <!-- status: pending -->

Disjoint changes, one fan-out batch:

- **Run-scoped overrides.** `agw eval run --arm <file>`, where an arm is `{ routes?: patch, params?: {...} }`. It is
  layered over the table for that run and its children only, and recorded in the input and the fingerprint. Workflows
  read params with a default. Removed: `AGW_ROUTES`, `~/.config/agw/routes.json` and their handling in
  `scripts/launch.sh`.
- **Eval cost rolls up.** Case replays become children of `eval.run`, so its `cost` is their sum (today null).
- **Structured agent output.** Agent steps return JSON through a tool call or a structured final turn, not through
  `parseStructured` on free text.
- **Direct `anthropic` single-call wire** (sibling of `iu-anthropic`) with `output_config.format` json_schema from the
  capability's zod type via `z.toJSONSchema`; zod parse stays as the last check. The OpenAI wire moves from
  `json_object` to `json_schema` where IU supports it. Sonnet guard: effort `none` on a Sonnet route is a config error.
  Spend on the direct key: its own key label on usage rows, priced from route rates (Console limit $200 a month,
  owner 2026-10-31).
- **One model id per model** (normalise provider-echoed ids) and the route id on every step, so reports group by route.

## Wave 2 — Ground truth            <!-- status: pending -->

- `agw eval mine review`: SZZ over `~/SourceRoot` with the filters in `docs/review-v2.md` §Ground truth, two
  cross-vendor labeler calls per candidate, clean controls, the `dev`/`test` split. Cases go only under `$AGW_EVAL_DIR`.
- `eval.judge` on its own pinned route, scorer v3 (recall, false alarms, noise, severity calibration), and `agw eval
  import` for an external arm's findings. The token-overlap matcher only preselects pairs.
- **Owner session (owner decision 2):** confirm 70 mined cases and label 100 judge pairs. Bars: accepted cases ≥ 90 %
  right, judge κ ≥ 0.8. Below either, tighten the filters or add a second judge.
- Target 200 bug cases and 100 controls. Seeded defects only below 150.

## Wave 3 — Baseline            <!-- status: pending -->

- Today's pipeline (v1) on the full `test` set and the controls, on its live seats: the first real numbers.
- Native `/code-review high` on 60 `test` cases through herdr-core sessions (owner decision 3).
- Committed report `docs/evals/<date>-review-baseline.md`. It sets how much headroom v2 has to beat.

## Wave 4 — Review v2            <!-- status: pending -->

- The pipeline in `docs/review-v2.md`: prepare, finders, group, verify vote, assemble, ledger. Levels
  `quick|standard|deep`, `REVIEW.md` loading, REVIEW_OUTPUT v3, re-review diff-only, `stepBack` from round 3,
  `agw review dispose`.
- Built beside v1 as workflow `review-v2`, so Wave 5 can compare both. Prompts iterate on `dev` only.
- The `/review` skill rewritten for v3: the fix loop, dispositions, `stepBack`. Every other caller moves to v3 here.
- The stale lines in `docs/review-v2.md` §Docs to fix are fixed.

## Wave 5 — Arm sweep and cutover            <!-- status: pending -->

- v2 variants on `test` with run-scoped arms: finders 1, 3 or 5; K 1 or 3; voters as agent steps or single calls; seats
  on GPT or Claude per stage. The decision rule is in `docs/review-v2.md` §Metrics.
- The pick becomes `review`. Deleted: v1, the 12 angle agents, the router, the adversary, synthesis, OCR (and
  `review.ocr`), react-doctor inside review, and the 138 legacy review cases. A concept version note says why.
- Committed report. The review's seats give the measured `HARD` and `EASY` picks. The `--deep` native merge in
  `/review` stays only if the native arm beat v2's `deep` on recall beyond the CI.
- `REVIEW.md` seeded in the five busiest repos.

## Wave 6 — Central tiers            <!-- status: pending -->

Provisional picks (2026-10-31, from cost, wall time, failure modes and the AA index). Wave 5 replaces `HARD` and
`EASY` with measured ones:

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

## Wave 7 — Accounting and telemetry            <!-- status: pending -->

- Failed agent steps keep their tokens and cost (lost today, mostly on compaction overflow).
- `cost` null means unknown only; free steps record 0. Door errors (`door.speech` HTTP 400/503) are run failures, not
  `done`.

## Wave 8 — Harness robustness            <!-- status: pending -->

- Compaction overflow: an output limit for the compaction summary, or a context budget per agent step, so a long
  exploration ends with a result instead of a failed step.
- The runaway cap (wall 10x p95, cost 10x p95), reviewed against the deep reviews it has killed and against v2's new
  p95.
- Review convergence sub-eval: a fix loop over 20 `test` cases (review, fix, diff-only re-review) measuring
  rounds-to-pass and the share of late findings on old code, next to rounds-to-pass from real dispositions.

## Wave 9 — Coverage and debt            <!-- status: pending -->

- Eval cases and a scorer for the uncovered workflows (narrative, overview, prose-polish, image-icon, retrospective,
  podcast) and scorers for speech and transcriptions.
- Test fakes consolidated into `packages/testing` (they live in four packages today).
- Dead code: `IU_ANTHROPIC_BASE` in `packages/opencode-host/src/server.ts`, Claude leftovers the tiers make obsolete.
- Docs: concept notes and `otel.ts` comments brought to the code.
