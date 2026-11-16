# factory-queue

software-factory's queue loop asks, for one repo's open Issues, two things when the order is unclear: which queued Issue must
wait for another (`after` edges), and in what order the queued ones should start. The factory never calls a model (SF2), so
the judgment lives here. The deterministic part (the cycle check, real blockers, the owner's `prio`, admission) stays in the
factory; only the rest reaches this workflow, and the factory checks every edge again before it stores one.

```
echo '{"repo":"app","issues":[{"id":"issue_12","title":"…","kind":"bug","state":"working","prio":0,"ageMinutes":600,"size":"small","summary":"","after":[]},{"id":"issue_20","title":"…","kind":"feature","state":"queued","prio":0,"ageMinutes":120,"size":null,"summary":"","after":[]}]}' | agw factory-queue
```

| | |
|-|-|
| Input (stdin JSON) | `{repo, issues[]}`; an Issue is `{id, title, kind, state, prio, ageMinutes, size, summary, after[]}` (1 to 40). `state: "queued"` marks the Issues to order, any other state is chain context. `prio` is the owner's (−1000..1000), `after` the edges that exist. The CLI reads it as the workflow's one `queue` property, so the HTTP body is `{"queue": {…}}`. `title` and `summary` are untrusted data |
| Output | the run envelope's `output`: `{edges[{issue, after, reason}], order[], reason}` (every `reason` is one line, clipped to 240 in code). `edges`: proposed new edges (at most 10), `[]` is the common answer. `order`: every queued Issue once, first to start at the front, or `[]` when the factory's order stands |
| Shape | one journaled step (`queue`), one tool-free call to the internal `factory.queue` capability |
| Pending | exit 10 like every workflow (`agw run wait <runId>`) |

## Decisions

- **The call is a capability.** `factory.queue` builds the prompt, so nothing reachable over HTTP is a free prompt on the
  route; it is `internal`.
- **Data is fenced.** Titles and summaries sit under one per-call random fence with the markers made inert, rules before and a
  re-assertion after. The repo, ids, states, priorities, ages and existing edges are the factory's.
- **The owner's prio is not the model's.** `guardQueue` refuses an order that puts an Issue before one of higher priority
  unless the higher one waits for it: the order breaks ties and nothing else.
- **Only Issues it was shown, and only the wrong part goes.** `guardQueue`, applied by the workflow after the step so a replay
  gets it too, judges `edges` and `order` apart. An edge whose waiter is not queued or whose blocker was not shown, an edge to
  itself, twice or that exists already, one that closes a cycle (over the shown edges, proposed ones included) or a fourth for
  one Issue discards the edges as a set. In the order, ids that are not queued (a running Issue listed by mistake) are dropped;
  an order that is then not every queued Issue once, or puts a blocker after the Issue that waits for it, or goes against the
  owner's priority becomes `[]`. The part that is sound stands; when nothing survives the answer is the empty one
  (`edges: [], order: []`). It never reshuffles an order.
- **When unsure, nothing.** Most queues need no edge and no order.
- **Fail closed.** Any failure of the call gives the empty answer with `reason: 'queue unavailable: <class>'`. A cancel, a
  shutdown (`InfraError`) or an aborted run still propagates to the runtime.

## Route

`factory.queue` (`packages/routes/src/table/factory.ts`): the `EASY` tier (Haiku high); the model lives only in the tier.

## Eval

None, by the owner's decision (RS13). It learns from real queues through the run journal. A one-off effort comparison on 14 synthetic cases (no suite, nothing registered) is `docs/evals/2026-11-16-effort-arms.md`: high, low and none agree within what those cases show, and the route stays on `EASY`.
