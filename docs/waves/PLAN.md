# Model tiers, a trustworthy eval, and the maturity pass

**Goal:** routes name one of four central tiers instead of a model and effort each; every tier choice rests on an eval
that measures the job, recorded as a committed report; and the gaps the 2026-10-31 audit found in accounting,
telemetry, tests and docs are closed.
**Gate:** `make check`, `/review` on non-doc changes, `make deploy` + `make verify` after each wave, a live call per
changed route. Own-repo pushes and deploys are routine.

Context (2026-10-31):

- Claude agent steps run on the direct Anthropic API (`anthropic-direct`, key `op://common/claude-platform/API_KEY_IU`,
  commit 5e1a871). Effort reaches Claude only since then.
- The review eval of 2026-10-31 (`docs/evals/2026-10-31-review-claude-direct.md`) settled cost, wall time and failure
  modes per arm but **cannot rank models**: its reference is the retired gateway's outcome and agreement tracks how
  readily a model says "blocking".
- Target tiers (owner, 2026-10-31): `FAST` (single call, no agent loop: titles, labels, short summaries), `EASY`
  (extract, classify, triage, router, check, vault Q&A), `HARD` (review, prose, diagrams, retro, research, otel; no
  separate research tier), `DECIDE` (the typed decision route). Candidates: FAST Haiku none or Luna low; EASY Haiku
  high or Terra low; HARD Terra medium, DeepSeek flash high, Sonnet low or medium.
- Audit (outside the repo, private numbers: `~/SourceRoot/agw-maturity-audit.md`). Findings carried below.

## Wave 1 — An eval that measures review quality            <!-- status: pending -->

- Research first (`/research`): how public code-review benchmarks build ground truth (planted defects, SWE-bench-style
  fixed bugs, CodeReviewer, CRScore) and how they score severity and false positives.
- Build a planted-defect review set from corpus diffs: known bugs injected per case, with the expected file, line and
  severity; clean controls with no defect. Score recall, false-positive rate and severity calibration, not agreement
  with a past run. Aggregates only in the repo; cases stay under `$AGW_EVAL_DIR`.
- Same shape for research: the 28 recorded cases plus a golden-answer check, so `HARD` can be judged on research too.
- Eval spend rolls up: `eval.run` records the cost of its case runs (today null on all of them).
- Committed report per tier change under `docs/evals/` (change, case-set hash, metrics with CIs, cost, wall time,
  tokens, fingerprints, verdict).

## Wave 2 — Central tiers            <!-- status: pending -->

- `packages/routes/src/table/_shared.ts`: `FAST`, `EASY`, `HARD`, `DECIDE`, each with its fallback on another vendor.
  Routes spread a tier and nothing else; the per-route effort and output-limit overrides (podcast.write, image.enhance,
  the agents' `maxOutputTokens`) become tier properties or go. A guard test fails a route that names a model.
- Tier picks from Wave 1's reports, recorded in `modelpick/docs/decisions/agw-text-seats.md`.
- Direct single-call wire `anthropic` (sibling of `iu-anthropic`, same request shape) with structured outputs:
  `output_config.format` json_schema from the capability's zod type via `z.toJSONSchema`, zod parse kept as the last
  check. The OpenAI wire moves from `json_object` to `json_schema` where IU supports it.
- Sonnet guard: effort `none` on a Sonnet route is a config error (Sonnet 5.5 rejects `thinking: disabled`).
- Spend on the direct key: its own key label on usage rows, priced from route rates, and a monthly budget check against
  the plan credit (the IU wallet gate does not cover it).

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
