# Lead handoff — Wave 8 (Ground truth), second half: CLOSE-OUT (mining continues on credit)

Lead `agent-workflows-w1-r14`, spawned by mother `agent-workflows-w1-r4`, 2026-11-03 01:35 → 03:30 CET. Wave 17's
close-out is in git history (`d7bdc76`); Wave 8's first half (mine, labels, the shortfalls) at `e637fcc`.

**Limit, for every number below: LLM consensus (labellers a/b/c, judges a/b), no human check.**

## Delivered

| What | Where |
|-|-|
| `agw agents` and the `overview` workflow read `factory fleet --format json` (`FACTORY_TOKEN` in `.env.tpl`); the hc / Claude registry / transcript / git / ask-human collectors are deleted; agw adds only recommendations and the Max quota. Non-strict parse (an unknown factory state degrades one row to `unknown`); a failed or errors-only read skips the Argo push and fails the classify step; stdout/stderr byte-capped | #123 `02c0cbe` |
| AGENTS.md lines: agw (gotcha), dotfiles `AGENTS.md` + `docs/herdr-core.md` (the factory is the one producer) | `02c0cbe`, dotfiles `7e08890`; software-factory-w7 told by `rd say` |
| Labeller `c` (`eval.label.c`, Gemini 3.8 Flash, own version, only on a/b disagreements), accept on 2 of 3 with overlapping locations, `no-location` / `c-no` / `c-no-overlap` reasons, append-only label records; judge `b` (`eval.judge.b`, Terra medium, own version; judge a's version unchanged); `agw eval gt calibrate` (κ with CI, resumable via `judge-b.jsonl`); the review scorer reads `judge-calibration.json` at host start (single judge at κ ≥ 0.8 for both current versions, else dual with disagreements `unclear`); `agw eval gt pack|ingest` and `gt-owner/` deleted, no shim; every GT output carries `limit` | #124 `711632f` |
| Eval commands run as purpose `eval` without `AGW_PURPOSE` (`EVAL_WORKFLOW_IDS`, an explicit header wins) | #125 `360e5f8` |
| Deployed | release `360e5f8`, `make verify` PASS (also PASS at `02c0cbe`) |
| Owner pack files under `$AGW_EVAL_DIR/review-gt/owner/` | deleted |

Reviews: `agw review` on every PR. #123: 2 blocking (closed state enum; a failed read pushed an empty fleet to Argo) →
fixed; re-review 2 more (unbounded stderr; an errors-only exit-0 read) → fixed. #124: 2 blocking (calibration could pair
judge b with itself; it accepted judge runs of another version) plus mine (the PR bumped judge a's version, which would
have thrown away the 100 stored judge-a calls) → fixed; re-review 1 blocking (a defect without a location never asked
seat c) → fixed. #125 clean, nits left. Merged by the train on green CI and a passing local `make check` (load ~5).

## Proofs (live)

- `agw agents`: 26 agents in 11 projects, 5 human asks, quota for iu/me/me2, no warnings; the next Argo push from the
  new release `201`, 26 agents.
- Scorer at host start: `2026-11-03.v4+eval-judge-ced286944fd4+judges:single: κ 0.930 clears the bar 0.8`.
- `agw eval mine review` with no `AGW_PURPOSE`: run `01a19f3a-854b` has purpose `eval`.

## Ground truth now (private detail under `$AGW_EVAL_DIR/review-gt/`)

- **Judge calibration** (`judge-calibration.json`): 100 pairs (32 judge-a positive, 68 negative, from the 43 stored
  judge-a runs), **κ 0.93 (95 % CI 0.85–1.00)**, raw agreement 0.97 (30 yy, 67 nn, 2 a-yes/b-no, 1 a-no/b-yes). The bar
  holds: one judge scores. Caveat: on unmatched findings' classes the judges agree only 0.58 (a's `nit` is b's `real`
  37 of 152 times), so `noise` and `realOther` are judge a's view; recall and false alarms do not depend on them.
- **Third labeller backfill**: all 39 a/b disagreements asked; +5 accepted (all `b+c`), 34 `c-no`.
- **Cases**: **43 bug cases** (10 dev, 33 test; paths a+b 38, b+c 5) and **100 controls** (28 dev, 72 test).
  174 labelled, 131 rejected (both-no 90, c-no 41). Acceptance 25 % overall, 3 of the last 24 (12.5 %).

## Spend (this lead, purpose eval workflows)

| Payer | USD | What |
|-|-|-|
| IU personal key | 2.70 | labeller c 1.77 (Gemini; ≈ $0.038 per call), labeller b 0.38, judge b 0.55 |
| `me` credit (eval reserve) | 0.56 | labeller a, 12 candidates |
| `iu` credit, as `prod` | 0.52 | labeller a, 12 candidates: **my error**, the first two commands ran without `AGW_PURPOSE=eval`, so they bypassed the reserve (the 39 c calls and the calibration were also tagged `prod` on the IU key). #125 closes it |

IU eval spend this wave ≈ $2.70 (the first half's $3.32 was before the $20 line was set).

## Why mining stopped, and when the rest follows

`me` eval credit is spent ($0.05 left at 03:10); `iu` is not eval-eligible, `me2` is disabled. Per labelled candidate:
≈ $0.047 credit (labeller a) + ≈ $0.028 IU (b, plus c on ~30 %). At 15–25 % acceptance the remaining **157 bug cases
need ~630–1 050 candidates**: ≈ $30–49 of credit and ≈ $18–29 of IU.

- Credit: `evalAvailableUsd` on `me` grows ≈ $3.2–3.7/day, so ≈ 70 candidates (≈ 10–17 cases) a day. Run daily, sized to
  `/health`: `agw eval mine review --label <evalAvailableUsd / 0.05> --yes --commit` (purpose `eval` is now the default).
  ≈ 9–15 days to 200 (≈ 11-12 to 11-18), sooner once `me2` is claimed (+$100).
- **IU line**: the ~$20 IU stop is reached after ≈ 620 more candidates (≈ 90–155 more cases, so ≈ 135–200 in total).
  Past that the mother decides (message first, per the rule).
- No seeded defects: the end of mining is not reached; seed only if fewer than 150 survive when it is.

## Left behind

- Mining toward 200 bug cases: daily runs as above (controls are at 100).
- `agw agents`: `ahead`/`behind` are 0 (the factory has no upstream counts; Argo requires numbers); `workspaceId`,
  `claudeStatus`, `lastPrompt` are always null; `lastReply` is the digest headline; IuRoot sessions are in the Argo push
  as before (titles only; the factory never digests them).
- The `overview.classify` prompt (packages/capabilities) still mentions transcript excerpts and "commits ahead".
- Labeller c costs ~2.5x labeller b per call (82 gateway rows for ~42 asks: check for retries on its structured output).
- Not taken from reviews: unusable judge-b answers are re-asked on a rerun; a stop while seat a/b is in flight loses the
  answered seat (at-least-once cost); `judgeBoth` drops judge a's answer when b fails; dual mode doubles judge fan-out.
- `packages/host/test/review.test.ts` "ocr is handed the gateway…" failed once on CI with `IU_KEY_ID=` in ocr's env
  (another test's process env leaking); passed on rerun. Watch it.
