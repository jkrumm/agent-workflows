# Lead handoff — Wave 17 (Review on the subscriptions, design): CLOSE-OUT

Lead `agent-workflows-w1-r13`, spawned by mother `agent-workflows-w1-r4`, 2026-11-03 00:20 → ~01:45 CET. Wave 16's
close-out is in git history (`f960d26`, hotfix notes up to `a6c0dd1`).

## For the owner: one page

**The pick.** Review runs in **interactive Claude Code sessions on the Max subscriptions**, with Anthropic's own
`/code-review` as the finder and our verify vote on top. `agw review` stays the one interface and agw code keeps
prepare, assemble, ledger, dispositions and the eval. A Claude Code caller (your sessions, waves, leads) reviews
**in-session** through a `reviewer` subagent pinned to Sonnet. Every other caller (Hermes, `make verify`, the eval,
scripts) gets **one factory-spawned session per review**. No `claude -p`, no Agent SDK, no entrypoint relabel. Today's
API review (v1) stays as the fallback until Wave 11 measures it. Design: `docs/review-v3.md`.

**What the spikes showed** (`docs/spikes/review-v3/`, 6 real PRs, 10 sessions, plus the verify stage end to end):

| | Result |
|-|-|
| Finder quality | `/code-review high` found PR #119's real bug, which v1 had called clean, and #118's abort-path spend loss (the gap Wave 16 left behind). Of its 20 `important` tags, 2 were real defects, 18 true but minor, 0 false: accurate, with inflated severity. Hence the verify vote, a severity gate: on #118 our verifiers kept the real one and demoted the other 4, matching an independent judge. The finder varies: a second `high` run on #119 missed the bug the first one found |
| Cost | `standard` (`high` + verify) on Sonnet: ~$0.5-0.9 API-equivalent, 1-3 min, **~0.3-0.5 % of a Max 5x five-hour window, ~0.05 % of its week** (calibrated: $1.7 per 1 % of 5 h, ~$13 per 1 % of the week). `deep` (`xhigh` + security + K=3) ~$2-4. `max` ran 21 min, $22, and hung: banned |
| Transport | In-session: a Sonnet `reviewer` subagent runs the skill fork and its verifiers (depth ≤ 2) from an Opus caller, $0.50 and 73 s end to end. Per-job factory spawn: started in 6-14 s, job in a file, result in a file, closed after. A standing session fed by factory notes also works (`/clear` as a note works) but saves no tokens and adds failure modes. In-session costs the caller ~5k tokens of context, because the native skill forks itself |
| Failure | A killed session reads `dead` in 3 s and leaves nothing behind. Esc does *not* stop a background review; kill does. Every transcript is `entrypoint: cli` |
| Policy | #97074 (users measure headless at 1.3-3.0x on the 5 h window) has no Anthropic reply. The t3code relabel PR was closed unmerged; a relabel reports a client that is not the one running, which we read as the Usage Policy's new (2026-11-12) "misrepresent the product or client". Unsound; we never need it |

**Options the spikes left:**

| Option | Verdict |
|-|-|
| In-session `reviewer` subagent (Claude Code callers) | **picked**, main path |
| Per-job factory spawn (everyone else) | **picked** |
| Standing reviewer session fed by notes | works, rejected: needs `/clear` and per-job `cd`, one crash loses its queue, no token saving |
| Stay on API (v1 now, v2 as planned) | fallback only: $0.12 per review, but it missed the bug the native skill found |
| Channels / the cross-session messaging socket | documented, not needed; the reserve transport if typed notes break |
| `claude -p`, Agent SDK, `CLAUDE_CODE_ENTRYPOINT` relabel | excluded (your constraint, policy) |

**Risks.** (1) **Quota contention:** the accounts are already near their weekly walls (`iu` 87 %, `me` 95 %
tonight). Review adds ~10 % of one Max 5x week per 200 standard reviews; under pressure it waits or falls back to v1.
(2) **The native skill changes with Claude Code releases** (daily updates): the version is recorded per run, and a
bump re-runs the `dev` slice. (3) **Terms:** unattended interactive sessions sit in the consumer terms' "automated
access" grey zone. That is true of every wave today; review adds volume, not a new category. (4) The verify vote is our
addition, checked on two PRs only; finder recall varies run to run (Wave 9 repeats cases). (5) The desk path
depends on the factory being up (else v1). (6) A diff could try to instruct the reviewer, so the reviewer role needs
a deny list, which Wave 10 proves.

