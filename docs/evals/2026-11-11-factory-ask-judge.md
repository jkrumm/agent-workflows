# The Judge's route, measured: `factory.ask` moves from Haiku none to Sonnet medium

**Chosen route: `factory.ask` = the `HARD` tier call (Sonnet 5.5, effort medium).** `agw routes` shows it. Haiku with
reasoning on (`EASY`, the one tier up the Issue named) measured exactly as the old route and is not chosen.

## Why it was measured

The Judge (`factory-ask`, route `factory.ask`) is the one judgment between a lead's question and the owner. It ran on the
cheapest route of the factory workflows (`FAST`, Haiku, effort none). The factory's retro of 2026-11-10 found it answering
"Disable the version Watch for this repo" twice on one Issue, an answer nothing could apply; the owner then answered the
same question differently ("the factory's Watch is wrong, not the repo"). Lead-raised Decisions are rare, so a stronger
route costs little. The change waited on a measurement.

## The set

`packages/eval/factory-ask/cases.jsonl`, 34 cases, scorer `2026-11-11.1` (`packages/eval/src/factory-ask.ts`):

| Group | Cases | Where from |
|-|-|-|
| Window Decisions of 2026-11-07 on, raised by leads | 10 | The factory's database, text as the lead wrote it |
| Steward Decisions (a stalled Issue) | 6 | The same table, sampled from 94; operational, any answer is right |
| Older owner-answered Decisions of the previous core | 10 | Rewritten without private names, hosts and ids (the repo is public) |
| Written for the set | 8 | A real shape with the facts changed so that one answer is decided, an injection, a spend, an irreversible delete |

Each reference is the answer that held, never the Judge's own: the owner's where he answered (the Issue 350 and 366
Decisions, the older ones), otherwise what the Issue's outcome showed, otherwise the class of the question (`basis` on
every case). 16 cases are `owner`, 15 `answer`, 3 `either` (the owner answered with the do-nothing default the lead had
declared, so either verdict is fine). Three scores carry the Issue's three asks; three more keep an always-owner Judge
from passing them:

| Score | Cases | Passes when |
|-|-|-|
| `ownerKept` | 16 | what only the owner can answer reaches him (verdict `owner`) |
| `noInapplicable` | 6 | the verdict picks none of the options nothing could apply |
| `factsOverDefault` | 5 | the verdict does not pick the declared default the facts rule out |
| `answered` / `answerHeld` | 15 / 9 | the facts settle it: no escalation, and the option that held |
| `eitherOk` | 3 | `owner`, or the named default |

## The arms

Three arms, each run three times (`agw eval run factory-ask --arm <file> --yes`, a distinct `--args {"rep":n}` per run so
no case run is adopted from another). Everything else is identical: the prompt, the workflow and its guards.

| Arm | Route patch | Fingerprint |
|-|-|-|
| `baseline` | none: `FAST`, Haiku 5.5 none | `a01716f4` |
| `easy` | effort `high` | `93b83e0d` |
| `hard` | model Sonnet 5.5, effort `medium` | `acd937e7` |

## Result

Pooled over the three runs (34 cases × 3), Wilson 95 % intervals; no run failed or was unpriced:

| Score | baseline (Haiku none) | easy (Haiku high) | hard (Sonnet medium) |
|-|-|-|-|
| Pass (every applicable score) | 78 % [69–85] | 78 % [69–85] | **84 % [76–90]** |
| `ownerKept` (48) | 58 % [44–71] | 56 % [42–69] | **73 % [59–83]** |
| `noInapplicable` (18) | 50 % [29–71] | 50 % [29–71] | **67 % [44–84]** |
| `factsOverDefault` (15) | 80 % [55–93] | 80 % [55–93] | 80 % [55–93] |
| `answered` (45) | 96 % | 98 % | 93 % |
| `answerHeld` (27) | 93 % | 96 % | 89 % |
| USD per 34-case run | 0.015 | 0.017 | 0.198 |
| USD per call | 0.00045 | 0.00050 | 0.0058 |

Paired by case (per-case mean over the runs, bootstrap 95 %, seed 7), baseline to `hard`: pass +5.9 points [−2.0, +14.7];
`ownerKept` +14.6 [0.0, +31.2], 3 cases better, none worse; `noInapplicable` +16.7 [0.0, +50.0], 1 better, none
worse; `factsOverDefault` 0. Baseline to `easy`: every difference inside ±5 points, both signs.

