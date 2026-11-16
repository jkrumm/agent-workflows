# The steward's prompt: the lines that push toward a Decision, measured (2026-11-16)

**Decision: `factory.steward` runs the `neutral-wake` wording.** It answered the 14 labelled stalls right 76 % of the time
against 62 % for the wording production had, and it does it by sending fewer stalls to a Decision (precision of
`raise_decision` 0.92 against 0.44) without losing the ones that need one (recall 0.83 against 1.00). The route is unchanged
(`EASY`, Haiku high). The old wording stays as the arm `pushing`.

## Why it was measured

The audit of 2026-11-16: 141 of 144 production steward runs answered `raise_decision` (74 blocked, 53 unreported, 16
regressed; 4 `wake`, 2 `none`), and the Judge answered 132 of the 145 Decisions itself, mostly with the do-nothing default
("keep waiting", "hold"). The prompt pushed that way in three places and had no example for `wake` or `unreported`:

| Line | Where |
|-|-|
| `... and only then reaches the owner: do not shy away from it.` | the `raise_decision` action |
| `When the facts are thin, a Decision is better than a guess ...` | the closing rule |
| `A wake that repeats a stall ... is not a fix: choose raise_decision.` | the closing rule; the audit did not name it, and it matters most |

## The set

`packages/host/src/workflows/factory-steward/eval/cases.jsonl`, 14 stalls, scorer `2026-11-16.1`: 12 real stalls of the
factory's journal rewritten to placeholder repos, ids and titles, and 2 written for the actions the journal never held (a
note that clears a block; a `lead_gone` stall to requeue). The label is the action the Issue's later record shows was
enough, never the steward's own answer:

| Label | Cases | What the journal showed next |
|-|-|-|
| `wake` | 6 | the same lead went on and shipped, with no owner input (a cross-repo block with a signal filed: closed two minutes after the wake; an unreported lead after a host restart, after a verdict note, after two failed wakes, after its Decision was answered); the Decisions the steward had raised for these were answered with the do-nothing default and changed nothing |
| `requeue` | 2 | a lost terminal and a limit that had reset; a fresh lead shipped within the hour |
| `raise_decision` | 4 | a red check outside the change that three re-ships did not clear; a Watch that was wrong, not the repo (owner: "neither"); an upstream gap with a choice between waiting, narrowing and dropping; a red CI gate after every re-ship |
| `none` | 2 | a lead that crashed three times the same way (the guard allows nothing else for `lead_gone`); an Issue stood down on the owner's order, where a wake repeats the stall and only his note resumes it |

## The arms

Three arms, three runs each (`--args {"rep":n}`), the same 14 cases, the same route (`factory.steward`, Haiku high), the
same guard; only the prompt's lines differ. `pushing` is the wording of the table above. `neutral` replaces the first two
lines (`Raise one when the work needs a choice, not to avoid answering`; `Choose the action the facts support. When they
support none of wake, requeue or a Decision, answer none`). `neutral-wake` also replaces the third (`a reason to read the
facts again: raise a Decision only when they show a choice is needed`).

| Arm | Fingerprint | Params |
|-|-|-|
| `pushing` | `a01716f4` | `{"stewardWording": "pushing"}` |
| `neutral` | `5893f0f1` | `{"stewardWording": "neutral"}` |
| `neutral-wake` | `32bb6218` | `{"stewardWording": "neutral-wake"}` |

## Result

Mean of the three runs of each arm (the three figures are the runs):

| Score | `pushing` | `neutral` | `neutral-wake` |
|-|-|-|-|
| Correct (42 case runs) | 62 % (64, 57, 64) | 71 % (71, 79, 64) | **76 %** (86, 79, 64) |
| `recall.wake` (6 cases) | 0.33 | 0.44 | **0.72** |
| `precision.wake` | 1.00 | 1.00 | 0.88 |
| `recall.raise_decision` (4) | 1.00 | 1.00 | 0.83 |
| `precision.raise_decision` | 0.44 | 0.55 | **0.92** |
| `recall.requeue` (2) / precision | 1.00 / 0.89 | 1.00 / 0.78 | 1.00 / 0.78 |
| `recall.none` (2) / precision | 0.33 / 1.00 | 0.67 / 1.00 | 0.50 / 0.33 |
| USD per 14-case run | 0.0116 | 0.0114 | 0.0105 |

Paired by case (per-case mean over the three runs, bootstrap 95 %, seed 7), correct: `neutral` against `pushing` +9.5 points
[−4.8, +28.6], 2 cases better, 1 worse; `neutral-wake` against `pushing` +14.3 [−7.1, +35.7], 5 better, 2 worse;
`neutral-wake` against `neutral` +4.8 [−11.9, +23.8].

By case, `neutral-wake` repaired `wake-unreported-decision-answered` (0 of 3 to 3 of 3: the open Decision was answered at the last
event, the lead only had to hear it), `wake-cross-repo-route` (0 to 2), `none-stood-down-by-owner` (0 to 2; `neutral` 3) and
two unreported-lead wakes (0 to 1 each), and lost `decision-regressed-pending-update` (3 to 1: it woke or answered none instead
of raising) and `none-lead-gone-same-crash` (2 to 1).

## What it decides and what it cannot

- **Decides:** the three lines do what the audit suspected. With all three the steward raised a Decision on 9 of 14 stalls (4 of
  them labelled so) and woke correctly on 2 of 6 stalls where a wake was enough; without them it raised on about 4 and woke
  correctly on about 4. `neutral` alone moved the score 9.5 points; adding the wake rule moved it 4.8 more and the wake recall from
  0.44 to 0.72, the one place where the third line matters most (a lead that is idle after a failed wake is not a choice).
- **Decides, weakly:** every interval for the difference contains 0. 14 cases are 7 points each, and the three runs of one arm
  differ by up to 21 points. The direction held in every metric the Issue named, which is why the wording changes at no price:
  the new prompt costs the same, and the route is unchanged.
- **What it costs:** more `none` (precision 0.33) and more wakes that were not enough (0.88): a `none` makes the factory raise
  a Decision of its own after a few of them, so the over-quiet error costs one cycle, where the over-raised Decision cost the
  Judge a call and the owner a card. The two cases it lost are the ones to watch.
- **Cannot decide:** whether 98 % `raise_decision` was wrong in production. The set is 14 stalls chosen to cover every
  action: it has far more `wake` and `requeue` than production does, so the correct rate here is no estimate of the production one.
  The labels are one reader's, from what the journal shows happened next; an Issue that shipped after a Decision might have
  shipped without it, and one that shipped after a wake might have shipped after a Decision too. Two of the six `wake` labels
  (a lead idle after a host restart) rest on the factory's own restart note, which the steward could not see.
- **Next count:** the share of `raise_decision` in the steward's production runs after this deploy (it was 98 %), and the Judge's
  share of owner-escalated Decisions among them.

## Reproduce

```
agw eval run factory-steward --yes --args '{"rep":1}'                              # neutral-wake, the route as the table has it
agw eval run factory-steward --yes --args '{"rep":1}' --arm pushing.json           # { "params": { "stewardWording": "pushing" } }
agw eval run factory-steward --yes --args '{"rep":1}' --arm neutral.json           # { "params": { "stewardWording": "neutral" } }
```

Rollback: `DEFAULT_STEWARD_WORDING` in `packages/capabilities/src/capabilities/factory-steward.ts` to `pushing`.