**What you sign:**
1. The native `/code-review` as the finder candidate (`standard` = `high`, `deep` = `xhigh` + `/security-review` + a
   cross-vendor voter, never `max`), plus our verify vote; Wave 11 confirms or replaces it on ground truth.
2. Two paths: in-session for Claude Code callers at `quick`/`standard`, per-job spawn for `deep` and every other
   caller; no standing session.
3. Review on Max under a review ceiling (no new review above 70 % of 5 h or 90 % of the week, starting values), at most two
   review sessions at once; v1 on API credit as the fallback until Wave 11.
4. The cross-repo asks: dotfiles `agents/reviewer.md` + `agents/review-verifier.md` and the `/review` rewrite;
   software-factory role `reviewer` (with `--agent`, the ceiling).
5. Waves 9-11 rewritten as below (you edit PLAN.md); Wave 12 loses review's seats (review no longer runs on `HARD`/`EASY`).

## Verdicts

| Spike | Verdict | File |
|-|-|-|
| S0 policy | interactive `cli` sessions only; relabel unsound; `claude -p` stays banned | `docs/spikes/review-v3/s0-policy.md` |
| S1 transport | per-job spawn + in-session Sonnet subagent; desk rejected; the preparer must set the diff base (upstream) | `s1-transport.md` |
| S2 cost, quota, quality | `high` ≈ 0.2-0.3 % of a Max 5x 5 h window, ~0.03 % of a week; 2 real / 18 minor / 0 wrong of 20 `important` | `s2-cost-quality.md` |
| S3 concurrency | two at once clean; factory spreads accounts; cap at two | `s3-concurrency.md` |
| S4 crash, timeout | death seen in 3 s; Esc is not cancel; `max` hung; wall caps by kill | `s4-crash-timeout.md` |
| S5 verify end to end | subagent → skill fork + verifiers works (depth ≤ 2, Sonnet); verify kept the real finding and demoted 4 minor; ~$0.10 per candidate; finder recall varies per run | `s5-verify.md` |

Research (cited, `docs/spikes/review-v3/research/`): `r1` the Claude Code team's own post ("How the Claude Code team
does code review", claude.dev, 2026-10-15: finders, a vote per finding, Important/Nit/Pre-existing, the 59 %
late-findings lesson, three-round cap, REVIEW.md), the `/code-review` docs (runs as a background subagent, `ultra` in
the cloud), managed Code Review (GA 2026-10-15, Team/Enterprise, usage credits); `r2` policy and every documented way
into a running session; `r3` published practice (no independent false-positive rates; verify with fresh context).

## Evidence

- Transcripts on the mini: `~/.claude-me2/projects/*rv3-pr1*/`, `~/.claude/projects/*rv3-desk*/` (session ids in
  `~/.local/state/agent-workflows/rv3/*/sid`, `desk*.sid`); job files and outputs under
  `~/.local/state/agent-workflows/rv3/`; committed copies in `docs/spikes/review-v3/data/`.
- Quota readings: `data/quota-readings.jsonl` (`claude-account usage --json` at each batch edge).
- Judge of the 20 `important` findings: S2 §Quality (a Sonnet subagent, read-only, fresh context).

## Proposed Waves 9-11 (for PLAN.md)

**Wave 9 — Baseline (native finder arm runs as the v3 candidate).** Needs Wave 8's ground truth.
- v1 on the full `test` set and the controls, on its live seats (unchanged).
- **Native finder, raw:** `/code-review high` (twice per case: S5 saw run-to-run variance) and `xhigh` on 60 `test`
  cases (owner decision 3) and 30 controls
  through per-job factory spawns, the spike's protocol (`docs/spikes/review-v3/data/protocol.md`, job file, worktree
  with upstream = base), findings via `agw eval import`. Paced: role `worker`, two at a time, review ceiling by hand
  (`claude-account usage`). Budget ≈ 90 × (2 × $0.35 + $0.86) ≈ $140 API-eq ≈ 11 % of one Max 5x week, spread
  over days; `dev` slice first.
- OCR arm as planned (owner, 2026-11-02).
- Report `docs/evals/<date>-review-baseline.md`: recall, false alarms, wall, API-eq and quota share per arm.

