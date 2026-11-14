# factory-triage

software-factory's triage asks, when its deterministic matching is unsure, two things: does a signal amend an open Issue
(`amend`) or is it already settled by a recently closed one (`settled`), and which open Issues must a newly filed Issue wait for (`settle`).

```
echo '{"mode":"settle","repo":"app","issue":{"id":"issue_20","title":"…","text":"","kind":"feature","origin":"you"},"candidates":[{"id":"issue_12","title":"…","kind":"bug","state":"working"}]}' | agw factory-triage
```

| | |
|-|-|
| Input (stdin JSON) | one of `{mode: "amend", repo, signal{title, text, source, kind, origin}, candidates[], settled[]}` and `{mode: "settle", repo, issue{id, title, text, kind, origin}, candidates[], precedents[]}`; `candidates` are `{id, title, kind, state}` (at most 40), the only open Issues the answer may name. `settled` (optional, at most 20) are the repo's Issues closed in the last 24h, `{id, title, outcome, reason|null}`; the prompt shows them under "Recently closed", apart from the open ones. The CLI reads it as the workflow's one `request` property, so the HTTP body is `{"request": {…}}`. `precedents` (mode `settle`, optional, at most 12, default `[]`) are the owner's newest needed-me marks on Specs, newest first, `{title, repo, source: triage|filer|replan|lead, screened: passed|settled|null, needed, verdict, note|null}` (software-factory's `SpecPrecedent`); the prompt shows them inside the fence as "The owner's marks on past Specs": a `needed: false` with `source: triage` is a Spec triage made owed that should not have been. Titles, notes and texts are untrusted data |
| Output | the run envelope's `output`: `{amend, settled, after[], kind, size, checkpoint, reason}`. `amend`: the Issue id (mode `amend`) or `null`. `settled`: a shown recently closed Issue id that already covers the signal (the same ask, or an alert for a subject it closed as a false alarm or fixed), or `null`; a regression, a new symptom or a changed fact is not settled. `after`: Issue ids (mode `settle`, at most three in practice) or `[]`. `kind` and `size` are advisory (`settle`) or `null`. `checkpoint` is `"spec"` or `null` (`settle` only; the guard forces `null` in `amend`): `"spec"` only for work of a session or more that is a new public surface (an API, a CLI verb, a contract), a data model or migration that changes meaning, a dependency of weight, or a UI screen the owner has not seen (the list of `factory issue schema`'s `checkpoint`); never an hour's change (a constant, a limit, a config line), a change inside an existing surface, or an architecture or look-and-feel choice; `null` is the common answer. A `"spec"` answer carries `size` `medium` or `large`: the factory drops one whose size is `small` or null A reply without the field reads as `null` |
| Shape | one journaled step (`triage`), one tool-free call to the internal `factory.triage` capability |
| Pending | exit 10 like every workflow (`agw run wait <runId>`) |

## Decisions

- **The call is a capability.** `factory.triage` builds the prompt, so nothing reachable over HTTP is a free prompt on the
  route; it is `internal`.
- **Data is fenced** like `factory-ask`'s; the mode, the repo and the Issue ids are the factory's, outside the fence.
- **Only Issues it was shown.** `guardTriage`, applied by the workflow after the step so a replay gets it too: an Issue that
  was not among the candidates, the Issue itself, an edge twice, an `amend` answer with edges, a `settled` id that was not shown, `amend` and `settled` both set, or a `settle` answer with an
  `amend` or a `settled` becomes the empty answer (`amend: null, settled: null, after: []`): file anew, chain nothing. The factory checks the same again
  before it acts (an open Issue it showed, no cycle).
- **When unsure, nothing.** A duplicate costs a note, a lost request costs the work; most Issues wait for nothing.
- **Fail closed.** Any failure of the call gives the empty answer with `reason: 'triage unavailable: <class>'`.

## Route

`factory.triage`: the `EASY` tier (Haiku high); the model lives only in the tier.

## Eval

`eval/cases.jsonl` (`PlainCase` lines of public placeholder material, all `settle`): a one-constant limit raise (with and
without the owner's mark on it), a config line, a bug, a docs change, a change inside an existing surface, a look-and-feel
and an architecture choice, an injection in the Issue text; and an unseen UI screen, a new API route, a CLI verb, a
migration that changes meaning, a dependency of weight, an injection in a mark's note. Reference: `{checkpoint}`
(`"spec"` or `null`). The deterministic scorer (`scorer.ts`, 0/1 scores): `valid`, `checkpoint` (exact), `sized` (a `spec`
answer has `size` medium or large); `pass` is checkpoint and sized. A failed run scores 0 everywhere.
