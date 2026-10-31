# Central model tiers and the maturity pass

**Goal:** routes name one of four central tiers instead of a model and effort each; every tier choice rests on an eval
that measures the job (the review eval comes with the owner's review rework), recorded as a committed report; and the gaps the 2026-10-31 audit found in accounting,
telemetry, tests and docs are closed.
**Gate:** `make check`, `/review` on non-doc changes, `make deploy` + `make verify` after each wave, a live call per
changed route. Own-repo pushes and deploys are routine.

Context (2026-10-31):

- Claude agent steps run on the direct Anthropic API (`anthropic-direct`, key `op://common/claude-platform/API_KEY_IU`,
  commit 5e1a871). Effort reaches Claude only since then.
- The review eval of 2026-10-31 (`docs/evals/2026-10-31-review-claude-direct.md`) settled cost, wall time and failure
  modes per arm but **cannot rank models**: its reference is the retired gateway's outcome and agreement tracks how
  readily a model says "blocking".
- Tiers (owner, 2026-10-31): `FAST` (single call, no agent loop: titles, labels, short summaries), `EASY` (extract,
  classify, triage, router, check, vault Q&A), `HARD` (review, prose, diagrams, retro, research, otel; no separate
  research tier), `DECIDE` (the typed decision route).
- The quality eval moves to the owner's review-pipeline rework, which builds its own eval; the lessons are in
  `docs/evals/README.md`. Tier picks below are provisional until it exists.
- Audit (outside the repo, private numbers: `~/SourceRoot/agw-maturity-audit.md`). Findings carried below.

## Wave 1 — Central tiers            <!-- status: pending -->

Provisional picks (2026-10-31, from cost, wall time, failure modes and the AA index; quality unmeasured):

| Tier | Primary | Fallback (other vendor) | Why |
|-|-|-|-|
| `FAST` | Haiku 5.5, effort `none`, direct single call | Luna low (IU) | same price as Luna ($0.10 / $0.50), higher index, 36 s per review-sized load without thinking |
| `EASY` | Haiku 5.5, effort `high` | Terra low (IU) | the only Haiku effort whose verdicts move; $0.15 per deep review; 10x cheaper tokens than Terra |
| `HARD` | Terra medium (IU) | Sonnet 5.5 low (direct) | decisive, $0.43 and 83 s per deep review; Sonnet low is as fast and cheap as DeepSeek and the candidate once an eval measures it |
| `DECIDE` | `decision-1` (IU decision API) | none | unchanged |

DeepSeek flash leaves the primaries: 576 s p50 per deep review, 14.7 M input tokens, IU bills it at peak rate. Haiku
`max` and `low` are out for agent steps (overflow; no signal). Research and otel move to `HARD` with the rest.

- `packages/routes/src/table/_shared.ts`: `FAST`, `EASY`, `HARD`, `DECIDE` with their fallbacks. Routes spread a tier
  and nothing else; the per-route effort and output-limit overrides (podcast.write, image.enhance, the agents'
  `maxOutputTokens`) become tier properties or go. A guard test fails a route that names a model.
- Direct single-call wire `anthropic` (sibling of `iu-anthropic`, same request shape) with structured outputs:
  `output_config.format` json_schema from the capability's zod type via `z.toJSONSchema`, zod parse kept as the last
  check. The OpenAI wire moves from `json_object` to `json_schema` where IU supports it.
- Sonnet guard: effort `none` on a Sonnet route is a config error (Sonnet 5.5 rejects `thinking: disabled`).
- Spend on the direct key: its own key label on usage rows, priced from route rates. The Console org carries a $200
  monthly limit (owner, 2026-10-31); no IU wallet gate covers this key.
- Picks recorded in `modelpick/docs/decisions/agw-text-seats.md`; a live call per tier after deploy.

## Wave 2 — Eval plumbing            <!-- status: pending -->

- Eval spend rolls up: `eval.run` records the cost of its case runs (today null on all of them).
- A committed report per tier change under `docs/evals/` (shape in `docs/evals/README.md`).
- The review eval itself belongs to the review rework; research's 28 cases get a golden-answer check here.

## Wave 3 — Accounting and telemetry            <!-- status: pending -->

- One model id per model: normalise the provider-echoed ids (`openai.…`, `bedrock/eu.…`, `deepseek/…`) and pseudo
  models; record route id and tier on every step.
- Failed agent steps keep their tokens and cost (19 steps lost theirs in 7 days, mostly compaction overflow).
- `cost` null means unknown only; free steps record 0. Door errors (`door.speech` HTTP 400/503) are run failures, not
  `done`.

## Wave 4 — Harness robustness            <!-- status: pending -->

- Agent JSON output through a tool call or a structured final turn instead of `parseStructured` on free text (a Sonnet
  angle failed on prose before an unfenced object).
- Compaction overflow: an output limit for the compaction summary, or a context budget per agent step, so a long
  exploration ends with a result instead of a failed step.
- Runaway cap (wall 10x p95, cost 10x p95) reviewed against deep reviews it has killed.

## Wave 5 — Coverage and debt            <!-- status: pending -->

- Eval cases and a scorer for the uncovered workflows (narrative, overview, prose-polish, image-icon, retrospective,
  podcast) and scorers for speech and transcriptions.
- Test fakes consolidated into `packages/testing` (they live in four packages today).
- Dead code: `IU_ANTHROPIC_BASE` in `packages/opencode-host/src/server.ts`, Claude leftovers the tiers make obsolete.
- Docs: AGENTS.md status past Wave 3, concept notes and `otel.ts` comments brought to the code.
