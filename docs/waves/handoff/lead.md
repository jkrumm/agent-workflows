# Lead handoff — Wave 10 (Claude Code and Hermes slimmed; P5): CLOSE-OUT

Second Wave 10 lead (took over from `agent-workflows-w1` at ~20:20), closed 2026-10-29 ~21:00. Briefs, review fix lists
and the Hermes live patch: `~/.local/state/agent-workflows/briefs/w10/` on the mini (not in git).

## Live state

agent-workflows release `0ac0fc8` (host + audio; docs-only commits on top of the code at `13b79da`), `make verify` PASS
(smoke `01a1891b-1afe-728b-…`, cap `01a1891b-24be-761b-…`, audio `01a1891b-2c36-71a7-…`). agent-gateway `084fefc` (MCP server
deleted, Argo push removed). hermes-agent `e5cba18` deployed. dotfiles `d5562f0` (global CLAUDE.md and herdr-reap live from
the checkout). modelpick `bf8aa4f`+refresh commits. basalt-ui `74b1ac9`. Main checkout clean, no worker tabs open.

## Per-step verdict

|Step|Verdict|Evidence|
|-|-|-|
|Global CLAUDE.md, skills, Makefile MCP registration; agw MCP server deleted|**done, live**|dotfiles #44, #46 (`ec11197`: no dispatch lane; lanes are `@implementer` and `rd wave`/`rd fan`; `agw-legacy` gone from global CLAUDE.md, `docs/agent-platform.md`, `docs/global-reference.md`, AGENTS.md, skills `implement`/`wave`/`remote-dev`). agent-gateway #39 (MCP server, tools and MCP-only libs deleted). @verifier: `~/.claude/CLAUDE.md` = dotfiles `origin/master` byte for byte, no `agw-legacy`/`dispatch`; `mcpServers` in every Claude config dir hold no gateway (chrome-devtools; PandaOS's own `pandactions`/`pandaos-browser` in two project scopes, not ours); `:7705/mcp` 404 with `/health` 200|
|Hermes scripts and skills on agw; narratives and overview ported|**done, live**|agent-workflows #65, #66, #64; hermes-agent #10, #11; `~/.hermes` cron/skills patch. Previous lead's @verifier 8/8 on `13b79da` (routes, unjournaled reads, quota-report bounds, overview, prose-polish, narrative, internal capabilities 404 over HTTP). This rotation's @verifier: 20 `agw.runs` rows with caller `hermes` in 24 h (research, hdx, narrative, narrative-polish, prose-polish; all `done`); Hermes scheduler ran `quota-nudge.py` on agw at 20:08 `ok`; `narratives-cron.py` loads `project-narratives.py`, which calls `agw` through `scripts/agw_run.py`; no gateway URL in `~/.hermes/scripts`|
|No-MCP-gateway sweep|**done**|@verifier rg (`mcp__agent-gateway|mcp__research-gateway|mcp__audio-gateway|job_wait`) over every repo's skills, AGENTS.md, config, scripts, `~/.claude/{skills,agents}`, `~/.config/opencode/agent`, `~/.hermes/{skills,scripts,cron}`: no live hit. Fixed this rotation: `~/.config/opencode/agent/implementer.md` was rendered before dotfiles moved `/research` to agw (said `job_wait`); re-rendered with `scripts/opencode-agents.py`. basalt-ui #565 merged (CI green; it also carried the owner's unpushed friction-log commit `f409b81` from 2026-10-27). Remaining hits are history or not ours: email-gateway's own `job_wait` comment, jkrumm.com diagram label, brain wiki/Inbox narrative pages, modelpick decision record, `brain/.scripts/extract-research-result.py` (a research-gateway result helper, no caller; goes with Wave 11)|
|Tab hygiene: tabs closed after merge; `herdr-reap.py` closes merged fan tabs during an active wave; dispatch lane dropped|**done, live**|dotfiles #46 (dispatch lane) and #47 (`d5562f0`). #47: a tab closes once its `rd-fan`-marked worktree's branch is merged into the default (PR MERGED with base = default and HEAD inside the PR head, or own commits all patch-equal and pushed) or deleted on origin, active wave or not; never a working/unknown agent, dirty/unpushed/fresh tree, a new pane, moved HEAD, or a mother/lead/`wave <n>`/`-w<n>` tab (re-checked from a fresh roster right before the close). 37 tests green; dry run on the mini: would close only iris's merged `fan w16-s5-host-caller`, kept a dirty fan tab and a live branch. Live: the 20:43:50 launchd tick closed exactly that tab (`why="PR merged"`) during iris's active wave. Worker tabs `dotfiles-no-dispatch-lane`, `dotfiles-herdr-reap-merged` and the stray workspace tab closed right after their merges; `rd fan --clean dotfiles`: no extra worktrees|
|Every runtime caller of the old gateways moved|**done except Wave 11 items (owner: everything agent-gateway retires in Wave 11)**|Previous lead: statusline/fetch_usage → `agw quota-report`, devhost overview/usage probes, `make agent-overview` on `agw agents`, modelpick verify on `agw routes`, warden archived, `wave-watch.sh` warden call dropped, iris on agw (no gateway call since 12:40). Gateway logs this rotation: research-gateway sees only the devhost health probe (404 triplets on `/health*`), no functional caller. Remaining, all Wave 11: Hermes `dispatch` skill and `brain-drift-audit` cron prompt (`agw-legacy dispatch`), hermes-agent `make doctor` `:7705` probe, dotfiles Makefile `install-cli` (agw-legacy), `wave-watch.sh` `:7705/api/jobs` poll, `remote-dev.sh:1096` hint text, Caddy `agent-gateway.test`, devhost probes for agent-/audio-/research-gateway, Kuma push, modelpick's agent-gateway rows via `agw-legacy routing`, argo `/ai` audio proxy|

