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

None, by the owner's decision (RS13): no eval set, no scorer, no suite. It learns from real stalls through the run journal.
