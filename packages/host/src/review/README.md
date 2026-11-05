# Review v4 (agw's side)

One routed reviewer agent on the Max subscriptions; agw only prepares the job, ingests the agent's JSON reply and keeps
the ledger. **No LLM call anywhere in this module.** Design: `docs/spikes/review-v4/wiring.md`; the agent:
`docs/spikes/review-v4/reviewer.md`. Review v1 (the LLM `agw review` workflow) is deleted; the process helpers live in
`src/process.ts`, the clone helpers (`cloneForRef`, `removeEscapingSymlinks`, `sweepStaleClones`) in `clone.ts` and the
scope checks in `scope.ts`.

Public surface: `createReviewService(ports)` → `prepare | submit | dispose | status | route | covered`, and
`reviewOperations(service)` → the host operations (`boot.ts` merges them into `reads`). Ports: `pool` (its own, max 2),
`schema`, `stateDir`, `git` (`route.ts` `gitRunner`), `quota?` (the fleet's quota reader in the host), `now?`, `env?`.
A `ReviewError` (unknown job, abandoned, files mismatch, bad state, bad cwd or ref) answers 400 with its message, so the
CLI exits non-zero naming it.

## Commands

| Command | What |
|-|-|
| `agw review prepare --cwd <dir> [--scope uncommitted\|head\|<ref>\|<a>..<b> \| --pr N \| --branch B] [--context] [--min] [--thread] [--account]` | Thread, round, route, ceiling, deep cap, job dir. `status`: `ready` (run the agent with `prompt` on `seat`), `skipped` (tier none), `held` (ceiling or deep cap; wait, the tier is never lowered), `needs-human` (a 4th round) |
| `agw review cancel <jobId>` | A `prepared` job is abandoned and its tree removed → `{status: 'cancelled', jobId}`. A submitted or abandoned job is refused naming its state |
| `agw review submit <jobId> --attempt <n> [--account <a>]` (reply on stdin) | REVIEW_OUTPUT v4. Idempotent per (job, attempt): the same attempt gets the stored output back, another attempt is refused naming the winner. `--account` sets the job's account only when it has none |
| `agw review dispose <jobId> <findingId> fixed\|wrong\|intentional\|irrelevant\|open [--reason]` | The answer to a finding of the job's thread; idempotent |
| `agw review status [<jobId>] [--cwd]` | A job (a running review is `prepared`) with its `thread` id and `threadKey` (absent on jobs older than the key) and its thread's findings, or the 10 newest jobs of the repo at `--cwd` |
| `agw review route --cwd --base --head [--min]` | `routeRange` alone; no ledger (HTTP `/review/route`) |
| `agw review covered --cwd --range <a>..<b>` | Coverage of each first-parent commit; exit 0 either way, read `covered` |

`prepare`, `cancel`, `submit` and `dispose` change state, so the CLI asks for `--commit` (non-TTY callers must pass it).

`--cwd` is required wherever a repo is read (the CLI does not fill it).

## Scopes and the snapshot

`uncommitted` (default) reviews a **snapshot commit**: a temporary index (`GIT_INDEX_FILE`) seeded from HEAD, `git add
-A`, `write-tree`, `commit-tree -p HEAD` as `agw`. The caller's index, HEAD, refs and work tree are never written; the
blobs, tree and commit **do land in the caller's object store, unreferenced** (git's gc prunes them after its expiry).
No change against HEAD is an empty diff (tier none). `head` = HEAD~1..HEAD, `<ref>` = merge-base(ref, HEAD)..HEAD,
`<a>..<b>` as given. `pr`/`branch` fetch into a throwaway clone (`cloneForRef`, under `<stateDir>/review-clones/`)
and diff against the merge base with origin's default branch; that clone is the job's worktree. No path scopes.

