# Lead handoff — Wave 10 (Claude Code and Hermes slimmed; P5): ROTATION at ~58% context

Lead `agent-workflows-w1` rotates out 2026-10-29 ~20:20. Wave 9 close-out is in git at `06f0af1`. Briefs, review fix lists
and the Hermes live patch: `~/.local/state/agent-workflows/briefs/w10/` on the mini (not in git; `_common.md` = Wave 9 rules
+ Wave 10 scope: Wave 11 owns the retirements, polled reads never journal).

## Live state

agent-workflows release `13b79da` (host + audio), `make verify` PASS. agent-gateway `084fefc` (MCP server deleted, Argo push
removed; reloaded, its verify OK). hermes-agent `e5cba18` deployed (`make deploy` verified). dotfiles `be3b987`. modelpick
`bf8aa4f`+3 refresh commits pushed. Main checkout clean.

## Per-step verdict so far

|Step|Verdict|Evidence|
|-|-|-|
|Global CLAUDE.md, skills, Makefile MCP registration; agw MCP server deleted|**done, live** — and an owner direction pending (below)|dotfiles #44 (Async jobs → one paragraph, model-ids line, skills on `/check` `/review` `agw-legacy`, Makefile registration removed + per-account `claude mcp remove`, OpenCode mini MCP config deleted, dead `agent-gateway:review` lane, `com.jkrumm.agent-workflows-audio` mapped). Deregistered on the mini: `claude mcp list` shows 0 agent-gateway entries in all three accounts. agent-gateway #39: `server/mcp.ts` + `server/mcp/tools/**` + MCP-only libs deleted (−2,469 lines), job server builds, reloaded, verify OK|
|Hermes scripts and skills on agw; narratives and overview ported|**done, live**|agent-workflows #65 (`narrative`, `prose-polish`, capabilities `prose.write`/`narrative.compose`, new `internal` capability option: not on HTTP/OpenAPI/CLI/tool gate) and #66 (`agw overview` run, unjournaled `agw agents`/`quota`/`quota-report`, Argo push from the host, prod-purpose only), #64 `agw routes`. hermes-agent #10 (skills: `agw-research`, hyperdx on `agw hdx`/`agw otel`, dispatch skill on the CLI, warden leftovers) and #11 (scripts via `scripts/agw_run.py`: narratives, agents-overview, prose, quota-nudge; cron prompt text); out-of-git patch applied to `~/.hermes/cron/jobs.json` and `~/.hermes/skills/fleet-status/**` (backups `/tmp/w10-jobs.json.bak`, `/tmp/w10-fleet-status.bak`). @verifier 8/8 PASS on `13b79da`: routes; agents/quota reads write no journal rows (runs 3476 = 3476); quota-report bounds (150 → exit 2); overview run `01a18901-b37d-…` $0.0043, journal holds ids + facts hash + verdicts only; host log `argo push ok` 201, 26 agents; prose-polish `01a18903-5757-…` $0.0438 (write on Opus); narrative `01a18903-b9c9-…` $0.0049; `/prose/write`, `/narrative/compose`, `/overview/classify` 404|
|No-MCP-gateway sweep|**done in tracked docs; final proof run pending**|Fixed beyond the fleet repos: brain wiki `remote-dev-orchestration.md` (pushed), email-gateway PLAN (pushed), basalt-ui handoff (**PR #565 open, CI pending — merge it**), weatherorb stale permission (untracked). Remaining hits are history docs only (modelpick decision record, dotfiles archive/factory docs)|
|Every remaining runtime caller moved|**done except Wave 11 items**|statusline + fetch_usage → `agw quota-report` (64 ms, throttled 1/min, backgrounded; dotfiles #45), devhost-health overview/usage probes, `make agent-overview` pane on `agw agents --text --format plain` (pane restarted, renders), modelpick verify on `agw routes` (#2; `tts-wave5.ts` deleted: finished experiment), warden repo archived on GitHub (its client goes with it), `wave-watch.sh` warden call dropped. iris: verified, no agent-gateway call since 12:40 (two `triage` jobs before its switch)|

## In flight (the next lead finishes these)

1. **Owner direction (2026-10-29, via mother):** no dispatch; agent-gateway retires COMPLETELY in Wave 11, `agw-legacy`
   included. Worker `dotfiles-no-dispatch-lane` (branch `w10/no-dispatch-lane`, brief `briefs/w10/dotfiles-nodispatch.md`):
   global CLAUDE.md lanes become `@implementer`, `rd wave`/`rd fan`, in-session tools; skills/docs lose `agw-legacy`. Read the
   diff, `/code-review` not needed for docs (lead read), merge with `gh pr merge --rebase` (dotfiles train is red only on the
   not-ours `com.iu.*` architecture rows; record that reason), close its tab at once.
2. **Owner direction:** worker `dotfiles-herdr-reap-merged` (branch `w10/herdr-reap-merged`, brief `briefs/w10/herdr-reap.md`):
   `scripts/herdr-reap.py` closes a fan tab once its branch is merged (gh PR state, rebase merges) or deleted, even during an
   active wave; never working/dirty/mother/lead tabs. Review on Max (`/code-review high`, detached worktree), merge, close tab.
3. **Owner direction (tab hygiene):** close every fan tab right after its merge or abandonment (`herdr tab close <tab_id>`,
   ids from `herdr agent list`), not at wave end. Done for all merged Wave 10 tabs at 20:10.
4. basalt-ui PR #565 (one doc line): merge when CI is green.
5. Then the close-out: final sweep proof (`rg -n 'mcp__agent-gateway|mcp__research-gateway|job_wait'` over every repo's skills,
   AGENTS.md, config, scripts — history docs excluded and named), Hermes live proof (tomorrow's 06:30 narratives cron leaves an
   `agw.runs` row with caller `hermes`; or run `narratives-cron.py` once), overwrite this file with the full close-out.

## Reviews (all on Max, detached worktrees, no fork touched the main checkout)

- #64 routes: r1 blocker (both processes declared `routes`: CLI conflict on the mini), env injection, prices; r2 table built
  once from a boot snapshot, CLI-level two-process test; r3 diff read.
- #65 narrative: r1 security (Opus seat reachable over HTTP → `internal` capabilities), clamp, child error/cancel, bounds; r2
  internal seat still grantable via the tool gate → one `served` list, `git log -n`, stable reason (no home path); r3 one bug
  (`Date.parse` rollover) fixed and read.
- #66 overview: r1 security (host secrets in git/herdr child env, unvalidated session id in a path, terminal escapes, sync fs
  on the runtime loop, journal holding transcripts and queued commands); r2 git env too narrow, purpose gate on the cache,
  C1/CR stripping, shape checks, pool, lean journal; r3 session-less panes, raw keys/paths; final rebase read. Worker rotated
  at 78% (`overview-r2` continued the PR).
- Lead diff reads only (with reason): dotfiles #44/#45, agent-gateway #39/#40, hermes-agent #10/#11, modelpick #2, the doc
  one-liners (docs, deletions, scripts with a live proof).

## Gate

agent-workflows: train `make check` + CI green on #64, #65, #66 (each needed a retry: load flakes named below). CI on master
green. dotfiles #44/#45, agent-gateway #39/#40: merged with `gh` — dotfiles' `make check` fails only on the not-ours `com.iu.*`
architecture rows; agent-gateway's suite only on the known not-ours `GIT_DENY_CREDENTIALS_ENV` test; workers ran every other
target green. hermes-agent and modelpick: train green (no CI configured).

## Spend

IU team key: verifier runs $0.053; workers' route probes and live criteria (one research quick run $0.0053, hdx reads, one
overview/narrative/prose-polish each) < $0.15 est. Max: lead, 13 workers, 9 `/code-review high`.

