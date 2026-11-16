# factory-steward

software-factory's supervisor asks, for one stalled Issue, what it needs when the factory's own rules do not say: wake it,
requeue it, or raise a Decision. The factory never calls a model (SF2), so the judgment lives here. The deterministic part
(a window that opened, a note to deliver, a lead that took a turn) stays in the factory; only the rest reaches this workflow.

```
echo '{"issue":"issue_12","repo":"app","title":"…","kind":"bug","cause":"blocked","detail":"…","stalledMinutes":45,"attempt":1,"restarts":0,"regressions":0,"stewardWakes":0,"notes":[],"history":[]}' | agw factory-steward
```

| | |
|-|-|
| Input (stdin JSON) | `{issue, repo, title, kind, cause, detail, stalledMinutes, attempt, restarts, regressions, stewardWakes, notes[], history[]}`; the CLI reads it as the workflow's one `stall` property, so the HTTP body is `{"stall": {…}}`. `cause` is `wall`, `unreported`, `blocked`, `lead_gone` or `regressed`. `title`, `detail`, `notes` and `history` are untrusted data |
| Output | the run envelope's `output`: `{action: wake\|requeue\|raise_decision\|none, note, reason, decision}`. `decision` is the full Decision form (`question`, `recommendation`, `checked`, `options[{label, reversible, cost}]`, `noAnswer{consequence, default, waitMinutes}`) for `raise_decision` and `null` otherwise |
| Shape | one journaled step (`steward`), one tool-free call to the internal `factory.steward` capability |
| Pending | exit 10 like every workflow (`agw run wait <runId>`) |

## Decisions

- **The call is a capability.** `factory.steward` (`packages/capabilities/src/capabilities/factory-steward.ts`) builds the
  prompt, so nothing reachable over HTTP is a free prompt on the route; it is `internal`.
- **Data is fenced.** Title, detail, notes and history sit under one per-call random fence with the markers made inert, rules
  before and a re-assertion after. The cause, the counts, the Issue id and the repo are the factory's, outside the fence.
- **Three actions and a refusal to guess.** `wake` ends every stall but `lead_gone`; `requeue` ends only `lead_gone`;
  `raise_decision` (never for `lead_gone`: an answer cannot start a new attempt) hands a choice on (the factory settles it by policy, then the Judge, then the default, then the owner);
  `none` means the steward cannot tell.
- **Code guard.** `guardSteward`, applied by the workflow after the step so a replay gets it too: a `requeue` of another
  stall, a `wake` or a `raise_decision` of `lead_gone`, a Decision with duplicate labels, a recommendation that is not an option, a default that is
  not a reversible option, or a default without its wait becomes `none`.
- **Fail closed.** Any failure of the call gives `{action: none, reason: 'steward unavailable: <class>'}` instead of a failed
  run; the factory raises a Decision of its own after a few `none` answers. A cancel, a shutdown (`InfraError`) or an aborted
  run still propagates to the runtime.

## Route

`factory.steward` (`packages/routes/src/table/factory.ts`): the `EASY` tier (Haiku high); the model lives only in the tier.

## Eval

`agw eval run factory-steward [--arm <file>] [--yes]` replays `eval/cases.jsonl` (14 cases, committed): real stalls of the
factory's journal rewritten to placeholder repos, ids and titles (`example-app`, `issue_N`), plus the shapes the journal never
held (a `lead_gone` stall to requeue, a note that clears a block). The reference is the action that the Issue's later record
shows was enough, never the steward's own answer; each case's `basis` says which record (`issue-outcome`: what the factory's
journal shows happened next to that Issue; `owner-answer`: what the owner answered; `rule`: the guard decides it; `written`).
By label: 6 `wake`, 2 `requeue`, 4 `raise_decision`, 2 `none`.

The scorer (`scorer.ts`, deterministic, 0 or 1 per case) writes a score only where it means something, so the run's means read
as the per-action figures: `recall.<action>` exists on the cases labelled `<action>`, `precision.<action>` on the cases the
steward answered `<action>`, plus `correct` over all. `valid` and a run without a reference (drift) score `valid` only.

An arm can swap the prompt's wording of the lines that push toward a Decision: `{"params": {"stewardWording":
"neutral"}}` (or `neutral-wake`) in an `--arm` file, read by the workflow with `ctx.param`; production runs carry no arm and
send the stall unchanged. The measured comparison and the decision on the wording are `docs/evals/2026-11-16-steward-wording.md`.