## Reviews (all on Max, detached worktrees; no fork touched a main checkout)

- dotfiles #46: docs only, lead read the full diff (lane table, agent-platform, global-reference, three skills). Review: lead
  diff read only — docs, no code.
- dotfiles #47: `/code-review high` r1 on `f24fa1e`: 10 findings (stale PR by branch name closed a fresh worker; closed PR
  with a live branch; ownership by path, not the `rd-fan` marker; label-side lead guard; no status re-check before close; no
  network timeouts; `fetch.prune` config; merge commits invisible to `git cherry`; `unknown` agents not protecting a shared
  checkout; tests missing). All fixed in `1d15315`. r2: 10 findings, lead triage: 6 fixed in `bcccacf` (fresh pushed branch;
  stacked-PR base; close-time re-check of pane set, other agents, dirty tree, moved HEAD; local checks before network and a
  failed fetch cached; keep reason logged; file handles). Declined with reason: CLOSED PR + branch deleted closes (that is
  abandonment, the owner's intent); the name-suffix guard stays a backstop (the marker is ownership); no dedupe with
  `checkout_problem`; test suite speed (~75 s) not tuned. Lead read both fix diffs.
- Previous lead's reviews (#64, #65, #66 three rounds each; lead diff reads for dotfiles #44/#45, agent-gateway #39/#40,
  hermes-agent #10/#11, modelpick #2): unchanged, in git history of this file (`7058b35`).

## Gate

agent-workflows: `make check` + CI green on #64, #65, #66 (load-flake retries, named below); CI on master green at `13b79da`,
docs-only commits since. dotfiles #47: every `make check` target green on the PR head except `architecture-check`, which
fails only on the not-ours rows (`com.iu.athena-postgres` unmapped, four `com.iu.teamchat-*` mapped-but-absent); the rest run
with `make -k` (37 herdr-reap tests, all suites OK). dotfiles #46 docs only. basalt-ui #565 CI green. agent-gateway's suite
red only on the known not-ours `GIT_DENY_CREDENTIALS_ENV` test. hermes-agent and modelpick: train green (no CI).

## Live proof

`make verify` PASS on `0ac0fc8` (redeployed this rotation: the docs-only commits had left the deployed sha behind master,
which `make verify` refuses). @verifier checks 2–6 PASS (above). herdr-reap: the first launchd tick after the merge
(20:43:50) closed iris's merged fan tab `w4V:t23` and nothing else. Not yet observable: the 06:30 narratives cron on the new path (`narratives-cron.py`, next run 2026-10-30
06:30); the script path itself is proven by the `hermes` narrative/narrative-polish runs at 18:58.

## Spend

IU team key: previous lead's verifier $0.053 + workers' probes < $0.15 est.; this rotation `make verify` ×1 (< $0.0001) and
the redeploy. Max: lead (two rotations), 15 workers, 11 `/code-review high`, 2 @verifier.

## Left behind

- Load flakes (not ours to this wave): `opencode-host/test/friction.test.ts` re-attached wait note; `middleware/test/
  platform.test.ts` concurrent runs; `review` pr-mode clone test timeout; capabilities stream-idle 150 ms test.
- `quota-nudge.py:290` undefined `RECENT_WORK_S` (pre-existing NameError on a stalled non-allowlisted pane).
- Morning briefing prompt (disabled cron) still calls retired warden's `:7735/board`.
- `prose.py --timeout 900` kept for parity (conflicts with the agent-limits rule).
- Narrative pages keep `generated_by: agent-gateway/narrative` frontmatter.
- modelpick verify shows real drift in its own rows (old `-eu` ids, Terra 5.6 → 6.1): a `/refresh-stack` decision.
- hermes-agent `scripts/model-release-watch.py`: live cron script, untracked (not ours).
- `rd reap --help` in `scripts/remote-dev.sh` still describes only the idle rule.
- herdr-reap test suite takes ~75 s inside dotfiles `make check`.
- devhost-health research-gateway probe gets 404s on `/health*` (goes with the retirement).
- Wave 11 caller list: the last row of the step table.

## Retro notes

- **Previous lead:** verify before building held again (Argo, iris needed no port); the security reviews changed designs
  (`internal` capabilities, host env leaks), not just diffs; rotation at 58 % with a written handoff was clean.
- **This rotation:** a script that decides to kill a tab needs two review rounds: r1 found that a PR looked up by branch name
  outlives the branch, r2 that every guard must be re-read at close time, not plan time. A dry run on the live fleet is the
  cheap last gate (it found exactly one, correct, close). A rendered config (OpenCode agents) drifts from its source
  silently: the sweep must include render targets, not only repos. `make verify` refuses docs-only drift, so a docs commit
  after a deploy needs a redeploy before the close-out proof.
