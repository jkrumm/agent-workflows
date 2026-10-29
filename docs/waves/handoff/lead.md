# Lead handoff — Wave 6 (research; P3a), close-out

Leads: `agent-workflows-w1` first lead (pane w40:p16, 2026-10-28 ~22:05 → 2026-10-29 ~01:30 UTC+1, rotated at ~60 %), second lead
`agent-workflows-w1` (pane w40:p1B, 2026-10-29 ~01:35 → ~03:45). Briefs: `~/.local/state/agent-workflows/briefs/w6/` on the
mini (not in git: they name local paths). The rotation checkpoint is in git history at `2ddc777`.

## Per-step verdict

|Step|Verdict|Evidence|
|-|-|-|
|CI green on master; train gates on CI; load-aware timeouts|**done** (first lead)|#28, dotfiles #39. Not a credential leak: make recursion state (`MAKELEVEL`/`MAKEFLAGS`) and `run-step.sh` under dash. CI green on every master push since `e65cebb`; the train printed "CI passed for … at <sha>" on #29–#36|
|P2 gate: Sonnet angles vs Haiku (20 paired cases)|**answered** (first lead), **implemented** (#33)|Recall 0.017 → 0.13, located +0.09, precision 0.10 → 0.50, cost $0.057 → $0.542 per review, wall unchanged. Mother decision: Sonnet for `--deep` only. #33: route `review.angle.deep` (`claude-sonnet-5-5-eu`, in 2 / out 10 / cache read 0.10 (0.05×) / write 2.50 per M, `longPromptTokens` 1M: Anthropic's page lists no long-context tier for Sonnet 5.5). Sonnet only when the **caller** passes `depth: deep` (`decision.source === 'caller'`); a router-chosen deep stays on Haiku. `plan` records `angleRoute`; the fingerprint lists both routes. Concept v3.5|
|Three-way comparison on the 28 golden questions|**done**: A-yolo|Numbers below; doc `docs/research/2026-10-28-research-three-way.md` §Results (#35). Checked by the lead from the run records (`compare.ts` over the 15 eval run ids)|
|`research` ported in the winning shape, follow-up included|**done** (#36)|One agent `agents/research`, web tools through the gate; engine, pilot, focused arms, `design`/`profile`, the engine adapter, `compare.ts`/`decision.ts` deleted (−1833/+518). Follow-up: `agw research "<q>" --follow-up <runId>`; citable set = the earlier run's retrieved pages + its final citations' URLs; earlier research fenced as data in the prompt. Live regression (1 pass × 28, team key): golden 0.964, supported 0.929, judgedShare 1.0, median $0.0069, p50 9.7 s (A-yolo: 0.98 / 0.91 / 0.99 / $0.0063 / 9 s); standard+deep golden 1.0, $0.033, 42 s; one miss `notfound-rfc-99999`. Eval run `01a1857a-fb12-7320-a3a6-b74b9776b6da`. Research stays in the host process (concept v3.6): host RSS 52 → 97 MB mean (157 max), CPU 0.3 → 3.4 % mean during the pass|
|`/research` switched; research-gateway `/mcp` deleted, MCP registration removed|**done**|dotfiles #40 (skill on `agw research` incl. `--follow-up`; global CLAUDE.md, rules, implement/upgrade-deps skills, docs; Makefile MCP target + doctor line, settings template permissions, Codex and OpenCode MCP entries, `scripts/mcp-research-headers.sh` removed; `_setup-codex` re-rendered). research-gateway #42 (`src/routes/mcp.ts`, `.use(mcpRoutes)`, discovery entry, MCP SDK dep, `wait.ts` deleted), auto-deployed by its CI-gated poller at 03:32. `claude mcp remove research-gateway -s user` on the mini in `~/.claude`, `-me`, `-me2`. MacBook: unreachable (ssh iumac timed out), queued as ask-human `20261029T033409-656`|

## Comparison numbers (420 runs, 0 failed, every run priced; deploy `5025eec`, team key)

|Arm|golden|supported|judged share|median $|p50 wall s|unscored|partial|
|-|-|-|-|-|-|-|-|
|E engine|0.99|0.73|0.97|0.0101|22|3|5|
|**A-yolo**|0.98|0.91|0.99|0.0063|9|0|8|
|A-focused|0.97|0.93|0.99|0.0054|8|5|11|
|P-yolo|0.97|0.79|0.99|0.0135|30|4|5|
|P-focused|1.00|0.75|0.96|0.0128|34|4|0|

Rule: A-yolo − E golden +0.012 [−0.036, 0.071], supported +0.185 [0.065, 0.321] → eligible; P-yolo − E golden −0.012
[−0.119, 0.095] → not eligible; cost standard+deep A-yolo $0.0279 vs E $0.1383 → **A-yolo**. Profile: focused never beat
yolo with a CI excluding 0. Standard: E $0.133 / 171 s vs A-yolo $0.026 / 39 s. Deep is n = 3 per arm (indicative only).
Engine token columns are n/a (the engine reports cost only).

## Merged this wave (second lead)

|PR|What|Review|
|-|-|-|
|#32|research follow-up round 5 (settle before close, abandoned engine job booked, 4xx `answerOf`, incomplete runs out of the rule)|lead read r5 (first lead: `/code-review high` r1–r4); merged by the worker on the owner's ask|
|#33|deep angles on Sonnet|`/code-review high` r1 (8: caller-only opt-in, long-prompt tier, casts, magic number; 4 dismissed: shared fingerprint by design, dedupe level, synthesis on Haiku as measured, Sonnet config proven live at verify), r2 ran on a stale local branch (see Friction) and was discarded, r3 on the real head (8: one depth derivation, `angleRoute` recorded, schema help, Sonnet config test; 4 dismissed), lead read r4|
|#34|test race: gate drain tests synchronised on "in flight", requests settled inside their test|lead read (test-only)|
|#35|comparison results doc|lead read (doc-only)|
|#36|research port|`/code-review high` r1 (10: migration 0009 unsafe for a rollback → removed, engine columns kept; follow-up citable set; no-journal message; data framing; 2 dismissed), r2 (8: no-new-pages warning, drop reason, fenced block, raw URLs, README; 3 dismissed: strict input with no runs in flight, seen-only citations as in the first-run rule, journal size), lead read r3|
|dotfiles #40|`/research` switch, MCP registrations removed|lead read|
|research-gateway #42|`/mcp` deleted|lead read (deletion only, REST unchanged)|

`make check` at the last merge (#36 in the train): 1193 pass, 15 skip, 0 fail, 1208 tests. CI green on master through
`0c360db`; `de21c26` (docs) running at close.

## Live proof (`@verifier`, personal key, release `0c360db`): 8/8 PASS

1. `make verify` PASS (run `01a18585-f995-…`, cap run `01a18585-fead-…`).
2. `agw research` quick: done, ok, 2/2 grounded, $0.0067, deepseek-v4.1-flash answered (no fallback), iu_key personal,
   purpose verify (run `01a18585-0bfd-77a6-a97e-dba1647bb478`).
3. Follow-up on it: done, 3/3 grounded, $0.0068 (run `01a18585-4228-…`); a random run id → typed `invalid_input`.
4. Spans in prod ClickStack: `agw.run research` with `agw.step tools` and `agw.step research`, OpenCode spans under the step.
5. Argo outbox: every priced step synced (`argo_synced_at`), 0 pending, 0 `argo_error` (Argo's DB itself not read).
6. Deep review live: `angleRoute: review.angle.deep`, angles on claude-sonnet-5-5-eu, synthesis on Haiku, $0.118, 36 s,
   0 unpriced (run `01a18585-da99-75bf-8d0f-ce7b1d149f7c`).
7. research-gateway: `POST /mcp` 404, discovery lists no mcp, `/health` ok; no research-gateway MCP in any mini account.
8. `/research` skill calls `agw research`; no `mcp__research-gateway` in `~/.claude/{CLAUDE.md,rules,skills}`.

## Host state

Release `0c360db` on the **personal key** (`~/.config/agw/iu.env` removed, host kickstarted, `/health` ok). DeepSeek
answers on the personal key again. No `routes.json`. Engine eval instance on :7795 stopped. Main checkout clean on master.
`~/.config/agw/athena-iu.env` is still on disk (not loaded by `launch.sh`; not the fleet's to delete without the owner).

## IU spend, by key (runs since 2026-10-28 21:50 UTC)

|Key|Purpose|Runs|Spend|What|
|-|-|-|-|-|
|athena-team|eval|2750 top-level|**$26.13**|Haiku baseline $1.18, Sonnet arm $11.60, research smoke $0.29, full comparison $12.57, port regression $0.49; 48 unpriced (review long-prompt tier, 6 `web.package`)|
|athena-team|prod|28|$0.23|callers of the live host during the window (24 unpriced), not the fleet's evals|
|athena-team|verify|6|$0.00|deploy verifications|
|personal|verify/prod/retro|7|≈ $0.14|`@verifier` (research, follow-up, deep review $0.118), smokes|

## Left behind

- MacBook: research-gateway MCP registration not removed (unreachable); ask-human `20261029T033409-656` queued.
- research_tool_calls keeps the unused engine columns and booking index (0007/0008) for the rollback target; drop them in
  a later release once no rollback target reads them.
- research-gateway's REST door, its `research` CLI and `scripts/opencode-service-env.sh`'s `RESEARCH_GATEWAY_AUTH` stay
  until P6 archives it. CONTEXT7_API_KEY still resolves through research-gateway's 1Password item: move it first.
- Run fingerprints: review lists both angle routes, so a deep and a standard review share a fingerprint; `plan.angleRoute`
  separates them in queries. The eval harness's `--depth matched` sends recorded deep cases to Sonnet angles (~10×).
- `agw research` printed `cost: null` in its CLI response while the run record was priced ($0.0018): the CLI's
  synchronous answer does not carry the final cost.
- The eval plan's estimate for research ($1.83 for one pass, actual $0.49) averages history that includes the deleted arms.
- `opencode-host/test/host.test.ts` "abort interrupts once and is idempotent" uses `Bun.sleep(50)` as synchronisation
  (same class as #34), seen failing once under load; and the load-scaled timeout is still sampled once per `make check`
  (git-heavy review `scopes` tests hit 5.1 s under load spikes; two train reruns).
- Not ours: dotfiles architecture-check rows (com.iu.athena-postgres, com.iu.teamchat-*, collie pin, tailscale drift);
  agent-gateway dispatch-worktree credential test.

## Retro notes (both leads)

- **Pre-registered rules pay.** The rule fixed before the first live run made the verdict a query, not a debate; the
  lead re-derived it from the run records in one command.
- **Experiment harness: fix what bends the numbers, document the rest** (first lead). #30/#31 fix rounds kept finding new
  classes until design changes (HTMLRewriter; one attempt-key rule) closed them; #36 converged in two rounds once
  findings were split into "bends correctness" and "hygiene".
- **Deleting the experiment is a migration hazard.** The port's first draft dropped columns the rollback target still
  writes; expand/contract (keep, drop later) is the rule for any column a previous release touches.
- **Review forks and the shared checkout.** A `/code-review` fork created a local `pr33` branch in the main checkout; the
  next review read that stale branch and reported already-fixed findings. Pass the remote ref and "never check out in
  this checkout" in the review args; `git status -sb` before trusting a review.
- **Sleep-as-synchronisation is a flake class.** Two test races (#34) failed the train only under load; deterministic
  "in flight" signals fixed them; one more remains (Left behind).
- **`rd fan --clean <repo>` is repo-wide**: it also reclaimed another session's merged worktree in research-gateway
  (merged a month ago, nothing lost). Fleet-scoped cleanup would be safer.
- **Order of cutover steps.** The MCP was removed on the mini a few minutes before the new skill merged; harmless here,
  but the switch (skill live) should land before the old door is removed.
- **Spend.** Team key $26.13 against estimates of ≈ $5 (Sonnet arm, actual $11.60) and ≈ $10 (comparison, actual
  $12.57): Sonnet arm was the miss (long agentic turns, 2× the tool calls).
