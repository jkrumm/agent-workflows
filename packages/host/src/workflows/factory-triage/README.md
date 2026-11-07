# factory-triage

software-factory's triage asks, when its deterministic matching is unsure, two things: does a signal amend an open Issue
(`amend`), and which open Issues must a newly filed Issue wait for (`settle`).

```
echo '{"mode":"settle","repo":"app","issue":{"id":"issue_20","title":"…","text":"","kind":"feature","origin":"you"},"candidates":[{"id":"issue_12","title":"…","kind":"bug","state":"working"}]}' | agw factory-triage
```

| | |
|-|-|
| Input (stdin JSON) | one of `{mode: "amend", repo, signal{title, text, source, kind, origin}, candidates[]}` and `{mode: "settle", repo, issue{id, title, text, kind, origin}, candidates[]}`; `candidates` are `{id, title, kind, state}` (at most 40), the only Issues the answer may name. The CLI reads it as the workflow's one `request` property, so the HTTP body is `{"request": {…}}`. Titles and texts are untrusted data |
| Output | the run envelope's `output`: `{amend, after[], kind, size, reason}`. `amend`: the Issue id (mode `amend`) or `null`. `after`: Issue ids (mode `settle`, at most three in practice) or `[]`. `kind` and `size` are advisory (`settle`) or `null` |
| Shape | one journaled step (`triage`), one tool-free call to the internal `factory.triage` capability |
| Pending | exit 10 like every workflow (`agw run wait <runId>`) |

## Decisions

- **The call is a capability.** `factory.triage` builds the prompt, so nothing reachable over HTTP is a free prompt on the
  route; it is `internal`.
- **Data is fenced** like `factory-ask`'s; the mode, the repo and the Issue ids are the factory's, outside the fence.
- **Only Issues it was shown.** `guardTriage`, applied by the workflow after the step so a replay gets it too: an Issue that
  was not among the candidates, the Issue itself, an edge twice, an `amend` answer with edges or a `settle` answer with an
  `amend` becomes the empty answer (`amend: null, after: []`): file anew, chain nothing. The factory checks the same again
  before it acts (an open Issue it showed, no cycle).
- **When unsure, nothing.** A duplicate costs a note, a lost request costs the work; most Issues wait for nothing.
- **Fail closed.** Any failure of the call gives the empty answer with `reason: 'triage unavailable: <class>'`.

## Route

`factory.triage`: the `EASY` tier (Haiku high); the model lives only in the tier.

## Eval

None, by the owner's decision (RS13). It learns from real signals through the run journal.
