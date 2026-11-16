# Research call budget and tier comparison, 2026-11-16

Issue 1600. The question: does a tool-call budget per depth (quick 4, standard 12, deep 40: a figure in the prompt, a stop
rule in `agents/research/AGENTS.md`, a note from the tool gate at the budget and at 1.5x, never a refusal) cut calls and cost
without losing `supported`, and does the next stronger tier (Sonnet 5.5 medium, the `HARD` agent) earn its price on the
budgeted prompt. Both arms are compared with the baseline of `2026-11-16-research-baseline.md`, reused, not rerun.

**Decision: the budget stays at 4 / 12 / 40 and `research.agent` stays on its tier (Haiku 5.5, effort high).** Sonnet at
standard is 6.7 times the cost for a `supported` that is not better (0.67 against 0.80, 10 pairs); deep was not run on it.

## Method

- **Arm `budget`:** the route as deployed at `5130c28` (Haiku 5.5, effort high), research version `2026-11-16.1`, the 11
  deep and 18 standard cases of the suite (the 3 quick cases are not run: their baseline makes 1.3 calls, below any budget),
  one run per case. Run `01a1e4d4-b1eb-703b-b594-a37ea9e35a34`, fingerprint `84216c2c690b…`.
- **Arm `sonnet`:** the same, with `{"routes": {"research.agent": {"model": "claude-sonnet-5-5", "effort": "medium"}}}` as
  the arm, on the 10 prod-derived standard cases only (the cases that exercise the budget; the cheapest cut that can decide
  a tier). Run `01a1e4e5-7cab-76cc-9982-a88b724f9fac`, fingerprint `5b0ea130d0f2…`.
- **Baseline:** the unbudgeted run `01a1e49e-cef1-716c-a655-df98e7652615`.
- Scorer `2026-11-16.1`, the judge the `decide` route reading the cited page; no human checked the verdicts. One run per case:
  a depth row of 11 to 18 cases moves by a case or two between reruns, a difference under about 0.1 in `supported` is not a result.

## Budget against baseline (Haiku, all 29 standard and deep cases)

|Depth|Cases|Calls per case, baseline|Calls per case, budget|Median calls, budget|Max|supported, baseline|supported, budget|Cost per case, baseline|Cost per case, budget|
|-|-|-|-|-|-|-|-|-|-|
|standard|18|22.6|9.4|11.5|13|0.81|0.80|$0.084|$0.020|
|deep|11|64.5|36.1|39|40|0.91|0.91|$0.470|$0.216|

Acceptance: standard median 11.5 (12 or fewer), deep median 39 (45 or fewer), `supported` 0.80 and 0.91 against the baseline
less 0.03 (0.78 and 0.88). The other scores hold: `golden` 1.00 standard and 0.91 deep (the same single miss as the baseline),
`complete` 0.89 and 1.00, `grounded` 0.92 and 0.99, `valid` 1.00, no errors. The prod-derived standard cases sit at 12 calls
(10 of 10 at 11 to 13): the agent stops at the figure, and the 1.5x note was never needed (max 13 against a 18 trigger).
The eval run cost $2.75 (case runs and judge).

## Tier comparison (10 prod-derived standard cases, paired)

|Arm|supported|complete|grounded|golden|Median calls|Cost per case|
|-|-|-|-|-|-|-|
|Haiku 5.5 high, budget|0.80|0.90|0.96|1.00|12|$0.024|
|Sonnet 5.5 medium, budget|0.67|1.00|1.00|1.00|11|$0.161|

Paired difference (`agw eval compare research`, 10 pairs): `supported` -0.13 (95 % CI -0.27 to 0.00) for Sonnet, `complete`
+0.10 (0.00 to +0.30), `grounded` +0.04 (0.00 to +0.12), every verdict `tie`. The cost is 6.7 times for no gain the CI
separates from zero, so the stronger tier does not earn its price at standard. The prod finding that the cheaper tier makes
3 times the calls of the stronger one (median 33 against 12) is the budget's doing now: both make about 11 to 12.
The eval run cost $1.61.

**Not decided here:** Sonnet at deep. At the standard price ratio ($0.16 a case against $0.02) a deep arm of 5 to 11 cases is
$5 to $10 for a comparison that the standard result does not make likely to differ; it was not run. Run it from
`agw eval run research --arm <the arm above> --ids <the prod-deep-* cases> --yes` if the owner wants it settled.

## Production, still to count

The prod acceptance (median `web_fetch` of 10 or fewer over the first 30 standard runs after the deploy of `5130c28`, no
`invalid_output`) is read from `agw.research_tool_calls` and `agw.steps` once 30 standard runs exist. It is the only part
this report cannot state.

## Why the re-ask rate did not move with a fence strip

The Issue assumed fenced answers failed validation. They did not: `parseJsonLoose` already stripped a surrounding fence and
the prose around the object. Prod had 20 `research:reask` steps in 30 days (11 on Haiku, 9 on deepseek). Of the 7 Haiku first answers
read, 4 were JSON and 3 were markdown with no JSON at all. Of the 4 JSON answers, 3 failed the schema on a
citation with a `null` or missing URL (the agent citing a claim it could not source) and 1 held a full-width comma. The
change moves a citation without a URL to `unverified` in code (the agent's own rule for a claim it cannot source), which
fixes the 3; prose-only and malformed answers still get the one re-ask. `parseJsonLoose` also tries the text, the outermost
fence, each fenced block and the brace slice in order, so a code block inside the report string no longer breaks it.

## Spend

2 eval runs, $4.36 (case runs and judge calls): the budget arm $2.75, the Sonnet arm $1.61. Plans (no spend) were read before
each. The baseline was reused; nothing was rerun to confirm a refactor.