## Left behind (for the close-out)

- Load flakes seen in the train (not ours to this wave, fix at cause later): `opencode-host/test/friction.test.ts` "re-attached
  wait … does not repeat a note" (`settle()` waits on poll counts, not on the nudge); `middleware/test/platform.test.ts`
  concurrent runs (spans dropped / tool events empty, also on GitHub CI once); `review` pr-mode clone test (11.7 s timeout);
  capabilities stream-idle 150 ms test.
- `quota-nudge.py:290` references undefined `RECENT_WORK_S` (pre-existing; NameError on a stalled non-allowlisted pane).
- Morning briefing prompt (disabled cron) still calls retired warden's `:7735/board`.
- `prose.py --timeout 900` kept for parity (conflicts with agent-limits rule).
- Narrative pages keep `generated_by: agent-gateway/narrative` frontmatter (existing vault pages carry it).
- `internal` capability option is new: concept.md needs a version note (mother).
- modelpick verify now shows real drift in its own rows (old `-eu` ids, Terra 5.6 → 6.1): a `/refresh-stack` decision.
- modelpick's refresh pushes had been failing on a diverged checkout; rebased (STACK.md: refresh version kept) and pushed.
- hermes-agent: `scripts/model-release-watch.py` is a live cron script, untracked (not ours).
- Wave 11 (owner: nothing stays on agent-gateway): Hermes `dispatch` skill and `brain-drift-audit` cron use `agw-legacy
  dispatch`; dotfiles Makefile `install-cli`, `wave-watch.sh` 7705 poll, Caddy `agent-gateway.test`, Kuma push, devhost probes.
