# Lead handoff — Wave 18 (Review v4): CLOSE-OUT

Lead `agent-workflows-w1-r16`, spawned by mother `agent-workflows-w1-r4`, 2026-11-03, Opus high, account `me2`.
Wave 15's close-out is in git at `ab765d9`. Nothing deployed: the wave changed no package (spike, docs, a paused
LaunchAgent).

## For the owner

One page: `docs/spikes/review-v4/report.html`, copied to the MacBook at `~/Downloads/review-v4-report.html`.
Evidence: `docs/spikes/review-v4/` (README verdict, `data/results.md`, `wiring.md`).

**Verdict.** One read-only `reviewer` agent, routed by the change into none / light / standard / deep, on Max only.
On 7 merged PRs with known later history, deep (Sonnet high, three-verifier vote) reached 4 of the 5 known defects,
kept the clean PR clean and caught a real doc lie on the other "clean" PR; v1 on API reached 1 of the 4 it reviewed.
Cost: ~25-40 % of one Max 5x week at today's ~520 reviews a week.

**The owner signs** (the report's list):

1. The agent: intent → REVIEW.md/AGENTS.md rules → system fit and duplication → breakage (with data tracing) →
   security; style dropped; Important/Nit/Pre-existing; diff-only re-review, no repeats, step back after round 3.
2. Tiers and seats: none · light Sonnet low · standard Sonnet medium · deep Sonnet high + 3 verifiers per Important.
   Opus is not a tier.
3. Routing by deterministic rules and per-repo `REVIEW.md` globs; no classifier; a caller raises, never lowers.
4. Max only: v1 and the review routes deleted at cutover; at the ceiling (70 % of 5 h, 90 % of the week) review waits.
5. The quota: ~25-40 % of one Max 5x week at today's volume, or cut volume (other fleets at light unless sensitive).
6. The factory guarantees it: evidence kind `review` at the required tier; the wave gate checks coverage; deep cap 15
   per account per day, held past it until a one-click allow, never downgraded.
7. Liveness by idle watchdog, not v3's wall caps (`rules/agent-limits.md`).

## Steps

| Step | Verdict |
|-|-|
| Pause the mining job | Done. `launchctl bootout` + `launchctl disable gui/<uid>/com.jkrumm.agent-workflows-eval-mine` (no run in flight; last night's run was 04:18Z). The plist stays; resume: `launchctl enable gui/$(id -u)/com.jkrumm.agent-workflows-eval-mine && make eval-mine-job` |
| Reviewer agent | `docs/spikes/review-v4/reviewer.md` (prompt v2.1; v1 in `data/`), `review-verifier.md`, `REVIEW.agent-workflows.md`, `REVIEW.dotfiles.md`. Context by pointer: a job dir with diff, stat, intent, history, prior findings, REVIEW.md, AGENTS.md. v2 added data tracing (find the production writer of every value read), "tests are claims", a `checked` list; v2.1: claims on code outside the worktree are `nit unverified`, in-repo claims are checked, verifiers run in the foreground |
| Routing | `route.py`, rules in `wiring.md` §Routing. Over the last merged PRs: agent-workflows 60 → 34 deep, 23 standard, 3 light; dotfiles 40 → 13 deep, 17 standard, 9 light, 1 none. Fixes from the PoC: `boot.ts` and `Makefile` are not sensitive (they routed 5 of 7 PoC PRs deep), size counts non-test lines. From dogfooding: docs are classified by extension (scripts under `docs/` are code); from the self-review: sensitive docs (`rules/security.md`, the global CLAUDE.md) now route deep, renames parse (`--no-renames`) |
| PoC | 7 PRs × light, standard, deep (prompt v1), standard and deep (v2), Opus deep (v2) on the 4 hard ones: 36 valid reviews, $23.31 API-eq on `me2` (Max). Matrix: `data/results.md`. Seat for deep: Sonnet high (Opus matched it on 3 of 4 at ~1.9×). Quota: meter `me2` 5 h 6 % → 30 %, week 63 % → 66 % over the batch incl. this session; ≈ $1.3 per 1 % of 5 h, $8 per 1 % of the week (upper bounds; v3 measured $1.7 and $13). v1 dispositions reconstructed for 80 blocking findings on 22 PRs: 70 % fixed, 4 % wrong (all three lacked context), 26 % ignored (`data/v1-dispositions.jsonl`) |
| Wiring | `wiring.md`: in-session (`/review` → `agw review prepare` → `Agent(reviewer, seat)` → `submit`) and hidden (a factory spawn per job, same agent); the ceiling, no API fallback; convergence; the factory's `review` evidence kind via `agw review route`, the wave gate's `covered` check, role `reviewer`, the deep cap. Cross-repo asks written (dotfiles, software-factory), not executed |
| Report | `report.html` (basalt tokens, light/dark), on the MacBook. `rsync` to `iumac` failed (`unexpected end of file`), `scp` worked |

## Gate

- `make check` (`agw check`, run `01a1a02a-4b65`): format, lint, typecheck pass; tests 4197 pass, 30 skip, **3 fail**
  (`check-real.test.ts`: subdirectory cwd, not-a-work-tree, host credentials; `review-git.test.ts`), all in files this
  wave did not touch. Re-run alone with the test database: 52 pass, 0 fail. Load average ~6.7 during the 460 s suite:
  the timing flakes the mother's notes record; CI on the push is the gate of record.
- Review: no API review spend (owner rule), so the v4 reviewer reviewed this wave's commits on Max in two rounds
  (**Self-review** below); findings fixed in `d38eba5`.
- No deploy, no `make verify`: no package changed.

## Self-review

The v4 reviewer on its own spike, on Max, at the routed tier, as the design proposes:

| Round | Commit | Tier (routed) | Result |
|-|-|-|-|
| 1 | `a9d8cb1` (the spike) | standard (after the docs-by-extension fix; before it the router said light, "docs only") | 1 important, 1 nit, both real: sensitive `.md` globs (`rules/security.md`, the global CLAUDE.md) could never match, so a security-rule change would route light; numstat rename paths parsed to `new}/file` |
| 2 | `d38eba5` (the fix), diff-only, round 1 in `prior.json` as `fixed` | light | Nothing needs fixing; `checked` confirms both fixes and that `wiring.md`'s routed counts match `data/route-*.txt` |

## Proposals for Waves 9–12 and 14 (the mother edits PLAN.md)

Conditional on the owner's signature. They replace the v2/v3 plan; Wave 8's 146 ground-truth cases stay for Wave 11.

- **Wave 9 — Review v4, agw side** (replaces Baseline). `agw review prepare|submit|dispose|route|covered`; the job dir
  (worktree at the head, never the caller's tree; REVIEW.md from the base); the ledger (thread, round, findings,
  dispositions) and REVIEW_OUTPUT v4 (v3's contract plus `tier`, `seat`, `intent`, `checked`); the router from
  `route.py` with REVIEW.md frontmatter; `REVIEW.md` seeded in the five busiest repos (software-factory, iris,
  agent-workflows, dotfiles, usage-tracker). Gate: unit tests through a fake reviewer, one live in-session review end
  to end. Dropped from the old Wave 9: the v1 baseline, the native `/code-review` arm and the OCR arm (all API or no
  longer candidates; OCR's deletion stands).
- **Wave 10 — Review v4, callers, factory, cutover** (replaces Review v2). dotfiles: `agents/reviewer.md`,
  `agents/review-verifier.md`, the `/review` skill (prepare → Agent with the seat → submit → fix loop, dispositions,
  `stepBack`), lead role without the separate `/code-review high`, `wave-gate.py` `covered` check. Hidden transport: the
  factory role `reviewer`, agw's desk step over the factory socket, the idle watchdog, two sessions host-wide, the
  ceiling, the deep cap and its ask. software-factory: evidence kind `review` derived through `agw review route`.
  `scripts/verify.sh` smoke review on the hidden path at light (`SKIP` when held). Cutover in the same wave, since
  there is no API fallback by owner direction: every caller on v4; v1, the angle agents, router, adversary,
  synthesis, OCR, react-doctor in review, the review routes and the 138 legacy cases deleted; a concept version note.
- **Wave 11 — Measure and tune** (replaces Arm sweep). Two weeks of ledger dispositions per tier, rule and repo (fix
  rate, wrong rate, rounds to clean, findings per review); false alarms on 10 known-clean PRs; recall on the Wave 8
  cases (`dev` slice first) through the hidden path on Max, paced by the ceiling, never API. Arms: K 3 vs 2, verifier
  seat Sonnet vs Haiku, Opus at deep on sensitive paths, router thresholds, the deep cap. Report
  `docs/evals/<date>-review-v4.md`.
- **Wave 12 — Central tiers.** Unchanged in shape, but review is no longer a route consumer: the `HARD`/`EASY` picks
  keep Wave 6's measured seats instead of waiting on the review sweep.
- **Wave 14 — Harness robustness.** The runaway-cap review loses its deep-review part (review is no longer an agw
  agent step). Add: the hidden review session's idle watchdog proven by killing a wedged session; reviewers that
  background their verifiers and linger (seen twice in the PoC, stopped by hand); the convergence sub-eval reads
  rounds to clean from the ledger plus a 10-case fix loop on Max.

## Spend (this lead)

Max (`me2`): PoC $23.31 API-eq (36 valid reviews + a void first light batch $1.13), the self-review, two Explore
sweeps, the v1-disposition agent, and this session's orchestration. API credit: none (no `agw review`, no eval run;
`agw check` calls no model).

## Left behind

- **Mining job paused** (above). Wave 15's eval-credit first steps (prose-polish, the two refused retrospective
  cases, one podcast run and its duration band) are untouched and still open.
- **No arm found** dotfiles #51's drift (the gate copying the factory's drain admission) or #90's duplicated fake gateway:
  both need a second system's design. Seed `REVIEW.md` lines for them in Wave 9 ("admission belongs to the factory",
  "one fake per port, in `@agent-workflows/testing`").
- **Tuning bias:** prompt v2's data-tracing rule and the dotfiles REVIEW.md shell line came after standard missed #119
  and dotfiles #50; their hits there are not independent. n = 7, one run per arm.
- **Tools:** this install has no Grep/Glob tools, so the agent searches with read-only Bash. The build must enforce
  read-only Bash for the reviewer (a hook keyed on the agent type, or a settings allowlist for the hidden session);
  verify with `/research` which mechanism Claude Code offers before building it.
- **Open for the build:** whether the factory passes `--agent reviewer`; `prior.json` from a real ledger (the PoC used
  v1 findings on the touched paths with state `unknown`); the `checked` field in REVIEW_OUTPUT; the deep cap value.
- The `/tmp/rv4` worktrees of both repos are removed (`git worktree prune` clean).

## Retro notes (for the mother's log)

- Check a PoC agent's tool set first: the first light batch could not search (no Grep/Glob here, Bash forbidden by
  the prompt) and was thrown away.
- Subagents that background their own subagents linger after replying ("waiting on its own background work"); the
  prompt now asks for foreground verifiers.
- The model-discipline hook asks for a stated reason on an Opus subagent; the description field carries it.
- Dogfooding the router on the wave's own commit found a rule gap (scripts under `docs/` counted as docs).
