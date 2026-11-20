# Effort arms for the Iris triage and gist routes (2026-11-20)

Issue 2522. The question Iris asked: do the `triage` route (the notification text of a memo: headline, detail, spoken line) and the
`llm.summarize` call behind the transcript gist (`cheap.summarize`, 30 words) hold their quality below effort `high`? On a
transcribe-only memo triage is on the path to the notification, and its call latency is the model call.

**Decision: `triage` moves to effort `low` (new constant `QUICK`, `packages/routes/src/table/_shared.ts`). The gist stays on `EASY`
(effort high).** At `low` triage holds on every quality score (no difference whose interval excludes zero) and the call takes 2.0 s
instead of 3.4 s at p50. The gist loses its word bound below `high`: 96 % of gists fit 30 words at `high`, 46 % at
`medium`, 0 % at `low`.

## Method

- **Suites:** `iris-triage` and `iris-gist` (`packages/host/src/workflows/iris-triage/README.md`): the production prompts, replayed
  through the eval harness with a route patch per arm (`agw eval run --arm`), the gateway on the eval reserve (purpose `eval`).
- **Cases:** real Iris memos from the journal (`make eval-mine-iris`; transcripts and replies stay out of the repo). Triage 30: all
  14 transcribe-only memos and 16 with a Hermes reply, spread over the history. Gist 13: every distinct transcript Iris sent (the
  gist runs on transcripts over 400 characters, so the set is every one there was).
- **Arms:** `high` (the table today), `medium`, `low`, `none` (thinking disabled), two repetitions of every case per arm: 60 triage
  runs and 26 gist runs per arm. Paired by case, bootstrap 95 % intervals (`agw eval compare`).
- **Scores:** deterministic language, shape and length checks and the `decide` judge's yes or no on faithful, headline, detail,
  gist, one call per case. The judge says no to a notification with a wrong headline, a wrong detail and an invented spoken line
  (checked on a made-up case: four noes, confidence 0.85 to 0.99). One judge, no human check; a person read 7 triage cases of the
  three arms side by side (below).

## Triage, 60 runs per arm

| Arm | valid | language | spoken ok | faithful | headline | detail | one call | call p50 | call p90 | cost per case |
|-|-|-|-|-|-|-|-|-|-|-|
| high | 60 / 60 | 1.00 | 0.82 | 0.78 | 1.00 | 0.98 | 0.98 | 3.40 s | 5.44 s | $0.00048 |
| medium | 59 / 60 | 0.98 | 0.78 | 0.85 | 0.98 | 0.95 | 0.95 | 2.06 s | 3.60 s | $0.00031 |
| low | 60 / 60 | 1.00 | 0.78 | 0.85 | 1.00 | 0.97 | 0.97 | 1.98 s | 2.46 s | $0.00026 |
| none | 57 / 60 | 0.93 | 0.77 | 0.80 | 0.95 | 0.93 | 0.92 | 2.18 s | 3.59 s | $0.00027 |

(`spoken ok` is the deterministic check: at most two sentences, no markup; the `high` baseline fails it in 18 % of runs, so it measures
the prompt's compliance, not the arm.) Paired difference to `high` (30 cases, 95 % interval):

| Arm | any quality score | wall time of the case run | tokens |
|-|-|-|-|
| medium | none separates from zero (faithful +0.08 [-0.02, +0.17], spoken -0.04 [-0.09, 0]) | -1.14 s [-1.45, -0.82] | -276 [-384, -157] |
| low | none separates from zero (faithful +0.06 [-0.03, +0.16], spoken -0.04 [-0.09, 0]) | -1.44 s [-1.77, -1.12] | -406 [-561, -261] |
| none | language -0.07 [-0.13, -0.02] | -0.97 s [-1.27, -0.67] | -291 [-508, -82] |

Reading: `low` is the knee. `none` is no faster than `low` (2.2 against 2.0 s at p50) and loses: 3 of 60 runs return no answer (the
headline broke the 60-character bound on both attempts, always on the same long transcribe-only memos; `medium` lost one run the same way), the notification is in the wrong language in 4 of 60, and the interval
of that loss excludes zero. `medium` held but failed once of 60 and is 0.1 s slower than `low`.

Side by side, 4 transcribe-only and 3 replied memos, `high` against `low` against `none`: `high` and `low` carry the same facts in the
same register; `low` writes slightly longer details, which the 240-character bound allows. `none` returned no answer on 2 of the 4
long transcribe-only memos and on the rest read like the others. No `low` text was less correct than its `high` twin.

## Gist, 26 runs per arm

| Arm | fits 30 words | fits Iris's 240 characters | faithful | gist | wall time of the case run | cost per case |
|-|-|-|-|-|-|-|
| high | 0.96 | 0.85 | 0.69 | 0.96 | 4.82 s | $0.00078 |
| medium | 0.46 | 0.42 | 0.62 | 0.92 | 2.94 s | $0.00050 |
| low | 0.00 | 0.15 | 0.62 | 1.00 | 1.55 s | $0.00032 |
| none | 0.08 | 0.19 | 0.73 | 1.00 | 1.41 s | $0.00031 |

Paired difference to `high` in the share within 30 words: medium -0.50 [-0.73, -0.23], low -0.96 [-1.00, -0.89], none -0.89 [-1.00,
-0.77]. The lower arms are 1.9 to 3.4 s faster and say the point as well (`gist` and `faithful` do not move), but they ignore the
bound: Iris cuts a gist at 240 characters, so most of them would reach the user cut mid-sentence. The route would need a prompt
that makes the bound hold without thinking; that is a change to the `llm.summarize` prompt, not to the route, and was not tried.
`cheap.summarize` also serves `shop.item`'s summary, which this suite does not measure.

## A finding outside the question

`language` of the gist is 0.58 at `high`: 6 of the 13 transcripts (German) come back summarized in English, because the
`llm.summarize` system prompt names no language. It worsens as effort falls (0.42 low, 0.12 none). The triage prompt names the
language and holds it (1.00).

## Limits

The 60-character headline bound is what a lower effort breaks first: the call is re-asked once and then fails, and Iris then ships the
memo with no summary. `low` lost none of 60 runs, which bounds its failure rate at about 5 % (95 % upper limit, rule of three), not at zero.

30 triage cases and 13 gist cases from one speaker's memos, German with some English. One judge, one decision API, no human check
beyond the 7 cases read. Two repetitions per arm bound the sampling noise only coarsely, and the baseline's own `spoken ok` and
`faithful` scores move by 0.05 to 0.10 between its two repetitions, which is why the intervals above are wide on those two.
`low` here is "adaptive decides" on Haiku: the 2026-11-16 note measured 34 thinking tokens per call at `low` for the factory triage.
