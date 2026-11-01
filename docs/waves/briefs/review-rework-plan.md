# Brief: plan the review rework and its eval harness

**You are planning, not building.** The deliverable is a committed plan the owner reviews before any code: a design page
`docs/review-v2.md` (verdict first, short) and a rewritten `docs/waves/PLAN.md` that puts the review rework and its eval
in front of the current tiers plan (or merges with it, your call, argued). Commit and push both, write a five-line summary
for the owner at the top of `docs/review-v2.md` ("Decisions I need from you", at most three, each with your tendency), then
stop. Spawn no waves and no workers; `/research` and read-only `Explore` are fine.

Owner framing (2026-11-01): greenfield, solo developer, optimal over compatible. The current pipeline can be reset. The
goal is review that is **more effective while being cheaper and faster**, and an **eval harness that can rank models and
pipeline variants**, so tier choices rest on data.

## What exists (audit 2026-11-01, HEAD `94ad2b1`, verify before relying on it)

- Pipeline `packages/host/src/workflows/review/` (`index.ts:154-320`): prepare → react-doctor ∥ adversary single call →
  router picks angles + depth → up to 8 angle agents (floor 6, `angles.ts`, `schema.ts:8`) at 3 in parallel → synthesis
  (dedup and ranking are only prompt text, `agents/review-synthesis/AGENTS.md`) → outcome computed in code
  (`verdict.ts`). Every seat is GPT-6.1 Terra low/medium (`packages/routes/src/table/review.ts`, `_shared.ts:30-36`).
  **No step verifies a finding against the code.** Output REVIEW_OUTPUT v2 (`schema.ts:114-136`).
- Consumers: the `/review` skill (`~/SourceRoot/dotfiles/skills/review/SKILL.md`; `--deep` adds Claude Code's native
  `/code-review high` and `/security-review` on the Max subscription and merges them). Stale skill text: adversary
  "when warranted" (it always runs), angles "have Bash" (they don't); `index.ts:84,207` and README still say "Sonnet/Haiku".
- Evals: `agw eval run|compare` (paired bootstrap CIs) and the older `packages/eval/src/harness/cli.ts`. 138 review cases
  (`~/.local/share/agent-workflows/eval/`), all recorded runs of the retired gateway, 90 from argo, 4 clean. The scorer
  (`review/scorer.ts`, matcher `harness/match.ts:8-11`: same file, ±5 lines, ≥0.3 token overlap) has no judge.
  `docs/evals/2026-10-31-review-claude-direct.md`: recall ≤ 0.05, precision 0–0.08 on every arm; the verdict tracks
  how readily a model says "blocking" (Terra 87 blocking findings over 12 reviews, Sonnet 5). Lessons:
  `docs/evals/README.md`. Gaps: no ground truth, no clean controls, no false-positive metric, arms swap via
  `routes.json` + host restart (moves production traffic), `eval.run` cost is null, n = 12 paired.
- Private audit numbers: `~/SourceRoot/agw-maturity-audit.md` (never copy its numbers into tracked files).

## Anthropic's account (claude.dev "How the Claude Code team does code review", 2026-10-15), the parts that matter

- Several agents hunt bugs in parallel; **a separate group votes on each finding, posted only if enough agree it is
  real.** Style, diagnostics and cleanup-only findings are dropped (A/B tested). Tags: Important, Nit, Pre-existing.
- Review reads the diff against the whole repo and the change's stated intent; for a fix, it asks for the root cause.
  CLAUDE.md/AGENTS.md is loaded; a short owner-written REVIEW.md per repo says what matters (define failure, cap nits,
  skip paths, file-and-line evidence, summary starts with a count and says plainly when nothing needs fixing).
- **Eval:** a dataset of historical PRs that caused incidents (with their reverts and fix-forwards), each bug confirmed
  and located by an engineer; scored daily; every new incident becomes a case; rescore on any prompt, tool or model
  change. Metrics: **recall** and **rounds-to-pass**; noise measured by the author's response to each comment (fixed /
  wrong / intentional / did not matter); runs on known-clean PRs counting findings that would have caused a harmful
  change. Priority: real bugs first, fewer rounds second.
- **Convergence:** agent author + agent reviewer looped 50+ rounds once; 59 % of late findings were code present since
  the first pass. Fix: after the first passes re-review is diff-only, findings already posted are not repeated, the
  reviewer names the bug class so all instances get fixed, and after three rounds it asks the author to reconsider the
  approach. Quick / Standard / Deep levels per repo.

## Questions the plan must answer (with a recommendation each)

1. **Ground truth from our own history.** Mine every repo under `~/SourceRoot` (and the IU repos only if the owner
   agrees; they are work code) for introducing commits of later fixes: `fix(...)` commits, reverts, `git blame` of the
   fixed lines back to the commit that introduced them; the introducing diff is a case, the fixed lines are the located
   bug. Add clean controls (commits never touched by a later fix within N weeks, docs-only and refactor commits) and,
   only if the historical set is too small, seeded defects as a secondary set. How many cases, how labelled (an agent
   proposes, the owner confirms a sample?), how kept out of tracked files when they hold private code.
2. **Matching and judging.** Replace or back the token-overlap matcher with a judge that decides "does this finding
   describe this bug", calibrated against a hand-labelled sample. Which tier judges, how its agreement is checked.
3. **Metrics:** recall on real bugs, harmful-finding rate on clean controls, noise (findings per review that are not
   bugs), rounds-to-pass in a fix loop, cost and wall time per review. One headline score or a Pareto table.
4. **Arms.** The current agw pipeline; a v2 pipeline (finders + per-finding verification vote + severity tags + diff-only
   re-review); Claude Code's native `/code-review` on the Max subscription (flat cost; but the platform has **no
   headless `claude -p`**, see `~/SourceRoot/dotfiles/docs/agent-platform.md`: how does an eval run a native arm?
   Interactive sessions spawned by the software factory in herdr-core terminals are the allowed route; say whether that
   is worth it). Per-arm route overrides without a host restart.
5. **The v2 pipeline itself:** how many finders and on which tier, the verification vote, what is dropped, severity and
   `Pre-existing`, REVIEW.md per repo, levels, re-review diff-only with a findings ledger so nothing is repeated, the
   three-round step-back. Who records each finding's disposition (fixed / rejected with reason) so noise is measured
   in real use, not only in the eval: the `/review` skill loop is the natural place.
6. **Ordering against the current PLAN.md** (central tiers, eval plumbing, accounting, robustness, coverage): which of
   its waves the rework needs first (eval cost roll-up, structured agent output, per-arm overrides) and which wait.
7. **The software factory's use of review later** (its F2 Issue machine gates work on evidence; `~/SourceRoot/
   software-factory/docs/design.md`): one interface the factory can call, nothing factory-specific built now.

## Rules

- `AGENTS.md` here and the global rules apply: route ids live only in the route table, no Biome, exact pins, research
  library facts with `/research`, no agent caps (`~/.claude/rules/agent-limits.md`: no turn or wall-clock limits on agent
  steps; the idle watchdog and the runaway cap are the only stops).
- Public-repo hygiene: no private numbers, hostnames or code excerpts from IU repos in tracked files.
- Stale docs are part of done: list (don't fix) the stale lines you meet in `docs/review-v2.md` §Docs to fix, so the
  first build wave fixes them.
