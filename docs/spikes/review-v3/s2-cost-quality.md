# S2 — What a review costs in Max quota, and what it finds

**Verdict:** native `/code-review high` on Sonnet costs **$0.29-0.46 API-equivalent per PR, about 0.2-0.3 % of a
Max 5x five-hour window and ~0.03 % of its week**, finishes in 1-2 minutes, and found a real bug v1 had called clean (plus a second known one). Its
`important` tag is inflated: 2 of 20 hold up as real defects (0 are false). v3 keeps it as the finder and adds a
severity-gating verify vote. `xhigh` costs 2.5x `high`; `max` is unusable (S4).

## Runs (Claude Code 2.1.316, Sonnet 5.5 effort high sessions, factory role `worker`)

API-equivalent from the session transcripts (main thread + every subagent, deduplicated per message id), priced at the
usage-tracker snapshot's Sonnet 5.5 rates ($2 / $10 per MTok, cache write $2.5, read $0.10): `data/usage.py`.

| Job | PR (size) | Level | Transport | Account | Wall | Calls | API-eq | Findings (important / nit) |
|-|-|-|-|-|-|-|-|-|
| j1 | #119 (+121/-1) | high | per-job | me2 | 68 s | 16 | $0.29 | 2 / 5 — **the real bug v1 called clean** |
| j2 | #115 (+277/-27) | high | per-job | me2 | 84 s | 15 | $0.34 | 6 / 2 |
| j3 | #116 (+229/-31) | high | desk (note) | iu | ~98 s | — | $0.42 (incl. desk start) | 2 / 5 |
| j4 | #118 (+567/-38) | high | desk after `/clear` | iu | ~97 s | 13 + main | ~$0.41 | 5 / 3 — **one real (Wave 16's left-behind abort gap)** |
| j5 | #121 (+766/-18) | high | per-job | me2 | 111 s | 20 | $0.40 | 2 / 6 |
| j6 | #122 (+53/-28) | high | desk, no `/clear` | iu | ~84 s | 19 + main | ~$0.46 | 3 / 4 |
| j8 | #119 | xhigh | desk after `/clear` | iu | 321 s | 40 | $0.86 | 1 / 8 — the real bug, alone as important |
| j7 | #119 | max | per-job | me2 | 21 min, killed | 619 | **$22.03**, no result | — (hung, S4) |
| j10b | #122 | low | per-job | me2 | 19 s | 11 | $0.14 | 0 — **invalid: empty diff** (S1 finding 4) |
| — | #122 | low | in-session Sonnet subagent, correct upstream | me2 | ~11 s | — | small | 0 |

The five-PR batch (j2-j6) plus j1 is six real PRs. The skill's own recipe lines, from its prompt in the transcripts:
`low effort → 1 diff pass → no verify → ≤4 findings`; `high effort → 8 inline angles → dedup (no verify) → ≤10
findings` ("target at least 5 findings"); `xhigh effort → 10 inline angles → dedup (no verify) → sweep → ≤15
findings`; `max` fans out to 10 finder subagents (+ a verify phase it never reached).

## Quota, read before and after (`data/quota-readings.jsonl`, `claude-account usage --json`)

| Window | me2 5-hour | me2 week | iu week | All `me2` spend in the window (every session, `cli` only) |
|-|-|-|-|-|
| Batch A, 23:46-23:54Z (j2, j5 on me2; j3, j4, j6 on iu) | 54 → 55 % | 56 → 56 % | 86 → 87 % | $4.97 (j2 + j5 $0.74; the rest other sessions) |
| Batch C, 23:55-00:18Z (j7 max, j10b, this lead) | 55 → 76 % | 56 → 59 % | 87 → 87 % | $36.22 (j7 $22.03) |
| Whole session, 23:21-00:18Z | 51 → 76 % (5 h) | 55 → 59 % | — | $54.28 |

Calibration on Max 5x: **$1.72 per 1 % of the 5-hour window** (batch C: $36.22 / 21 points; ±1 point of meter
resolution → $1.65-1.81) and **~$13 per 1 % of the week** ($54.28 / 4 points → $10.9-18.1). Per review at `high`:
$0.29-0.46 → 0.17-0.27 % of the 5-hour window, ~0.03 % of the week. The meter's resolution is 1 %, so a single
`high` review never moves it: the per-review figure comes from tokens and this calibration, the readings bound it.
Ultra (`iu`) shows a weekly reading only; three reviews on it did not move it. `me2`'s stated 5-hour reset (00:40)
did not drop the meter; deltas, not resets, are what was measured.

## Quality (n = 6, one judge, so a direction, not a number)

An independent Sonnet judge (fresh context, read-only, told to verify against the code and later master history)
graded every `important` finding of the six `high` reviews: **20 important: 2 real, 18 minor, 0 wrong.**

- Real: #119 `boot.ts:528` (the cost-history port reads runs that never exist; fixed by #120, and v1's review of
  #119 was `clean`) and #118 `scope.ts:552` (after an abort the carried spend lands after the step row is written;
  the Wave 16 close-out lists exactly this as a known gap).
- Minor: true statements about contracts the PR chose on purpose, unlikely paths, test quality.
- `xhigh` on #119 tagged only the real bug `important` (1 / 8): the extra sweep calibrates severity better, at 2.5x.

Reading: the finder is accurate and finds what matters, and its severity is not to be trusted. That is the job of the
verify vote (Anthropic's own pipeline votes before posting; research `r1`), asked "does this produce a wrong result in a
reachable path, cite the line" rather than "is this true". Ground truth (Wave 9) measures recall and false alarms
properly.
