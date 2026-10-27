# Lead handoff — Wave 2 (Core runtime, P1a), in flight

Lead `agent-workflows-w1` (pane w40:p8), 2026-10-27 ~23:30. **Interim**: written as insurance because this
session's Max account (`me`) is at 97 % weekly. If this lead is gone, the next lead picks up from here.

## State

|Step|Branch / PR|State|
|-|-|-|
|Runtime|PR #7|**merged** (`d41d37f`), CI green. Reviews: worker's deep + /code-review; lead re-review gateway deep + /code-review high, 2 rounds, all taken except one false positive (Makefile `$$(`)|
|Route table|PR #5|**merged**; gateway standard, 1 blocking (shared mutable rate) fixed; `wire` overrides forbidden by lead decision|
|Capabilities|PR #6|**merged**; gateway standard clean + 5 improvements taken; live run 5/5, IU $0.000073|
|Fleet tooling (dotfiles)|dotfiles PR #33|**merged** (`8db5cd0`); train installs from the lockfile, readies drafts; rd wave skips live agent names. Proven: capabilities and runtime merged with bare `make check`|
|OpenCode wedge|PR #8|review round 1 sent back (error misclassified as timeout, numbers to reconcile). Verdict: file-watcher boot; `OPENCODE_DISABLE_FILEWATCHER=1`|
|Middleware|PR #10|lead /code-review high: 10 findings (outbox before runPost, poison row blocks outbox, step spans leak on cancel, wall_ms 0 for never-started, negative remainders, index mismatch, cache_write folded into input, …); gateway deep pending|
|Caps + wallet|PR #9|worker's 2 review rounds; lead gateway deep + /code-review high pending|

## Plan for the rest

- One runtime follow-up, owned by the middleware worker (only one owner of packages/runtime at a time):
  `Tokens.cacheWrite` (migration 0002), outbox index matching the middleware query, `unpriced_calls`/`tool_calls`
  run columns, `StepPostArgs` carries the handle, failed runPost retried, **toolPre throw fails the step like stepPre**
  (limits relies on it).
- Then deploy/live verification: nothing deployable until Wave 3 (`make deploy|verify` are skeletons); live proof for
  Wave 2 = CI + `make check` against the mini's Postgres + capabilities live run.
