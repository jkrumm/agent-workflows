# Lead handoff — Wave 3 (CLI, agent host, deploy; P1b) — ROTATION, wave in flight

Lead `agent-workflows-w1` (pane w40:pG), 2026-10-28 00:45 → ~02:10. Rotated past ~60% context. Wave 3 is **not**
done: one step landed (rename + sweep), five PRs are in review rounds, the deploy step is briefed but not spawned,
and the deploy is blocked on a 1Password item only the owner can create. The Wave 2 close-out this file replaced is
in git history at `5cc78aa`.

## State per step

|Step|State|Evidence / next action|
|-|-|-|
|`agw` CLI generator (Opus/medium)|**round 2 fixing**|PR #12, worker `agent-workflows-cli` (w40:pK), branch `w3/cli` @ `3cd6d4e` before round 2. Reviews: gateway deep (r1, actionable: `--commit=false`), lead `/code-review high` (r1, 10 findings incl. a 30 s hard abort on capability calls), gateway standard (r2, actionable: 4×-encoded dot segment, reserved-name collision dropped silently). Round 2 sent 02:05 (also: refuse cleartext non-loopback `AGW_URL`, deref `$ref` parameters). Next: read the round-2 diff, gateway re-review (standard), merge **first** (no runtime overlap)|
|OpenCode host (Opus/medium)|**round 2 reviewing**|PR #14, worker `agent-workflows-opencode-host` (w40:pJ, 61% context), `w3/opencode-host` @ `a3dd2e6`. R1: gateway deep (needs-human → decided by lead, see Decisions) + lead `/code-review high` (WarmCache races, false "unprompted", orphan sessions, shell exposure, steer dedupe), 14 items fixed; live re-attach test passes (kill at 4.2 s, one prompt, one resume note, $0.00067). Duplicate runtime commit dropped (host branch carries it). **Gateway deep r2 job `57989ed6-04ee-464c-b903-76ad7bc1759b`**: `job_wait` it. Merge **after #13** (rebase; it also touches `packages/routes` rates). The worker is near its own rotation: if round 3 is large, brief a fresh Opus worker on the branch instead|
|Host process (Sonnet/high)|**round 2 reviewing**|PR #13, worker `agent-workflows-host` (w40:pM), `w3/host` @ `c1b9f35`. R1: gateway deep (blocking: `withJsonBody` dropped real bodies) + lead `/code-review high` (boot leaked leases on a late start failure, no shutdown backstop, whitespace secrets, …), all fixed; plus `Runtime.getRun`/`ping` (host has no SQL now), reserved CLI names refused, `llm.summarize` `format` → `style`, `AgentHost.steer(…, { signalId })` passed by the runtime. New: authenticated routes answer 503 `SERVICE_UNAVAILABLE` while the runtime is not open (add to the contract's code list; CLI maps 5xx → exit 1). **Gateway deep r2 job `0862c443-5049-4921-b363-095ca3bfdeed`**: `job_wait` it. Merge second|
|agent-gateway CLI → `agw-legacy` + caller sweep (Sonnet/high)|**done**|agent-gateway `64e7b44` (one commit, PR #36, gateway light: clean). `make install-cli` run: `~/.local/bin/agw-legacy` → `bin/agw-legacy.ts`, `~/.local/bin/agw` removed (nothing resolves `agw` until the deploy installs the new one). Sweep merged: dotfiles #36 (`999e2a1`, global CLAUDE.md lanes now `agw-legacy dispatch`/`routing`, skills `implement`/`remote-dev`/`prose`/`wave`, docs), hermes-agent #9, modelpick #1 (+ STACK.md re-render), jkrumm.com #1, brain #1. Worker closed, worktrees removed|
|LaunchAgents, `make deploy|verify`, Kuma, map (Sonnet/high)|**briefed, not spawned**|Brief: `~/.local/state/agent-workflows/wave3-briefs/deploy.md` on the mini (all Wave 3 briefs, the contract and the fix rounds are in that directory). Spawn after #12, #13, #14 merge: `RD_WAVE_MODEL=sonnet RD_WAVE_EFFORT=high rd fan agent-workflows ~/.local/state/agent-workflows/wave3-briefs/deploy.md`. dotfiles PR #34 (`w3/agent-workflows-host-map` @ `f7e4752`, worker `dotfiles-agent-workflows-host` w59:p2, gateway: placeholder result then light: clean, improvements taken) maps the LaunchAgent, adds the heartbeat probe (`/health`, code + status) and the herdr group: **merge it only after the deploy** (its LAUNCHD_KEEPALIVE row turns `make doctor` red while the plist is absent). Merge by `gh pr merge --rebase` with a comment: dotfiles' train is red on the not-ours architecture rows|
|Telemetry and usage live|**blocked on the owner**|1Password request `20261028T005518-15306` queued in `~/.local/state/human-queue/` (MacBook unreachable all night: `ssh iumac` times out). It creates `op://mini/agent-workflows/{API_SECRET,ARGO_URL,OTEL_EXPORTER_OTLP_ENDPOINT}` idempotently. Retry: `~/SourceRoot/dotfiles/scripts/ask-human.sh push 20261028T005518-15306`. **Only after it reports the fields**: add the three refs to `dotfiles-private/headless.refs`, commit, push, then `ask-human.sh ask 'reseal the secrets cache' --cmd 'cd ~/SourceRoot/dotfiles-private && git pull --ff-only && cd ~/SourceRoot/dotfiles && make secrets-seed' --wait`. Receiver decision: the VPS authed OTLP tier (as research-gateway does, auth `op://vps/argo/HYPERDX_API_KEY_PROD`, already in headless.refs), not local ClickStack|
|One trivial workflow end to end|**built, not proven**|`smoke.ping` (code step → `llm.title`, priced usage) is in PR #13. `@verifier` after deploy: run record in `agw.runs`, spans in ClickStack (VPS), usage row in Argo, the CLI end to end (`AGW_CONFORMANCE_URL` live cases of the CLI suite)|
|Fleet tooling: `rd say` verifies delivery (Sonnet/high)|**round 2 fixing**|dotfiles PR #35, worker `dotfiles-rd-say-verify` (w59:p1), `w3/rd-say-verify` @ `9eda18c`. R1 gateway: fast `blocked`/`done` counted as lost → fixed with a state/seq snapshot primitive `prompt_attempt` shared with `deliver_prompt` (also used by `rd fan`/`rd wave`: read every round's diff). R2 gateway: 4 seam bugs (cross-try "nothing was sent", unreadable-state re-send, trailing-newline loss, queued-after-modal reported delivered) sent 02:05; its 5th finding ("agw-legacy does not exist") is false (stale tree). After merge: prove it live with `rd say` to an idle worker|

## Decisions taken (by evidence, concept §0)

- **Host↔CLI HTTP contract v1** fixed up front so CLI and host built in parallel: `~/.local/state/agent-workflows/wave3-briefs/contract.md` (also inlined in both PR descriptions' briefs). Port 7791, loopback, bearer for everything but `/health`, `x-agw-contract` sha → 412, run state 200/202, `Prefer: wait` ≤ 240 s (Bun idleTimeout ceiling 255 s), exit codes 0–10 as spike 7.
- **Reserved CLI globals** (`--format`, `--commit`, `--idempotency-key`, `--help`) always win; the host refuses colliding input names; `llm.summarize` `format` → `style`.
- **Shared OpenCode server credential** (gateway needs-human on #14): not an owner stop. agent-gateway's shared server holds the IU key and password in env today (`scripts/opencode-server-env.ts` header), so it is the status quo, kept as an accepted risk and documented in concept §8 (v3.2 note); mitigations: shell denied unless an agent opts in, dedicated server HOME, real binary by absolute path, `OPENCODE_DISABLE_CLAUDE_CODE=1`.
- **Deploy clone**, not the main checkout (research-gateway's lesson: a dirty dev tree must never go live): `~/.agent-workflows/app`.
- **OpenCode routes get explicit rates** in `packages/routes` (no cross-route borrowing); OpenCode's cost 0 with tokens > 0 means "no cost", then rate, else unknown.
- **prometheus-epx** (IU work GitLab, active fleet there): the sweep worker pushed `w3/agw-legacy-sweep` with 4 comment-only `agw routing` mentions and no EP-XX prefix; the lead deleted the remote branch and the worktree (no MR existed). Left for that repo's owner.

## Review verdicts so far

|PR|Reviews|Outcome|
|-|-|-|
|agw #12 CLI|gateway deep r1, lead `/code-review high` r1, gateway standard r2|r1 actionable → fixed; r2 actionable (2 blocking) → fixing|
|agw #13 host|gateway deep r1, lead `/code-review high` r1, gateway deep r2 (running)|r1 actionable → fixed|
|agw #14 OpenCode host|gateway deep r1 (needs-human → lead decision), lead `/code-review high` r1, gateway deep r2 (running)|r1 → 14 items fixed|
|agent-gateway #36|gateway light|clean; merged outside the train: its `make check` fails only `dispatch-worktree.test.ts` "removes the ambient credential helper", identically on master (the mini's system git config supplies `credential.helper osxkeychain`)|
|dotfiles #34|gateway standard (degenerate "placeholder" synthesis), gateway light|clean; 2 improvements taken|
|dotfiles #35|gateway standard r1, r2|r1 blocking fixed; r2 4 blocking → fixing|
|dotfiles #36, hermes-agent #9, modelpick #1, jkrumm.com #1, brain #1|lead read (mechanical renames, ≤ 25 lines each)|merged; dotfiles/modelpick/brain outside the train with the reason on each PR (dotfiles: not-ours architecture rows; modelpick: `scripts/tts-wave5.ts` imports `../../audio-gateway`, unresolvable from a worktree, tests 774/774; brain: no `check` target)|

## Left behind (for the next lead; the wave's final close-out overwrites this file)

1. Merge order: #12 → #13 → #14 (rebase), then spawn deploy, then the owner's 1Password item → headless.refs → reseal → `make deploy` → `@verifier` → merge dotfiles #34 → close workers → `rd fan --clean agent-workflows` and `dotfiles`.
2. **Gap, not in this wave's scope:** a capability called directly over HTTP (`agw llm title`, not inside a run) is billed but never recorded in the journal or Argo (host README "Known gaps"). N6 says the platform is the system of record: route direct capability calls through a one-step run, or record their usage, before Wave 4 makes them common.
3. agent-gateway: `dispatch-worktree.test.ts` fails on the mini because a session's git still sees the system `credential.helper osxkeychain`; that is a credential-isolation gap in `dispatch`, frozen repo, not ours. Report to the owner.
4. modelpick main checkout is `ahead 1, behind 2` with an unpushed local commit (`6d7c624`, not ours): its live `scripts/verify-deployments.ts` still calls `agw` until someone rebases it.
5. `~/.hermes` was not edited (only `cron/output` hits); hermes-agent's `skills/dispatch/SKILL.md` is merged — confirm `~/.hermes/skills` picks it up on its next sync.
6. agent-gateway's install-cli removes the old link only when the target path contains `/agent-gateway/bin/agw.ts` (gateway improvement, not taken: the link is gone already).
7. Gateway reviews under load: 4 concurrent deep/standard reviews took 14–17 min each; one synthesis returned a literal "placeholder" (re-run fixed it).
8. `wave-watch.sh --agents` reported a `done` worker 10–20 min late twice; `rd read` the workers when a review returns rather than trusting the watcher alone.

## make check

Not run on master this wave yet (nothing of ours merged into agent-workflows). Workers' own runs: CLI 293 pass; host 300 pass / 5 skip; OpenCode host 302 pass / 6 skip.

## Live verification

None yet (deploy blocked, see above).

## IU spend (purpose=build), so far

Reviews only, from the gateway (no `purpose` tag on legacy jobs): 14 review jobs (deep ×5, standard ×5, light ×3, one degenerate), plus the OpenCode live tests ($0.00045 + $0.00067). Reconstruct the figure from usage-tracker `usage.db` agent-gateway review rows 2026-10-28 00:50Z–02:15Z at close-out.

## Retro notes so far

- Fixing the cross-package HTTP contract in the briefs let CLI and host build in parallel without one round of drift; the only mismatch (reserved flag names) was a contract gap, found by review, and fixed on both sides.
- Lead `/code-review high` again found what the workers' own gateway reviews did not: a 30 s client abort on synchronous LLM calls, leases held through a late start failure, WarmCache races.
- A caller sweep across many repos needs an explicit "no work remotes" rule: the worker pushed to an IU GitLab repo with an active fleet.
- The secrets path is the critical path for a deploy: the 1Password item should be created at the start of the wave while the owner is awake.