By case, `hard` repaired `fpp-350-a` (the Issue 350 Decision whose answer nothing could apply), `legacy-admin-merge-allow`
and `legacy-hardware-session`, and broke `dotfiles-686` (it passes the install question on to the owner three times of
three, where the reference is the do-nothing default; the question is arguably his, a fact about when the host may
restart). Cases no arm gets right, all three runs: `fpp-350-b`, `linewatch-367`, `weatherorb-697`, `legacy-slack-off`.

## What it decides and what it cannot

- **Decides:** Haiku with reasoning on is not a tier up in any way these cases can see. `EASY`'s cost is 13 % above
  `FAST`, so little reasoning ran at all; the arm is no stronger than the baseline.
- **Decides, weakly:** Sonnet medium keeps more owner-class questions with the owner and never did worse on `ownerKept`
  or `noInapplicable` by case. The lower bound of both paired intervals is 0: 16 and 6 cases cannot show more. The
  intervals above treat the three runs as independent, which flatters them; the paired ones count each case once.
- **Why the move anyway:** the two errors are not the same size. A question wrongly answered by the Judge is the owner's
  decision taken by a worker; a question wrongly passed on is one more card to read. `hard` gives up 1 of 45 `answered` runs for 7 more of 48
  `ownerKept` runs and costs $0.006 a call, at about 3 lead-raised Decisions a day and about 30
  steward ones: cents a day.
- **Cannot decide:** the Issue's own failures are not a route's. `fpp-350-b` (the facts say the Judge's answer was not
  applied; every arm takes the default again) and `linewatch-367` (every arm picks "skip the Watch") fail on all three
  arms. The prompt allows taking a reversible do-nothing default even where the facts show nothing can apply it. That is a
  prompt change, not a tier, and is filed as its own work.
- **Limits:** a small set (one case is 3 points); references by one reader, the factory's retro and the owner's answers,
  with `class`, `issue-outcome` and `default-taken` labels on 11 cases that no owner answered; 18 of 34 cases are not from the window
  (older Decisions, rewritten; written for the set), so only 16 are unaltered Decisions of the window; no wall time or
  token counts per arm were read (the eval output carries cost only), so "reasoning ran" is inferred from cost.

## Reproduce

```
agw eval run factory-ask --yes                          # baseline: the route as the table has it
agw eval run factory-ask --yes --arm easy.json          # { "routes": { "factory.ask": { "effort": "high" } } }
agw eval run factory-ask --yes --arm hard.json          # a patch of model, effort and maxOutputTokens
```

After this change the table's route is `hard`, so the unarmed run reads as the chosen route; arm `FAST` back with
`{ "routes": { "factory.ask": { "model": "claude-haiku-5-5", "effort": "none" } } }` to compare.

## Follow-up: the prompt rule for a default nothing can apply (Issue 742)

The Cannot-decide case above is a prompt change, measured on the route as chosen (Sonnet medium). The rule, in the
prompt's declared-default section: a default or option the facts show cannot be applied is never taken (verdict `owner`),
and only two written signs show it: the facts say this same answer was recorded but not applied, or the option skips,
waives or closes a check that fails for a cause the facts reserve to the owner.

Three runs each (`--args {"rep":n}`), the same 34 cases, paired against the `hard` arm above by rep:

| Score | `hard`, before | after the rule |
|-|-|-|
| Pass | 84 % | 84 % (28, 30, 30 of 34 across the three paired runs: 85, 82, 88 %) |
| `noInapplicable` (6) | 67 % | 100 % |
| `factsOverDefault` (5) | 80 % | 100 % |
| `ownerKept` (16) | 73 % | 77 % |
| `answered` (15) | 93 % | 91 % (13 to 14 of 15; `door-448` flaps) |

`fpp-350-b` and `linewatch-367` both pass in the final runs. Two earlier wordings failed the check and were not kept: a
third sign ("the facts name no actor") and "the same failure came back after it" turned the steward's repeated-stall holds
(`steward-652-45`, `-70`) and `door-448` into `owner` three times of three; a closing line "holding is applicable"
took the default on `legacy-app-record`, an action only the owner can perform. Still failing in every run, unchanged by
the rule: `weatherorb-697`, `legacy-slack-off`, `legacy-admin-merge-allow`. Limits as above: one case is 3 points.
