# Research eval baseline, 2026-11-16

The first run of the rebuilt research suite (Issue 1599) on the route as deployed at `84bf142`. It is the baseline that a
call budget, a prompt change or a model change for research is compared against; it decides nothing by itself.

## The change

The suite was 19 quick, 8 standard and 1 deep case, written on 2026-10-28, whose runs made a median of 2 tool calls. It
is now 32 cases: the 3 quick, 8 standard and 1 deep case that stay (the legacy cases) plus 10 deep and 10 standard cases
taken from real prod questions of 2026-10-26 to 2026-11-16 (`agw.runs`, `workflow = 'research'`, `purpose = 'prod'`,
`status = 'done'`, no `context`, `contextRuns` or `followUp` in the input, so each stands alone). Questions that name
private or work data were left out. Goldens are the stable names and facts the answer must contain (`any` / `all`
patterns, or `live:` for a registry's latest version), written from the question and its primary sources, not copied from
the run's report; `supported` judges the claims, the golden guards coverage. How the file is refreshed:
`README.md` §The research suite and its refresh.

## Depth mix

Prod, 2026-10-26 to 2026-11-16 (381 runs):

|Depth|Prod runs|Prod share|Suite cases|Suite share|Gap|
|-|-|-|-|-|-|
|quick|27|7.1 %|3|9.4 %|2.3 points|
|standard|230|60.4 %|18|56.3 %|4.1 points|
|deep|124|32.5 %|11|34.4 %|1.9 points|

Within 15 points on every depth, the acceptance bound.

## Baseline

One eval run (`01a1e49e-cef1-716c-a655-df98e7652615`), all 32 cases scored, no errors, no unpriced calls. Route
`research.agent` as deployed, research scorer `2026-11-16.1`, case-run fingerprint `86332959a20c…`.

|Depth|Cases|supported|golden|complete|grounded|Tool calls per case|Cost per case|Cost total|
|-|-|-|-|-|-|-|-|-|
|quick|3|0.67|1.00|1.00|1.00|1.3|$0.007|$0.021|
|standard|18|0.81|1.00|0.89|0.98|22.6|$0.084|$1.516|
|deep|11|0.91|0.91|1.00|1.00|64.5|$0.470|$5.174|
|all|32|0.83|0.97|0.94|0.99|35.0|$0.210|$6.711|

`valid` is 1.00 everywhere and `judgedShare` 1.00: every sampled citation was judged. The pass rate is 0.97 (31 of 32).
The eval run's own cost, case runs plus the judge's calls, is $6.73 (1 run).

Production in the same window, for scale (journal, per run):

|Depth|Tool calls|Cost|`supported` (drift)|
|-|-|-|-|
|quick|9.0|$0.021|n/a|
|standard|34.9|$0.142|0.80|
|deep|75.9|$0.419|0.64 (n = 11)|

The legacy cases and the prod-derived cases differ, which the depth rows blend:

|Subset|Cases|Tool calls|Cost|supported|
|-|-|-|-|-|
|prod-derived standard|10|31.7|$0.107|0.73|
|legacy standard|8|11.1|$0.055|0.92|
|prod-derived deep|10|67.5|$0.500|0.90|

## What it can and cannot decide

- **Standard and deep now exercise the budget.** The prod-derived standard cases make 31.7 calls and cost $0.107 against
  prod's 34.9 and $0.142; the prod-derived deep cases make 67.5 and cost $0.500 against 75.9 and $0.419. The old suite
  made 2. A call budget is judged on these rows, not on the standard row, which the 8 legacy cases pull down (11 calls).
- **Quick does not look like prod.** The 3 quick cases are the legacy one-fact questions: 1.3 calls against prod's 9.0.
  Quick is 7 % of runs and 1 % of spend, so it is left as is; do not read a quick result as production behaviour.
- **`supported` is 0.90 on deep here against 0.64 in prod drift.** The drift sample is a different, unselected set of
  prod reports and the eval's questions were chosen to have findable answers, so the eval reads higher; compare arms
  with each other, never the eval's level with drift's.
- **One run, no repeat noise.** Each case ran once; a depth row of 3 to 11 cases moves by a case or two between reruns,
  so a difference under about 0.1 in `supported` is not a result. `agw eval compare research --a <fp> --b <fp>` pairs
  the same cases and gives the CIs; it withholds a verdict under 5 pairs.
- **One golden missed** (`prod-deep-claude-code-automation-policy`) and 2 reports are `partial` (`complete` 0.94: `notfound-npm-package`, `prod-standard-claude-code-hooks-semantics`); the
  per-case output holds the reasons and stays under `$AGW_EVAL_DIR`.
- **Limit:** the judge is the `decide` route reading the cited page; no human checked the verdicts.

## Spend

This report: 1 eval run, $6.73 (case runs and judge calls). Two plans (no spend) were read before it. Nothing
was rerun to confirm a refactor.
