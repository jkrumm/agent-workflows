# Review v4 (agw's side)

One routed reviewer agent on the Max subscriptions; agw only prepares the job, ingests the agent's JSON reply and keeps
the ledger. **No LLM call anywhere in this module.** Design: `docs/spikes/review-v4/wiring.md`; the agent:
`docs/spikes/review-v4/reviewer.md`. Review v1 (the LLM `agw review` workflow) is deleted; the process helpers live in
`src/process.ts`, the clone helpers (`cloneForRef`, `removeEscapingSymlinks`, `sweepStaleClones`) in `clone.ts` and the
scope checks in `scope.ts`.

Public surface: `createReviewService(ports)` → `prepare | submit | dispose | status | route | covered | stats`, and
`reviewOperations(service)` → the host operations (`boot.ts` merges them into `reads`). Ports: `pool` (its own, max 2),
`schema`, `stateDir`, `git` (`route.ts` `gitRunner`), `quota?` (the fleet's quota reader in the host), `now?`, `env?`.
A `ReviewError` (unknown job, abandoned, files mismatch, bad state, bad cwd or ref) answers 400 with its message, so the
CLI exits non-zero naming it.

## Commands

| Command | What |
|-|-|
| `agw review prepare --cwd <dir> [--scope uncommitted\|head\|<ref>\|<a>..<b> \| --pr N \| --branch B] [--context] [--min] [--thread] [--account]` | Thread, round, route, quota reading, deep cap, job dir. `status`: `ready` (run the agent with `prompt` on `seat`), `skipped` (tier none), `held` (the deep cap; wait, the tier is never lowered), `needs-human` (a 4th round) |
| `agw review cancel <jobId>` | A `prepared` job is abandoned and its tree removed → `{status: 'cancelled', jobId}`. A submitted or abandoned job is refused naming its state |
| `agw review submit <jobId> --attempt <n> [--account <a>]` (reply on stdin) | REVIEW_OUTPUT v4. Idempotent per (job, attempt): the same attempt gets the stored output back, another attempt is refused naming the winner. `--account` sets the job's account only when it has none |
| `agw review dispose <jobId> <findingId> fixed\|wrong\|intentional\|irrelevant\|open [--reason]` | The answer to a finding of the job's thread; idempotent |
| `agw review status [<jobId>] [--cwd]` | A job (a running review is `prepared`) with its `thread` id and `threadKey` (absent on jobs older than the key) and its thread's findings, or the 10 newest jobs of the repo at `--cwd` |
| `agw review route --cwd --base --head [--min]` | `routeRange` alone; no ledger (HTTP `/review/route`) |
| `agw review covered --cwd --range <a>..<b>` | Coverage of each first-parent commit; exit 0 either way, read `covered` and `state` (`covered`, `uncovered`, `no-review`); each uncovered commit carries a `reason` (below) |
| `agw review stats [--since <iso>] [--repo <id>] [--by tier\|rule\|prompt\|repo] [--bucket week]` | The ledger's quality numbers (below); read-only, JSON, no `--cwd` (HTTP `/review/stats`) |

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
share it. Thread: `sha256(repo \0 key)[:12]`, key `--thread` (or the 12-hex id of a thread the repo's ledger already holds, as `status` prints it: used as is), else `pr:<n>`, `branch:<b>` or `base:<base sha>@<checked-out branch>` (a detached HEAD: `base:<base sha>`), so two branches cut from one base get two threads.

## The job dir

`<stateDir>/review-jobs/<jobId>/`: `job.json` (pointers; `files.agentsMd` is in the worktree), `diff.patch`
(`diff -M diffBase..head`), `stat.txt` (`--numstat --no-renames`), `intent.md` (`--context`, the scope line, the commits
of base..head unless a snapshot), `history.txt` (15 commits on the touched paths before base), `prior.json` (≤ 20 ledger
findings of the repo on the touched paths, newest first, with `sameThread` and the disposition as `state`), `REVIEW.md`
(from base, or a note that there is none), `tree/` (a `clone --shared --no-checkout`, detached at head, escaping
symlinks removed). The tree goes on submit; each prepare sweeps trees older than 24 h and job dirs older than 14 days.

## The ledger (migrations 0017, 0018, 0019)

`review_jobs`: one row per prepared job (`prepared → submitted | abandoned`), the route decision with its facts, the
REVIEW.md config read at the thread base (`prepare` routes every round on that config, so a REVIEW.md the change
edits cannot decide a later round's tier), the stat paths, the output, the `transport` (`in-session`; older rows may say `hidden`, migration 0018; `status` shows it, and a submitted job's REVIEW_OUTPUT as `output`). Migration 0019 adds `reviewer_prompt`, `verifier_prompt` and the quota reading (`ceiling`, `quota_five_hour`, `quota_seven_day`) to the jobs and `line_valid` and `anchored` to the findings (all nullable; below). `review_findings`: stable ids `<thread>-<n>`, `job_id` (first reported),
`last_job_id` (latest round that reported it), the disposition.

## Routing

`routeRange` runs the rules of `route.ts` on `numstat` (first match wins): no content change or every file in REVIEW.md
`none` → none; a `sensitive` path → deep; docs only → none, agent instructions → light; tests only → light; > 800
non-test code lines or > 3 packages → deep; a manifest → standard; ≤ 40 code lines in ≤ 3 files → light; else standard.
`--min` raises afterwards (`decidedBy: caller`).

**Fix round.** A round 2+ whose thread already holds a submitted deep round does not go deep again for a sensitive path
alone: `prepare` passes `threadDeep` and `decide` re-evaluates the other rules with the sensitive hits ignored. Deep by
size or packages stays deep (that rule's text); anything else is `standard` (the floor for a sensitive hit, never
light or none) with the rule `sensitive path: <p>[ (+n)] (fix round, thread already deep)`. A thread whose earlier rounds
were not deep still goes deep on a new sensitive path. `covered` calls `routeRange` without `threadDeep`, so the tier a
commit requires is unchanged, and a standard round 2 after a deep round 1 still covers it (the cover tier is the
thread's max up to the job's round). The deep cap counts deep jobs, so the standard round is not counted.

## Prompt fingerprint

`prepare` stores `reviewer_prompt` and `verifier_prompt`: the first 12 hex characters of the sha256 of `reviewer.md` and
`review-verifier.md` in `AGW_REVIEWER_AGENT_DIR` (default `<HOME>/.claude/agents`, HOME from the process env), null when
a file is unreadable. `status <jobId>` shows both; `stats --by prompt` groups on the reviewer's. The files are only read.

## Anchoring

`submit` computes, for each kept finding with a line, before the ledger transaction: `lineValid` (the file exists in the
job worktree, resolved inside it, and the line ≤ its line count) and `anchored` (the file is in `diff.patch` and the
line is within 3 lines of a changed line on the new side: an added line at its own number, a deletion at the new-side
line that follows it; renames follow `+++ b/<path>`, deleted files have no new side). A finding without a line has both
null; an unreadable worktree makes `lineValid` null and an unreadable `diff.patch` makes `anchored` null (unknown); a
missing file, a path leaving the worktree or a file the diff does not touch is `false`. They are data: a finding is never
dropped or refused for them. They appear in REVIEW_OUTPUT (when not null) and on `review_findings`.

## Acceptance criteria

The reply may carry `criteria: [{item, status: met|not-met|unclear, evidence}]`. A non-empty list is copied into
REVIEW_OUTPUT as `criteria`; a `not-met` item without an important finding is stored, not an error, and `outcome` stays
code's (`clean` without important findings). The field is optional and the reviewer prompt does not emit it yet (the
prompt is a separate Issue); a reply that carries it is stored as is.

## Stats

`agw review stats` aggregates the ledger in code (no LLM). `--since` (ISO datetime; a malformed one is refused) and
`--repo` (exact repo id) filter jobs by creation; jobs of repos whose id contains `/.agw-verify` or `/.agw-eval-recall`
are left out. Output `{since, by, groups: [{key, ...metrics}], total}`, groups sorted by key (`--by tier`: none, light,
standard, deep).

`--bucket week` splits the result into ISO weeks: a job belongs to the week of its `created_at`, a week starts Monday
00:00 UTC and is keyed `weekStart` (`YYYY-MM-DD`). Output `{since, by, bucket: 'week', groups: [], weeks: [{weekStart,
groups: [{key, ...metrics}]}], total}`: weeks ascending, a week without jobs is omitted, the groups of a week sorted as
without `--bucket`, a finding counted in the week (and group) of the job that first reported it, `total` over every row
selected. Without `--bucket` the output has no `bucket` or `weeks`.

**The weekly push to Argo.** The host posts `{machine, generatedAt (epoch ms), source: 'agw review stats --bucket week
--by tier', weeks, byPrompt}` to `{ARGO_URL}/agents/review-stats`: `weeks` is the last 12 ISO weeks by tier (the current,
partial week included, oldest first), `byPrompt` is `--by prompt` over all time. It goes out every ten minutes and after
each successful `agw review submit` (fire-and-forget: it never delays or fails the submit). Same transport and off-switch
as the overview push (`ARGO_URL` https or loopback http, `ARGO_API_SECRET` bearer, no redirect, 15 s timeout; unset: off;
`AGW_ARGO_PUSH=0` turns the timer off). A non-2xx answer, including 404 while Argo has no such endpoint yet, is one
warn-level log line (`event: argo_push`, `target: review-stats`) and changes nothing else.

| `--by` | Key |
|-|-|
| `tier` | the job's tier |
| `repo` | the job's repo id |
| `prompt` | the reviewer prompt fingerprint, `unknown` when null |
| `rule` | the normalized rule (below) |

| Rule text | Key |
|-|-|
| `sensitive path: x`, `… (+n)` | `sensitive path` |
| `sensitive path: x … (fix round, thread already deep)` | `sensitive path (fix round)` |
| `N changed non-test code lines > 800` | `size` |
| `N packages > 3: a cross-package change` | `cross-package` |
| `small: …` | `small` |
| `<rule> (raised by caller from X)` | `<normalized rule> (raised by caller)` |
| anything else | the text before the first `:` |

Metrics per group: `jobs` (submitted), `abandoned`, `prepared` (in flight); `wallS` `p50` (nearest rank) and `max` over
submitted jobs (`submitted_at − created_at`, null when none); `round1` `jobs`, `clean` (`output.outcome = clean`) and
`cleanRate` (null without round-1 jobs); `findings` by tag (`important`, `nit`, `preExisting`) and `dispositions` per
tag for `important` and `nit` (`open`, `fixed`, `wrong`, `intentional`, `irrelevant`), both attributed to the job that
first reported the finding; `precision` for `important` and `nit` = fixed / (fixed + wrong + irrelevant), null when
that is 0; `anchoredShare` and `lineValidShare` over findings whose value is not null (null when none); `deepRound2`
`count` and `share` of the group's submitted jobs (tier deep, round ≥ 2).

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

## Quota reading and deep cap

No quota ceiling holds a review: the reviewer runs on the caller's own account and account switching is the picker's job.
With `--account`, `prepare` reads the quota port and records on the job `ceiling` (`ok`: a reading; `unknown`: no
reading, or neither window has a value), `quota_five_hour` and `quota_seven_day` in percent (null without a value).
Without an account: `ceiling: unjudged`. `status <jobId>` shows `ceiling`, `quotaFiveHour` and `quotaSevenDay` (null on
jobs older than migration 0019). The deep cap is the only hold: deep jobs per account (no account is its own bucket)
since UTC midnight, not abandoned, the thread's own unsubmitted one excluded, ≥ `AGW_REVIEW_DEEP_CAP` (default 60) →
held. Never downgraded. It is a runaway guard far above a busy day (15 deep reviews on one account was normal on
2026-11-05).

## Coverage

For each first-parent commit `c` of the range: required = `routeRange(c^, c)` (none → nothing needed). Covered by a
submitted job `J` of the repo from the last 30 days when `J.base` ≤ `c^`, `J.head` ≥ `c` or `J.head_tree == c^{tree}`
(a snapshot later committed as is) or `routeRange(J.head, c)` is none or `c`'s patch equals `J`'s (below), and the
thread's max tier up to `J.round` ≥ required (round 2+ routes only its fix diff), **and** the thread has no open `important` finding (`disposition =
open`; `nit` and `pre-existing` never block). A fixed, wrong, intentional or irrelevant finding is settled and covers
again; a `fixed` one re-reported is reopened by submit. A commit reviewed at its tier but blocked this way is uncovered
with `reason: 'open-important'` and the blocking `findings` ids.

**Why a commit is uncovered.** Every uncovered commit that needs a review carries a `reason`, and the answer a `state`, so a
ship can tell a review that was never recorded from one that does not match. A *related* job is one of the last 30 days
whose `base` ≤ `c^` and whose files include one of the commit's. `no-review`: no related job. `tier-too-low`: related
jobs, none at the tier `c` needs (`related` names the newest three). `stale`: a related job at the tier exists, but its
head is neither `c`'s tree, nor a descendant of `c`, nor the same patch, nor `c` plus changes that route none
(`related` as above). `open-important`: above. `state` is `covered`, `no-review` (every uncovered commit is
`no-review`) or `uncovered`. A range `covered` could not read is not an answer: the call fails (non-zero exit, a
message naming the git or ledger read), never `covered: false`.

**Cost.** `covered` is ledger and git only, and its price is git processes (the host runs it at load 30). One `git log`
yields every commit's parent, tree and subject; one `git rev-list --parents` yields the commit graph of the range's head
and the jobs' heads, from which every ancestry and "does the head exist" test is answered in process (generation numbers
cut the walk); REVIEW.md of a revision is read once. The router runs once per commit, four commits at a time. The tests
run cheapest first, each over every eligible job before the next (tree or history match; patch-id; none-tier delta), so a
covered commit costs no git process per job, and the git-backed ones run only for a job whose files include one of the
commit's. Measured on the live ledger, 8 commits at load 14: 41 s before, 2 s after, the same verdicts.

**Patch-id match.** A lead reviews `--scope uncommitted`, fixes, rebases on a master that moved and squash-merges, so the
merged commit's tree is never the reviewed tree. The fourth test covers that: `git patch-id --stable` of `c^..c` equals
that of `J.diff_base..J.head` (the snapshot commit stays in the caller's object store; gone → no match). The id ignores
context lines and line numbers, so a rebase over lines the change does not touch keeps it; a conflict resolution that
rewrites a `+`/`-` line, or a fix after the last submitted round, changes it. Of a multi-round thread only the round whose
patch equals the merged one matches. Tier, `J.base` ≤ `c^` and the open-important block apply unchanged. Both ids are
computed lazily (only after the cheaper tests failed) and once per job and per commit; an empty diff or a failed git call
is no match, never an error.
