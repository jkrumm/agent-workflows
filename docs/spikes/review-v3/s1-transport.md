# S1 — Transport: how a caller hands a reviewer session a job and gets REVIEW_OUTPUT back

**Verdict:** a **per-job factory spawn** (one interactive Claude Code session per review, cwd = a throwaway worktree
of the change, the job in a file, the result in a file, the terminal closed after) is the transport for callers that
are not Claude Code sessions. A **standing desk** fed by factory notes also works but buys nothing on tokens and adds
three failure modes, so it is not built. A **Claude Code caller reviews in-session**: a subagent pinned to Sonnet runs
the native skill, no transport at all.

Mini, 2026-11-03 00:26-01:18 CET, Claude Code 2.1.316, role `worker` (Sonnet 5.5, effort high), native
`/code-review`. Raw data: `data/` (protocol, the review files, quota readings, the token script).

## What ran

| Arm | How the job goes in | How the result comes out | Seen |
|-|-|-|-|
| Per-job spawn | `factory spawn create rv3-<job> --repo <worktree> --role worker --placement child --prompt "Follow <protocol> for the job in <job.json>."` | the session writes `review.json` to the job's `out` path and replies `DONE <path>`; the caller waits for the file (bounded), then `hc kill` + `hc rm` | spawn queued → `started` in 6-14 s; first review done 68 s after `started`; 5 jobs (j1, j2, j5, j7, j10) |
| Standing desk | one spawn with a "wait for jobs" prompt; each job is `factory session note rv3-desk "Follow <protocol> for <job.json>."`; `factory session note rv3-desk "/clear"` between jobs | same file | note `pending` → `delivered` in 3-8 s; a `/clear` note runs as the slash command; 4 jobs (j3, j4, j6, j8) |
| In-session subagent | the caller's own session: `Agent(model: sonnet)` → `Skill(code-review, "<level> <target>")` | the subagent's reply | the skill forked at spawn depth 2 **on Sonnet** while the caller ran Opus (transcript `meta.json`: `"model": "claude-sonnet-5-5"`) |

## Findings

1. **The native skill already isolates itself.** `/code-review` runs as a forked background agent with its own context
   (`subagents/*.forked-skill.json`, `requestShape: background`). The main thread pays ~1.6k tokens to launch it and
   ~3k for the returned findings (j2, j5: main context 30.3k → 37.3k / 38.7k over the whole job, protocol and file
   write included). In-session review costs a caller almost no context.
2. **Every request is `entrypoint: cli`** (main threads and forked subagents, all 10 transcripts and the account-wide
   window): the interactive meter, not #97074's `sdk-cli`.
3. **A desk session cannot move its cwd.** `cd <worktree>` in the desk's Bash is reset ("Shell cwd was reset to
   …rv3-desk"); the skill's subagent coped only because the job text told it to prefix every command with
   `cd <worktree> &&`. The native skill's Phase 0 is `git diff @{upstream}...HEAD` in its cwd, so a session whose cwd
   is the change is the robust shape.
4. **The diff base must be set by the preparer.** In a worktree whose local `master` already contains the change, the
   skill's fallback `git diff master...HEAD` is empty: j10 (`low`, PR #122) reviewed nothing and answered "Nothing
   needs fixing". Fix, proven on the same PR: a local branch at the head whose upstream is a branch at the base
   (`git branch -u rv3-base/<job>`), after which `git diff @{upstream}...HEAD` is exactly the PR (9 files, +53/-28).
5. **No token saving from standing.** Desk main thread $0.10-0.16 per job against $0.10-0.12 for a fresh session; the
   subagent dominates both (S2). The desk's context grows without `/clear` (45k → 52k after one more job).
6. **The factory spreads parallel spawns across accounts** (j2 on `me2`, the desk on `iu`): admission, not the caller,
   picks the account.

## Why not the standing desk

It needs a `/clear` note before every job (else context grows), a per-job `cd` the session cannot keep, and a
supervisor that respawns it; a crash loses whatever job it held (S4), and one desk is one queue. The per-job spawn
gets all of that from the factory for free (admission, one session per job, death = job failure). Its only cost is
6-14 s of spawn latency on a 1-5 minute review.
