# S3 — Concurrency

**Verdict:** two review sessions at once run cleanly and independently; the factory's admission places them (it put
two simultaneous spawns on two accounts). v3 caps review at **two concurrent sessions host-wide** and leaves account
choice and quota reserve to the factory. Higher fan-out is not worth testing: a `max` review alone fans out to 10
finders (S2), so parallelism lives inside one review, not across many.

| Pair | Sessions | Overlap | Accounts | Result |
|-|-|-|-|-|
| A1 | j2 (per-job, PR #115) + desk j3 (note, PR #116) | 23:46:19-23:47:53Z | `me2`, `iu` | both `review.json` within 94 s of each other; no shared state |
| A2 | j5 (per-job, PR #121) + desk j4 (note after `/clear`, PR #118) | 23:48:00-23:52:09Z | `me2`, `iu` | both done; the desk's job and the spawn never touched each other's worktree |
| C1 | j7 (per-job, `max`, PR #119) + desk j8 (`xhigh`, PR #119, same PR) | 23:55-00:16Z | `me2`, `iu` | j8 done in 5.4 min; j7 hung (S4). Same PR, two worktrees: no interference |

Never more than two spike sessions ran at once (owner's limit); each was closed (`hc kill` + `hc rm`) when its
result landed, and `pgrep` showed no leftover process.

What the factory adds that a review agent must not duplicate (`software-factory/docs/design.md` §Capacity and
admission): an account is eligible only below 85 % of its 5-hour window and 95 % of its week, a spawn holds its
account until a reading shows it, `drain`/`pace` queue states, and "never spill" (all accounts walled → the spawn
waits for a reset as `queued: no capacity until <resumeAt>`). A held spawn is a review that waits, which is the right
behaviour for review: v3 turns a hold longer than the caller's budget into the API fallback (`docs/review-v3.md`).