Repo identity: origin normalized to `host/owner/name`, else the realpath of the main worktree's toplevel, so worktrees
share it. Thread: `sha256(repo \0 key)[:12]`, key `--thread` (or the 12-hex id of a thread the repo's ledger already holds, as `status` prints it: used as is), else `pr:<n>`, `branch:<b>` or `base:<base sha>`.

## The job dir

`<stateDir>/review-jobs/<jobId>/`: `job.json` (pointers; `files.agentsMd` is in the worktree), `diff.patch`
(`diff -M diffBase..head`), `stat.txt` (`--numstat --no-renames`), `intent.md` (`--context`, the scope line, the commits
of base..head unless a snapshot), `history.txt` (15 commits on the touched paths before base), `prior.json` (≤ 20 ledger
findings of the repo on the touched paths, newest first, with `sameThread` and the disposition as `state`), `REVIEW.md`
(from base, or a note that there is none), `tree/` (a `clone --shared --no-checkout`, detached at head, escaping
symlinks removed). The tree goes on submit; each prepare sweeps trees older than 24 h and job dirs older than 14 days.

## The ledger (migrations 0017, 0018)

`review_jobs`: one row per prepared job (`prepared → submitted | abandoned`), the route decision with its facts, the
REVIEW.md config read at the thread base (`prepare` routes every round on that config, so a REVIEW.md the change
edits cannot decide a later round's tier), the stat paths, the output, the `transport` (`in-session`; older rows may say `hidden`, migration 0018; `status` shows it, and a submitted job's REVIEW_OUTPUT as `output`). `review_findings`: stable ids `<thread>-<n>`, `job_id` (first reported),
`last_job_id` (latest round that reported it), the disposition.

## Convergence

Round = last submitted round of the thread + 1; a re-prepare abandons the thread's unsubmitted job (only when a new job
is written: a held or skipped prepare leaves a running review alone). Round 4 is refused (`needs-human`). From round 2
the diff starts at the last reviewed head when it is an ancestor of the new head or the two share the base (two
snapshots on one base), else at the base. Submit: a reply finding matches a thread finding E by `stillOpen` with E's id,
else by file + class + normalized message, then by E's disposition: `wrong`, `intentional` or `irrelevant` is a dropped
repeat (counted); `open` is kept under E's id with `stillOpen` (`last_job_id` moves); `fixed` is reopened, kept under E's
id with `stillOpen` and E back to `open` in the same transaction. Two reply findings on one E keep the first. No match is
a new finding; a `stillOpen` with an unknown id matches by key or is new. Nits past
REVIEW.md `nits` are dropped (counted). Code decides `outcome` (`clean` without important, `needs-human` from round 3,
else `actionable`), `summary` (counts only), `stepBack` (the reply's, or a fixed default at round 3 with important left)
and `tier` (the job's). The echoed `files` must equal the stat paths (the empty-diff guard); nothing is written otherwise.

## Ceiling and deep cap

With `--account`, the quota port's reading: held at ≥ 70 % of the 5-hour window or ≥ 90 % of the week (no 5-hour
reading: the week alone; no reading: `ceiling: unknown`, not held). Without it: `ceiling: unjudged`. Deep jobs per
account (no account is its own bucket) since UTC midnight, not abandoned, the thread's own unsubmitted one excluded, ≥
`AGW_REVIEW_DEEP_CAP` (default 15) → held. Never downgraded.

## Coverage

For each first-parent commit `c` of the range: required = `routeRange(c^, c)` (none → nothing needed). Covered by a
submitted job `J` of the repo from the last 30 days when `J.base` ≤ `c^`, `J.head` ≥ `c` or `J.head_tree == c^{tree}`
(a snapshot later committed as is) or `routeRange(J.head, c)` is none, and the thread's max tier up to `J.round` ≥
required (round 2+ routes only its fix diff), **and** the thread has no open `important` finding (`disposition =
open`; `nit` and `pre-existing` never block). A fixed, wrong, intentional or irrelevant finding is settled and covers
again; a `fixed` one re-reported is reopened by submit. A commit reviewed at its tier but blocked this way is uncovered
with `reason: 'open-important'` and the blocking `findings` ids.
