# factory-triage

software-factory's triage asks, when its deterministic matching is unsure, two things: does a signal amend an open Issue
(`amend`) or is it already settled by a recently closed one (`settled`), and which open Issues must a newly filed Issue wait for (`settle`).

```
echo '{"mode":"settle","repo":"app","issue":{"id":"issue_20","title":"…","text":"","kind":"feature","origin":"you"},"candidates":[{"id":"issue_12","title":"…","kind":"bug","state":"working"}]}' | agw factory-triage
```

| | |
|-|-|
| Input (stdin JSON) | one of `{mode: "amend", repo, signal{title, text, source, kind, origin}, candidates[], settled[]}` and `{mode: "settle", repo, issue{id, title, text, kind, origin}, candidates[]}`; `candidates` are `{id, title, kind, state}` (at most 40), the only open Issues the answer may name. `settled` (optional, at most 20) are the repo's Issues closed in the last 24h, `{id, title, outcome, reason|null}`; the prompt shows them under "Recently closed", apart from the open ones. The CLI reads it as the workflow's one `request` property, so the HTTP body is `{"request": {…}}`. Titles and texts are untrusted data |
| Output | the run envelope's `output`: `{amend, settled, after[], kind, size, reason}`. `amend`: the Issue id (mode `amend`) or `null`. `settled`: a shown recently closed Issue id that already covers the signal (the same ask, or an alert for a subject it closed as a false alarm or fixed), or `null`; a regression, a new symptom or a changed fact is not settled. `after`: Issue ids (mode `settle`, at most three in practice) or `[]`. `kind` and `size` are advisory (`settle`) or `null` |
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

None, by the owner's decision (RS13). It learns from real signals through the run journal.
