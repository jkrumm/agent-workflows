# S4 — Crash, cancel and timeout

**Verdict:** death is detectable at once and leaves nothing behind; **cancel means kill the terminal** (Esc does not
stop a background review); the one real hazard is a **hung review** (`max` blocked for minutes waiting on finder
results), so v3 needs a wall cap per level that kills the session, and bans `max`.

| Test | What was done | What happened |
|-|-|-|
| Crash mid-review | desk got job j10 (PR #122), `hc kill` the moment `Skill(code-review)` showed | hc: `finished`, `killed`, exit 129; `factory session get`: `dead` within 3 s; `hc wait <t>` returned at once (`ended: true`); no `review.json`, no process left (`pgrep`), the forked skill died with its session |
| Recovery | the same job file, resubmitted as a per-job spawn `rv3-j10b` | `started` in ~6 s, `review.json` 23 s after submit. The job file is the idempotent unit; resubmitting is safe because the result path is per job |
| Caller timeout | caller waited 25 s for the file | the result came in 23 s, so this is the latency floor (`low`), not a timeout. The design does not need a caller-side timeout to be safe: the run keeps waiting in agw's journal and the CLI returns `exit 10 pending` like every agw workflow (`agw run wait <runId>`) |
| Esc (`hc interrupt`) on a running review | j7 (`max`) after 21 min | hc: `still_working`; the main thread went idle but the background `code-review` agent kept its status line ("Monitoring finder agent transcripts"). Esc is not a cancel |
| Hung review | j7 (`max`, PR #119) | 10 finder subagents done by 00:14Z; the orchestrator then looped `timeout 150 tail -f /dev/null` "so the last two finder results can arrive" with no transcript growing for 2+ min; killed at 00:17Z after 21 min, 619 calls, **$22.03 API-equivalent** with no result: 61 % of the $36.2 the whole `me2` account spent while its 5-hour meter went 55 % → 76 % (S2) |
| Kill | `hc kill` + `hc rm` on j7 and j10b | both gone; no process; no late file |

## What v3 takes from this

- One job = one session = one terminal. The agw step that waits on it treats `dead` (factory) or `finished` (hc) as a
  failed attempt, and retries once with a fresh spawn key (`-r2`, the factory's spent-key rule).
- **Wall cap per level, enforced by kill:** `high` p95 here ~2 min, `xhigh` 5.4 min; cap at 10 min (`high`) and 20 min
  (`xhigh`), then kill and fail the attempt `timeout`. Never Esc.
- **`max` is not offered.** It is the one level that hung, and its cost (≥ 12 % of a Max 5x five-hour window for
  one PR, at S2's calibration) would starve the dev sessions even when it works.
- The job's `out` path is per job and attempt, so a late write from a killed attempt can never be read as the result.
