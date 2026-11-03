# Review v3 spikes (Wave 17, 2026-11-03)

The evidence behind `docs/review-v3.md`. Run on the mini, 00:20-01:40 CET, Claude Code 2.1.316, never more than two
extra sessions at a time, each closed when its result landed.

| Spike | Verdict |
|-|-|
| [S0 policy](s0-policy.md) | Interactive sessions only (`entrypoint: cli`); the `CLAUDE_CODE_ENTRYPOINT` relabel is unsound (the 2026-11-12 Usage Policy names misrepresenting the client) and `claude -p` stays banned |
| [S1 transport](s1-transport.md) | Per-job factory spawn for non-Claude-Code callers; in-session `reviewer` subagent (pinned to Sonnet) for Claude Code callers; the standing desk works but adds failure modes and saves nothing |
| [S2 cost and quality](s2-cost-quality.md) | `high` on Sonnet: $0.29-0.46 API-eq, ~0.2-0.3 % of a Max 5x five-hour window, ~0.03 % of its week, 1-2 min; found two known real bugs (one v1 had called clean); 18 of 20 `important` tags were minor, so a severity-gating verify vote is needed |
| [S3 concurrency](s3-concurrency.md) | Two sessions at once run clean; the factory spreads them across accounts; cap review at two |
| [S4 crash and timeout](s4-crash-timeout.md) | Death detected in 3 s, nothing left behind; Esc does not cancel a background review, kill does; `max` hung 21 min for $22 and is banned; wall caps enforce by kill |
| [S5 verify end to end](s5-verify.md) | A Sonnet subagent runs the skill fork and one verifier per candidate (depth ≤ 2); the vote kept #118's real finding and demoted 4 minor ones; ~$0.10 per candidate; a second `high` run on #119 missed the bug |

`research/` holds the three cited `agw research` reports (`r1` how the Claude Code team and `/code-review` review,
`r2` policy and the mechanisms to reach a running session, `r3` published practice on agentic review). `data/` holds
the job protocol, the review outputs, the quota readings and the transcript token script.

Spend: research $1.04 on API credit (runs `01a19e92-a229`, `-a227`, `-a231`); spikes on Max (`me2` and `iu`), $25.4
API-equivalent across the ten review sessions (of which $22.0 the killed `max` run), plus a judge and two probe
subagents in the lead's own session.
