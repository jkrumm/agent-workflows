# Claude seats, measured (Wave 6, 2026-11-02)

**Change:** agw's agent and text seats move off DeepSeek and onto Claude tiers where an eval suite exists, picked per
workflow on score first, then wall time (docs/gateway.md §Seats). Every arm ran with purpose `eval` on the Claude credit
under the credit-pacing reserve (docs/gateway.md §Credit pacing): all Claude calls landed `api_credit` on the `me` pool
while production stayed on `iu`, and no eval request was refused or sent to IU.

**Verdict:**

| Route | Before | Pick | Why |
|-|-|-|-|
| `research.agent` | DeepSeek flash | **Sonnet 5.5 medium** (`HARD.agent`) | ties DeepSeek on every score over 20 paired cases and is 6 s faster (CI excludes 0); beats Haiku high on `supported` beyond the CI; Opus is no better beyond the CI, 3x the cost and 6 s slower |
| `otel.agent` | DeepSeek flash | **Haiku 5.5 high** (`EASY.agent`), owner override 2026-11-02 18:10; measured pick was Sonnet 5.5 medium | ties DeepSeek and Sonnet medium on every score (8 cases, two reruns); Sonnet was 13 s faster beyond the CI, Haiku high $0.039 cheaper per run [0.030, 0.042]; Opus no better beyond the CI, 4.5x the cost and 23 s slower |
| `diagram.agent` | Sonnet 5.5 medium | **Haiku 5.5 none** (`FAST.agent`) | ties Sonnet on every score (6 cases, two reruns; pass 1.00 against 0.92) and is 3.9 s faster per diagram (CI excludes 0) |
| `brain.agent` | Haiku 5.5 high | unchanged | Sonnet adds +0.05 facts on 10 cases, inside the noise, at 20x the cost and slower |
| `check` | Haiku 5.5 high | unchanged | every arm scores the same (0.86); Haiku high has the lowest p50 wall |
| `prose.review` | DeepSeek flash | unchanged (cross-lab) | best score agreement (0.91 against 0.83 to 0.85 for Terra low/medium and Luna low); it reviews Claude output, so Claude arms are not eligible |
| podcast stages | DeepSeek flash / Terra high | Sonnet medium (`research`, `editorial`, `outline`, `write`), Haiku high (`metadata`), Terra medium (`review.b`, cross-lab) | no eval suite (Wave 15); by principle, the tool loop now speaks Messages (#107) |

No route moved to Opus: no arm showed Opus beating Sonnet beyond the CI. `review.*` was left alone (owner,
2026-11-02: Wave 11's review v2 sweep sets the review seats); the same day an owner hotfix moved `review.angle` back to
Haiku high for cost (#109; a live standard review cost $0.158, its four angles $0.077).

**What the numbers can and cannot decide.** The suites are small (6 to 20 cases), so most score differences sit inside
the bootstrap CI; the picks rest on ties plus a wall-time difference the CI does separate. Research's 20 cases are
mostly lookup questions every arm passes; `supported` (claims the judge finds in the cited pages) is the one metric that
moves. The prose score agreement is measured against references recorded on DeepSeek, which favours the baseline. Sonnet
at effort low and medium spent almost no reasoning tokens in agent steps (adaptive thinking; mean 0 to 28 per case),
Haiku high spent 276 to 1,500, so Sonnet's effort levels are close to one arm here.

## Case sets and scorers

Cases under `$AGW_EVAL_DIR`, ids not listed (public repo). Slices: the suite's case order, first N.

| Suite | Cases run | Scorer | Judge |
|-|-|-|-|
| research | 20 of 28 (3, widened to 10, then 20) | `2026-10-29.3` | `decide` (IU), unarmed |
| otel | 8 of 8 (4, widened to 8; two reruns for the close arms) | `2026-10-29.1` | `decide` (IU), unarmed |
| brain | 10 of 10 | `2026-10-29.1` | `decide` (IU), unarmed |
| check | 7 of 7 | `2026-10-28.1` | none |
| diagram | 6 of 6 (two reruns for the close arms) | `2026-10-29.1` | none |
| prose | 10 of 10 | `2026-10-29.1` | none |

## Per arm

Means over case runs (reruns included). Cost is per case run, from the journal (`runs.cost`, the run tree); wall in
seconds; tokens are means per case run (input, cache read, output, reasoning). Baseline = the table at release `e8205e5`.
No arm had a failed case run except where noted.

| Suite | Arm | Fingerprint | Runs | Pass | Key scores | Cost/case | Wall p50 / max | In / cache read / out / reasoning |
|-|-|-|-|-|-|-|-|-|
| research | baseline (DeepSeek flash) | `621fe6eee971` | 20 | 1.00 | supported 0.91, complete 1.00 | $0.0074 | 7.2 / 94.8 | 30.1k / 24.1k / 1.6k / 764 |
| research | Haiku none | `0f8c4ec8348f` | 3 | 1.00 | supported 0.56, complete 0.67 | $0.0030 | 6.1 / 6.1 | 10.2k / 7.4k / 526 / 0 |
| research | Haiku high | `c3811c627cf8` | 20 | 1.00 | supported 0.79, complete 1.00 | $0.0045 | 7.2 / 21.3 | 19.6k / 14.4k / 1.1k / 276 |
| research | Sonnet low | `f7b37cdc6310` | 3 | 1.00 | supported 0.67, complete 1.00 | $0.0211 | 5.2 / 7.3 | 13.1k / 7.5k / 505 / 28 |
| research | **Sonnet medium** | `6167945d421f` | 20 | 1.00 | supported 0.88, complete 0.95 | $0.0161 | 6.2 / 14.3 | 16.9k / 13.9k / 585 / 0 |
| research | Opus medium | `ade998455947` | 20 | 1.00 | supported 0.93, complete 1.00 | $0.0525 | 10.2 / 36.7 | 23.0k / 17.6k / 1.0k / 28 |
| otel | baseline (DeepSeek flash) | `9c00e614b93c` | 8 | 0.50 | facts 0.81, status 0.88 | $0.0192 | 48.9 / 73.6 | 295k / 263k / 6.7k / 2.5k |
| otel | Haiku none | `c3aa9f835dec` | 4 | 0.25 | facts 0.50, status 0.75 | $0.0056 | 17.9 / 24.6 | 113k / 87k / 2.9k / 0 |
| otel | Haiku high | `10a1aee9dbbc` | 16 | 0.63 | facts 0.81, status 1.00 | $0.0063 | 26.9 / 40.6 | 128k / 104k / 4.4k / 1.5k |
| otel | Sonnet low | `44568458520f` | 4 | 0.00 | facts 0.38, status 1.00 | $0.0490 | 12.2 / 15.2 | 40k / 27k / 1.2k / 0 |
| otel | **Sonnet medium** | `625fc22f9367` | 16 | 0.63 | facts 0.78, status 0.88 | $0.0408 | 11.8 / 23.5 | 48k / 38k / 1.4k / 17 |
| otel | Opus medium | `f675b048f769` | 16 | 0.69 | facts 0.88, status 0.94 | $0.1864 | 34.1 / 63.9 | 120k / 101k / 3.5k / 258 |
| brain | **baseline (Haiku high)** | `63050c041fc3` | 10 | 0.90 | facts 0.80, reference 0.90 | $0.0020 | 7.2 / 14.4 | 28.7k / 19.2k / 1.3k / 344 |
| brain | Haiku none | `1a0f82814cfa` | 10 | 0.80 | facts 0.80, grounded 0.98 | $0.0017 | 6.4 / 10.8 | 25.7k / 17.3k / 1.0k / 0 |
| brain | Sonnet low | `cf3e36754f7b` | 10 | 0.90 | facts 0.85 | $0.0390 | 9.5 / 48.2 | 56.5k / 46.5k / 939 / 9 |
| brain | Sonnet medium | `2504195cff06` | 10 | 0.90 | facts 0.85 | $0.0401 | 10.2 / 38.0 | 59.6k / 50.0k / 1.1k / 13 |
| check | **baseline (Haiku high)** | `1b5ac707fe48` | 7 | 0.86 | step/outcome agreement 0.86 | $0.0003 | 3.4 / 141.9 | 4.2k / 2.5k / 135 / 49 |
| check | Haiku none | `e4366a605748` | 7 | 0.86 | 0.86 | $0.0002 | 4.1 / 208.6 | 2.6k / 1.7k / 81 / 0 |
| check | Sonnet low | `6a685832b29f` | 7 | 0.86 | 0.86 | $0.0062 | 4.3 / 214.0 | 5.4k / 3.5k / 112 / 17 |
| check | Sonnet medium | `19c2bc37bd65` | 7 | 0.86 | 0.86 | $0.0033 | 5.5 / 204.7 | 4.1k / 3.2k / 74 / 0 |
| diagram | baseline (Sonnet medium) | `3c6ab5c359ad` | 12 | 0.92 | overlaps 0.08 | $0.0319 | 12.6 / 32.2 | 13.3k / 11.0k / 2.5k / 194 |
| diagram | **Haiku none** | `427da66d743d` | 12 | 1.00 | overlaps 0.25 | $0.0021 | 8.2 / 16.6 | 17.2k / 14.2k / 3.1k / 0 |
| diagram | Haiku high | `0960391b3659` | 6 | 0.83 | overlaps 0.00 | $0.0049 | 33.3 / 61.9 | 13.3k / 8.6k / 8.4k / 5.6k |
| diagram | Sonnet low | `fd8944ae6c44` | 6 | 0.83 | overlaps 0.17 | $0.0350 | 11.0 / 23.6 | 13.3k / 8.6k / 2.3k / 0 |
| prose | **baseline (DeepSeek flash)** | `20875c3161dd` | 10 | 1.00 | score agreement 0.91 | $0.0025 | 16.7 / 29.8 | 5.1k / 1.3k / 3.2k / 2.0k |
| prose | Terra low | `622d93104fb5` | 10 | 1.00 | 0.83 | $0.0089 | 8.2 / 15.9 | 3.8k / 0 / 1.0k / 434 |
| prose | Terra medium | `4360b35a01fd` | 10 | 1.00 | 0.85 | $0.0089 | 8.6 / 13.6 | 3.8k / 0 / 1.0k / 442 |
| prose | Luna low | `aeb76f55596a` | 10 | 1.00 | 0.85 | $0.0012 | 15.3 / 20.7 | 3.8k / 0 / 1.6k / 1.2k |

`overlaps` is higher-is-better in the scorer (the share of diagrams without overlapping elements). Failed case runs:
one, otel Sonnet medium (`invalid_output`: the agent ended without submitting the findings JSON), 1 of 16.

## Paired comparisons (`agw eval compare`, seeded bootstrap 95% CI of the mean delta, B − A)

| Suite | A → B | Paired | Score deltas (CI) | Wall delta | Cost delta |
|-|-|-|-|-|-|
| research | DeepSeek → Sonnet medium | 20 | supported −0.03 [−0.09, 0], complete −0.05 [−0.15, 0] | −6.2 s [−16.2, −0.1] | +$0.009 [0.004, 0.013] |
| research | DeepSeek → Haiku high | 20 | supported −0.12 [−0.22, −0.03] | tie | tie |
| research | Haiku high → Sonnet medium | 20 | supported +0.08 [0.01, 0.18] | −1.5 s [−2.8, −0.4] | +$0.012 |
| research | Sonnet medium → Opus medium | 20 | supported +0.06 [0, 0.17], complete +0.05 [0, 0.15] | +6.0 s [3.6, 8.9] | +$0.036 [0.022, 0.056] |
| otel | DeepSeek → Haiku high | 8 | pass +0.13 [0, 0.38], status +0.13 [0, 0.38] | −22.9 s [−34.9, −10.9] | −$0.013 |
| otel | DeepSeek → Sonnet medium | 8 | pass +0.13 [0, 0.38], valid −0.13 [−0.38, 0] | −36.2 s [−48.3, −24.6] | +$0.027 |
| otel | Haiku high → Sonnet medium | 8 | status −0.13 [−0.38, 0], valid −0.06 [−0.19, 0] | −13.3 s [−17.0, −9.8] | +$0.039 [0.030, 0.042] |
| otel | Sonnet medium → Opus medium | 8 | facts +0.09 [−0.09, 0.34], status +0.06 [0, 0.19] | +23.4 s [16.3, 32.0] | +$0.145 [0.105, 0.195] |
| diagram | Sonnet medium → Haiku none | 6 | pass +0.08 [0, 0.25], overlaps +0.17 [−0.25, 0.75] | −3.9 s [−8.5, −0.2] | −$0.030 [−0.042, −0.018] |

otel is the closest call: Sonnet medium and Haiku high tie on score, Sonnet is faster beyond the CI (the rule's
tie-breaker), and Sonnet's one `invalid_output` is the failure mode to watch on the next otel eval.

**Owner override (2026-11-02 18:10): `otel.agent` runs Haiku 5.5 high (`EASY.agent`).** The rule above weighs cost only
past the credit pacing line, and production is now past it (Wave 7: iu dry around 3 Nov at the first day's rate). On
that footing the tie on score goes to the cheaper arm: Haiku high costs $0.0063 a run against Sonnet's $0.0408, and the
13 s it gives up is not worth credit an over-pace month does not have. `research.agent` stays Sonnet medium (it beat
Haiku high on `supported` beyond the CI), `prose.review` stays DeepSeek flash, `review.adversary` is unchanged.

**Owner override (2026-11-03): `research.agent` runs Haiku 5.5 high (`EASY.agent`)**, reversing "stays Sonnet medium"
above. The credit runs dry around 3 Nov (iu) and 4 Nov (me) at production's pace, and research is a steady consumer.
The measured cost of the switch: `supported` 0.79 against Sonnet's 0.88 (−0.08, CI [−0.18, −0.01]) at $0.0045 a case
against $0.0161, wall a tie. The owner takes the quality gap for the credit; a later research eval decides whether it
moves back.

## Spend

| Where | Amount |
|-|-|
| Claude credit (`api_credit`, pool `me`, purpose `eval`) | $6.91, 723 gateway rows |
| IU (`api_key`: the DeepSeek and GPT arms, the `decide` judge) | $0.36, 515 rows |
| All eval runs, journal tree cost | $7.58 (the rest: web tools and search inside research) |

The credit pacing line held: `iu` was over its pro-rata reserve all day, so every eval call went to `me` (eval headroom
$19.25 at the start, $12.57 at the end); `gateway_picks` has no `eval-reserve` refusal.