**Wave 10 — Review v3 build** (if signed; design `docs/review-v3.md`).
- agw: `review` v3 (prepare with the upstream base, `submit`/assemble/ledger, `dispose`, REVIEW_OUTPUT v3, `--where
  auto|session|desk|api`), a `ReviewDesk` port (factory adapter + a fake for tests), wall caps by kill, one retry, the
  2-session semaphore, the review ceiling in `prepare` for in-session callers, worktree lifecycle and sweeper, the
  round-2 ancestry rule, idempotent `submit`, `engine` recorded (Claude Code version, account, API-eq from the
  transcript), the `deep` extras (`/security-review`, one cross-vendor voter in assemble), v1 as `--where api` behind
  the v3 adapter. `scripts/verify.sh`: desk and api smokes on schema 3.
- dotfiles: `agents/reviewer.md`, `agents/review-verifier.md`, the `/review` rewrite (fix loop, dispositions,
  `stepBack`), `lead.md` without its separate `/code-review` step.
- software-factory (via its fleet): role `reviewer` (Sonnet, `--agent reviewer`, hidden, the review ceiling).
- Proofs: a planted-injection fixture diff against the reviewer's deny list; a live review on each path; `REVIEW.md`
  template. Prompts iterate on `dev` only.

**Wave 11 — Arm sweep and cutover.**
- Arms on `test`: v3 `standard` (high + verify K=1), v3 `deep` (xhigh + K=3), verifier on Sonnet vs Haiku, a GPT
  voter (gateway, credit) vs a second Claude voter, raw native (from Wave 9), v1. The decision rule of
  `docs/review-v2.md` §Metrics plus a quota column (share of a Max 5x week per 100 reviews).
- Cutover: the pick becomes `review`. v1 stays as the API fallback only if its recall sits inside the pick's CI;
  else the fallback is "wait for quota", and v1, the angles, router, synthesis, adversary, OCR and react-doctor in
  review are deleted with their routes. Concept version note; `REVIEW.md` seeded in the five busiest repos.
- Wave 12 then measures `HARD`/`EASY` without review in them; Wave 14's convergence sub-eval runs on v3.

## Retro notes

- **Per-review quota cannot be read off the meter**: it moves in 1 % steps and one `high` review is ~0.2 % of the
  5 h window. The method that works: exact tokens from transcripts, plus a $-per-point calibration over a window
  with every session of that account summed. The owner's "quota before and after" holds only per batch.
- **Merged PRs need their base pinned**: in a worktree whose local `master` already holds the PR, the skill's
  fallback diff is empty, so one `low` run reviewed nothing. The upstream trick fixes it and is now in the design.
- The `/code-review` levels differ in structure (one inline pass, 8 or 10 inline angles, fan-out), not only in
  depth. That is visible only in the skill's prompt inside the transcripts; the docs don't say.
- The `max` run should have had a wall cap from the start: $22 of a shared account for no result.
- `me2`'s 5 h meter did not drop at its stated reset time (00:40); deltas were measured instead.
- **A fresh-context critique of the first draft was worth it**: it found that the verify stage and subagent nesting
  (the main path) had never been run, plus 13 design holes (worktree cleanup, rebase between rounds, duplicate
  submits, in-session quota, the v1 output shape). S5 and the rewrite of `docs/review-v3.md` came from it. Do it
  before a design goes to the owner, not after.
- The factory placed parallel spawns on different accounts unasked (the desk landed on `iu`), which made the `iu`
  part of the batch unmeasurable by meter: tokens covered it.

## Left behind

- PLAN.md is untouched (the owner edits it): Wave 17's steps are done as described here; Wave 8 resumes next.
- `docs/concept.md` gets its v3.x note and retro entry when Wave 10 builds v3 (the mother's retro log).
- `docs/review-v2.md` is superseded where `docs/review-v3.md` differs; it gets a pointer line in Wave 10, when its
  "Docs to fix" table is worked anyway.
- Spike worktrees and branches removed; all spike sessions closed (`hc kill` + `hc rm`); scratch state stays in
  `~/.local/state/agent-workflows/rv3/` (outside git).
- Gate: docs and spike data only (`docs/spikes/**` is excluded from every tool), no code changed, so no `make check`
  or deploy. The current review (Haiku angles, Haiku synthesis, Sonnet deep) is untouched and live.
- Spend: API credit $1.04 (three research runs); Max: $25.4 API-equivalent in spike sessions on `me2` and `iu`
  ($22.0 of it the killed `max` run), $1.09 in S5, plus this lead's own session and its subagents on `me2`
  (`me2` 51 % → ~80 % of its 5-hour window, 55 % → 59 % of its week over the wave).

stopped: owner sign-off of review v3
