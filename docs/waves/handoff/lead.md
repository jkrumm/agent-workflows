# Lead rotation handoff — Wave 4 (review and check cut over; P1c), in flight

Lead `agent-workflows-w1` 2026-10-28 ~05:10 → ~09:25 (rotated at the context limit; a Max usage-limit pause ~05:55–08:50).
Briefs (one per worker, `roles/worker.md` template + shared rules): `~/.local/state/agent-workflows/briefs/w4/` on the
mini (not in git: they name local paths). Master: `origin/master` after #18 (`rd merge`, `make check` 577 pass, 0 fail).

## Per step

|Step|State|Evidence|
|-|-|-|
|Owner-gated deploy chain|**done**|Request `20261028T005518-15306` failed on the MacBook (`op` read the piped stdin as a JSON template: "invalid JSON in piped input"); re-asked with every `op` on `</dev/null` → `20261028T085931-14819` done, item created with `API_SECRET, ARGO_URL, OTEL_EXPORTER_OTLP_ENDPOINT`. Refs added to `dotfiles-private/headless.refs` (`314e526`). Reseal: first dialog denied (1 s, reflex), retry `20261028T090124-10594` done. `make deploy` → release `d718900` healthy; `make verify` PASS (smoke run `01a18188-1313-7674-be46-6a83f9578ead`, trace `4fb88df6…`, cost $0.0000224). `@verifier` PASS: run + step rows, `argo_synced_at` 22 s after the run; ClickStack prod trace with `agw.run smoke.ping` + child `agw.step title`, attributes = journal; Argo `/usage/summary` + `/usage/flow` show the row (source `agent-workflows`, sub_tool `smoke.ping`, haiku, $0.0000224; no per-row read endpoint for `source_id`); CLI `--help`, `schema`, `run status|wait`, `agw check` on a temp repo → passed (no LLM); host err log empty. dotfiles #34 merged (rebase, not-ours-rows comment); `make doctor`: `com.jkrumm.agent-workflows-host` ✓ (rc 2 only on the not-ours rows). **Redeploy needed**: the live release predates #18/#19; `make deploy && make verify` (verify now also checks the direct `agw llm title` → `cap.llm.title` run)|
|Direct capability calls recorded (N6)|**merged #18**|One-step `cap.<id>` runs behind the unchanged HTTP/CLI contract, `agw-run-id` header, keyed calls survive a disconnect, unkeyed ones cancel, typed errors journaled as `CODE: message` + one JSON line, refusals 503, opaque 500 otherwise, one `startRun` for workflow and capability routes, cap workflows built once in boot. Reviews: lead `/code-review high` r1 (9 findings → fixed), gateway deep r1 (no blockers; adversary failed on balance), r3 improvements taken. Train: 577 pass|
|Eval sets (Haiku)|**merged #16**|`packages/eval/src/extract/agent-gateway.ts`; cases in `~/.local/share/agent-workflows/eval/{review,check}/cases.jsonl` (0600, never in git): **138 review** (corpus 103 + jobs-db 35; outcomes clean 4 / actionable 110 / needs-human 24; cost exact 1, approx 33, null 104 — the sessions log starts 2026-10-19 14:58Z, after the corpus window; legacy total $11.24), **7 check** (base inferred, no patch). Skipped: pr-ref-missing 48 (refs not local; not fetched), uncommitted 19, repo-unverified 7, branch-scope 6, empty-diff 3, repo-unmapped 3. Lead read caught refs resolved against today instead of the job's time (fixed: time-travel per ref, tested). Gateway standard: one blocker (malformed corpus line crashes) fixed by the lead (worker pane wedged behind the "compact earlier" modal; `herdr pane send-keys` esc/enter did not clear it)|
|review + check ported (Sonnet/high)|**check merged #17; review #20 in round 3**|Check: make check path without LLM, idle watchdog, process-group kill + orphan reap across crashes, env credential scrub (legacy parity), read-only DISCOVER, `run-step` watchdog on the agent path, step name `z.string()` (legacy). Reviews: lead r1 (10), gateway r1 (2 blockers) → fixed. Review #20: router/adversary capabilities, depth gating, angles with `allowDirectories` (OpenCode `external_directory` allow `<dir>/*`; live: inside readable, outside refused, **a symlink inside the dir is followed out** — pinned as a live test, documented accepted risk for the live cwd; symlinks escaping a pr/branch clone are deleted), OCR child behind the wallet gate, synthesis salvage, verdict in code. Reviews: lead r1 (10 → fixed), gateway deep r1 (no blockers), lead r2 (10 more → sent as round 3 at ~09:20: path-scope false clean, synthesis-prompt injection, GIT_*/ssh env, subdirectory cwd, mapLimit stop, ocr kill tree, clone cleanup on throw, salvage failed list, capDiff). Worker `agent-workflows-review-workflow` at ~81 % context (autocompact at 600k carries it)|
|Comparison harness (Opus/medium)|**merged #19**|`bun packages/eval/src/harness/cli.ts review|check [--ids] [--limit] [--rerun-legacy] [--judge] [--dry-run] [--resume]`; reports in `<evalDir>/reports/<ts>/` with an aggregate-only `report.md` section safe for this repo. Verdict: not-worse / worse / inconclusive (errors count as misses, ≥10 paired ratios, check failure recall, legacy reruns serial). Reviews: lead r1 (10 → fixed), gateway r1 + light r2 (blockers fixed)|
|Side-by-side|**not run**|Needs #20 merged and redeployed. IU is usable again: DeepSeek answered a real completion at 09:10 (balance back); Athena key available (below)|
|Skill switch + MCP tools removed|**not started**|After the side-by-side says not-worse|

