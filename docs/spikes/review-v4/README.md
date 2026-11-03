# Review v4 spike (Wave 18, 2026-11-03)

One routed reviewer agent on the Max subscriptions: intent, system fit and domain rules first, bugs and security
after; routed by the change into none / light / standard / deep; no API credit, no `claude -p`, no Agent SDK. Run on
the mini in the lead's own Claude Code session (account `me2`, Max 5x) as Sonnet and Opus subagents, Claude Code
2.1.316. Nothing here is built; the wiring is a proposal (`wiring.md`).

## Verdict

- **The routed single agent works, at the right seat.** On 7 real merged PRs with known later history, deep
  (Sonnet high, prompt v2, three-verifier vote) reached the labelled defect or its bug class on 4 of the 5 defect
  PRs (#119 hit, #92 hit and class, #90 partly, dotfiles #50 hit), missed the dotfiles #51 drift, kept the clean dotfiles #58 clean,
  and every tier caught a real doc lie on the "clean" #64. v1 (API) reached 1 of the 4 labelled defects it reviewed.
  Light and standard are cheap and catch doc drift, not logic bugs.
- **Effort and a data-tracing rule matter more than the model.** Sonnet medium never caught #119's intent miss
  (with or without the rule); Sonnet high caught it once the prompt told it to find the production writer of every
  value the change reads (prompt v2). Opus high matched Sonnet v2 on three of four hard PRs and was ahead on one
  (dotfiles #51, a later-fixed spawn-key bug), at ~1.9× the cost.
- **The vote is the precision gate.** Every `important` that survived three verifiers that we could check was real; the
  one standard-tier false alarm on the clean dotfiles #58 was demoted 1/3 at deep. The one wrong `important` (dotfiles #51,
  standard v2) rested on an external system's contract the agent could not read; the prompt now caps such claims at
  `nit unverified`.
- **Seat for deep: Sonnet high.** Opus high is an owner option, not the default (`report.html`).
- **What no seat fixes:** the dotfiles #51 drift and #90's duplicated fake gateway need a second system's design;
  `REVIEW.md` lines are the lever.
- **Cost on Max (API-equivalent, from the transcripts):** light $0.09, standard $0.21, deep Sonnet v2 $1.33 (votes
  included), deep Opus $2.51. v1 on API credit over the last 3 days: standard $0.49, deep $1.10, default $0.61.

## Files

| File | What |
|-|-|
| `reviewer.md` | The agent (prompt v2.1); `data/reviewer-v1.md` is the first version |
| `review-verifier.md` | The vote agent (deep only) |
| `REVIEW.agent-workflows.md`, `REVIEW.dotfiles.md` | Per-repo REVIEW.md drafts: what failure looks like, `none` and `sensitive` globs |
| `route.py` | The deterministic router; `distribution.sh` routes the last N merged PRs (`data/route-*.txt`) |
| `prepare.sh`, `prior.py` | The PoC job: a detached worktree at the head under `/tmp/rv4`, a job dir of pointers, prior v1 findings on the touched paths |
| `poc-prompt.md` | PoC deviations: the agent writes its JSON to the job dir; no Grep/Glob tools in this install, so read-only Bash search |
| `cost.py`, `show.py` | API-equivalent cost per reviewer (nested verifiers included); findings at a glance |
| `wiring.md` | In-session and hidden transports, the ceiling, convergence, the factory side, cross-repo asks |
| `data/results.md` | Per PR, per arm: findings, the labelled defect, v1's output |
| `data/costs.jsonl`, `data/meter.jsonl` | Per-run cost and wall; account meter readings |
| `data/v1-dispositions.jsonl` | v1's 80 blocking findings on 22 PRs and what the author did (reconstructed from git) |
| `report.html` | The owner's one page |

## Method and its limits

- 7 PRs (4 agent-workflows, 3 dotfiles), labels from later history (Explore sweep): intent miss #119; duplication #90;
  money bug #92; clean #64; architecture drift dotfiles #51; shell bug dotfiles #50; clean dotfiles #58. v1's first prod run
  per PR from the journal (none exists for #64 and dotfiles #50: before the journal).
- Arms: light (Sonnet low), standard (Sonnet medium), deep (Sonnet high + vote) on prompt v1; standard and deep on
  prompt v2 (deep v2 on the four hard PRs); deep on Opus high (prompt v2) for the same four. 36 valid reviews, $23.31 API-eq. A first light batch
  (7 runs, $1.13) is void: this install has no Grep/Glob tools and the prompt forbade Bash, so it could not search.
- **Tuning bias.** Prompt v2's data-tracing rule and the dotfiles REVIEW.md shell line were written after standard
  missed #119 and dotfiles #50. The rule is generic, but its hits on those two PRs are not independent evidence. Wave 11's
  ground truth decides.
- n = 7, one run per arm (the v3 spikes showed run-to-run variance). Direction, not measurement.
- The meter moved `me2` 5 h 6 % → 25 % and week 63 % → 66 % over the batch, including this session's own Opus
  orchestration (~$6) and any other `me2` session: ≈ $1.3 per 1 % of the 5-hour window and ≈ $8 per 1 % of the week,
  an upper bound beside v3's $1.7 and $13.