## Owner direction 2026-10-28 ~09:00 (from the mother) and what was done

1. Gateway `/review` stopped for this fleet; the lead's `/code-review high` on Max **is** the review step. Done from ~09:05.
2. Athena teamchat team key for interim tests/evals: staged by owner dialog `20261028T091315-27365` into the untracked
   `~/.config/agw/athena-iu.env` (`IU_API_KEY=…`, 0600) on the mini; probed: Haiku 200, Terra 200. Never reference it in
   tracked files. Anything about that key goes only to `athena-mother` (pane `wJ:p3G`) via `rd say`; this lead sent nothing there or elsewhere.
3. Per-route fallback to GPT-6.1 Terra (medium) + review degrade on balance: **brief written, not fanned**:
   `~/.local/state/agent-workflows/briefs/w4/route-fallback.md` (Opus/medium; facts baked in: `gpt-6.1-terra` listed in
   IU `/models`, chat.completions + `reasoning_effort=medium` → 200; `/research` of developers.openai.com: $1.00 / $0.05
   cached / $5.00 per 1M, >272K input 2x/1.5x, 1.05M context, 128K output, effort default medium, tools need the
   Responses API). It also carries item 6: `HostWorkflow.internal` so review's OCR child stops being the public `agw ocr`
   (renamed `review.ocr`). Fan it **after #20 merges** (it owns review files): `RD_WAVE_MODEL=opus RD_WAVE_EFFORT=medium rd fan agent-workflows <brief>`.
4. dotfiles `/review` skill degrades to in-session `/code-review` on a 402/503-balance failure: dotfiles **#37 merged**
   (lead read is its review; rebase merge with the not-ours-rows comment).

## Next lead, in order

1. Wait for `agent-workflows-review-workflow` (round 3), read the fix diff, `/code-review high` r3 (fork, on its
   worktree, never a checkout in the main checkout), `rd merge agent-workflows w4/review-workflow`.
2. Fan `route-fallback.md`; review and merge it.
3. `make deploy && make verify`; `@verifier` for the `cap.llm.title` run and an `agw review` on a small diff.
4. Side-by-side: `--dry-run` first (cost estimate), then review on the 138 cases (concurrency 2, `--rerun-legacy` on a
   subset for the noise floor) and check on the 7; aggregate numbers into the close-out. Write it as blocked, not faked,
   if a provider fails.
5. Skill switch and agw MCP `check`/`review` removal only on a not-worse verdict.

## Left behind / notes

- Merge train flakes at load ~250: 10 timing failures on #18's first train run, all green on re-run (load 12). The
  retry test `a 503 that wraps an upstream invalid_request_error` passed 3/3 alone.
- `rd say` does not clear the "We recommend compacting earlier" modal; `herdr pane send-keys <pane> esc|enter` did not
  either on the Haiku pane (`w40:pW`). Report to dotfiles (`rd say` modal list).
- Worktrees to reclaim after #20: `rd fan --clean agent-workflows` and `rd fan --clean dotfiles`.
- Not ours (unchanged): dotfiles architecture-check rows; agent-gateway `dispatch-worktree.test.ts` credential helper.

## make check

Master after #18 via the train: 577 pass, 0 fail (`==> check passed`). Lead prep commit `996e508`: 446 pass.

## IU spend (this lead)

Gateway reviews of this wave's PRs: $11.04 in angle/synthesis sessions over 6 jobs (deep runs ~500 turns each), router
rows not summed (adversary failed every time on balance). `/research` $0.025. Live probes < $0.01 (OpenCode permission
test ~$0.002, Terra/Haiku/DeepSeek one-liners). Eval runs: none yet.

## Retro notes

- A contract commit by the lead before the fan (agent loader, per-workflow module slots, eval case schema) let five
  workers build in parallel with no file overlap; the only cross-worker contract (`allowDirectories`) lived in two briefs and held.
- Lead reads on Max again found what tests and gateway reviews did not: eval diffs resolved against today's refs, a
  credential-carrying env in check and review helpers, a false-clean path scope, symlink escape. Every port needs a
  "what did legacy scrub/guard" pass in the brief.
- The owner-gated item cost a night, then a wrong command: `op` reads a piped stdin as a template. Every `op` in an
  ask-human command gets `</dev/null`.
- Deep gateway reviews cost ~$2 each and ran 15–20 min under load; with the cross-family critic dead they added little
  beyond the Max review. The owner's switch to Max-only review matches the evidence.
