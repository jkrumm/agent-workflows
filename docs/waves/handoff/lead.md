# Lead close-out — Wave 3 (CLI, agent host, deploy; P1b)

Leads: `agent-workflows-w1` 2026-10-28 00:45 → ~02:10 (rotated), then the rotation lead 02:14 → ~05:05. Everything
of the wave is merged and reviewed; **the deploy is blocked only on the owner's 1Password item** (MacBook unreachable
all night, `ssh iumac` rc=255 on every retry 00:55–05:00). So telemetry/usage live and the end-to-end proof are not
done. `make deploy` fails closed in preflight, as designed, and nothing on the mini changed.

Master: `2ffe773` (agw #12–#15 merged by `rd merge`, `make check` after every rebase).

## Per step

|Step|Verdict|Evidence|
|-|-|-|
|`agw` CLI generator (Opus/medium)|**done**|PR #12 merged (train: 290 pass, 0 fail). Rounds: gateway deep r1, lead `/code-review high` r1, gateway standard r2 → r3 **clean**; r4 took two hardening items from r3 (host-supplied run ids get the path check before any poll; `agw schema --help`). Contract: reserved globals skip the colliding operation, listed under `skipped` in `agw schema`; cleartext bearer only to loopback; `$ref` path items and operations dereferenced; percent-decode bounded at 8|
|Host process (Sonnet/high)|**done**|PR #13 merged (train: 382 tests, 0 fail; rebased on #12, `bun.lock` regenerated). R2 deep: 3 blocking fixed (bounded `Runtime.ping` with `query_timeout`, host envelopes 401/412/503 `defined: false`, `Idempotency-Key` replay with a different input → 409 `CONFLICT`); capability inputs `.strict()`; one `secretProblem()`. R3 deep **clean**; r4 took workflow inputs `.strict()`, held waits retry failed reads (≤ 5 in a row, inside the deadline), a done run keeps `output: null`. Lead read of boot/lifecycle/auth: teardown in reverse on any boot failure, port bound before the runtime opens, constant-time bearer|
|OpenCode host (Opus/medium)|**done**|PR #14 merged (train: 446 tests, 0 fail). Four review rounds on the concurrency paths (deep r2: WarmCache evicting an in-use entry, a retry opening a sibling session; deep r3: a re-attached older directory unpinned and unrenewed; standard r4: `isOurServer` port substring 4096 ⊂ 40960). Lead read caught one the gateway missed: a claimed pin kept its 30-min lapse timer (a long turn lost eviction protection). Live tests (opencode-safe, cheap route): re-attach after a kill, one prompt, one resume note; a non-shell agent's read/glob/grep/edit outside its location refused (`Permission denied: external_directory`, 5/5), README threat model updated|
|agent-gateway CLI → `agw-legacy` + sweep|**done**|(previous lead) agent-gateway `64e7b44`; dotfiles #36, hermes-agent #9, modelpick #1, jkrumm.com #1, brain #1|
|LaunchAgents, `make deploy|verify`, map|**merged; deploy blocked**|PR #15 merged (train: 450 tests, 0 fail). Release layout after lead `/code-review high`: `~/.agent-workflows/repo` (fetch only), `releases/<sha>` (export + `bun install`, `.complete`), `current` symlink, `deployed-sha`/`previous-sha`; rollback to the previous release on a failed health wait, first deploy booted out (no KeepAlive loop); unload wait = ExitTimeOut + 10 s; API secret read in preflight; env file + `agw` link before `deployed-sha`; `launch.sh` exit 78 on an unresolved or empty ref. `make verify` = health, sha == origin/master, `agw smoke ping` with the real bearer, its journal row done with trace id and priced usage. **Live:** `make deploy` → `cannot read op://mini/agent-workflows/API_SECRET through secrets-run …; nothing was changed`, exit 1, no `~/.agent-workflows`, label not loaded, no `~/.local/bin/agw`. dotfiles PR #34 (map, heartbeat, herdr group) stays open until the deploy|
|Telemetry and usage live|**blocked on the owner**|Request `20261028T005518-15306` still queued in `~/.local/state/human-queue/`|
|One trivial workflow end to end|**built, not proven**|`smoke.ping` is on master; `make verify` is the proof once deployed|
|Fleet tooling: `rd say` verifies delivery|**done**|dotfiles PR #35 merged (`af2f9e8`, `gh pr merge --rebase` with the reason: dotfiles' train is red on the not-ours architecture rows). Gateway standard r1–r3 (blocking fixed each round), light r4 **clean**. One delivery primitive `prompt_attempt` for say/wave/fan; unreadable state never re-sends; rc 3/4 reported as "unconfirmed", never "unprompted"; nameless agents by pane id (verified live: `herdr agent get <pane-id>` works). **Live:** `rd say dotfiles-rd-say-verify …` → `delivered`, rc 0, the worker answered `ack`; `rd say` to a working agent → `queued: agent busy …`|

## Left behind

1. **The deploy chain, in order, once the owner answers** (`~/SourceRoot/dotfiles/scripts/ask-human.sh push 20261028T005518-15306`, or the owner runs `make human-queue` on the MacBook): it creates `op://mini/agent-workflows/{API_SECRET,ARGO_URL,OTEL_EXPORTER_OTLP_ENDPOINT}`. Then add the three refs to `dotfiles-private/headless.refs`, commit, push; `ask-human.sh ask 'reseal the secrets cache' --cmd 'cd ~/SourceRoot/dotfiles-private && git pull --ff-only && cd ~/SourceRoot/dotfiles && make secrets-seed' --wait`; `make deploy` in agent-workflows; `make verify`; `@verifier` for spans in ClickStack (VPS tier) and the usage row in Argo; `gh pr merge 34 --rebase` in dotfiles with the not-ours-rows comment; `make doctor` green on the new rows.
2. **IU "Insufficient Balance" (503 PaymentRequired)** on the gateway's adversary angle (DeepSeek on IU) since ~04:05: the r4 review on #14 and both reviews on #15 ran without their cross-family critic (lead `/code-review high` on Max stood in on #15). The OpenCode live tests on Haiku/IU still passed at 04:20, so it looks like the DeepSeek upstream balance, not IU as a whole. Spend question for the owner; check before `make verify` (`smoke.ping` → `llm.title`).
3. Accepted risk, documented (`launch.sh`, `serverEnv`, opencode-host README): the OTLP ingest key reaches the OpenCode server env and its tool shells, like the IU key (concept §8).
4. Improvements reviewed and not taken (all non-blocking): CLI stdin read without a timeout, `execute()` split; host readiness of agent-host/IU wiring, one run-shape definition, test-support relative imports; OpenCode pins moved into `WarmCache`, `host.ts` split, cross-process `compileLocation` race (README Known gaps); deploy dry-run step dedup, lock held across the re-exec, shared constants; dotfiles #35: `polls=0` on a zero-wait override, `say_modal` read failure vs no modal, wall-clock bound over ssh, document the "queued after dismissing" output.
5. Flaky under load: `packages/runtime/test/middleware.test.ts` "a throwing toolPre with a plain error…" hit the 5 s timeout once (6.3 s) at load ~200; a host test once too. A Biome `noExplicitAny` warning in `packages/host/test/workflows.test.ts:70` (not failing).
6. dotfiles worktrees left: `w3-rd-say-verify` (merged; `rd fan --clean` calls it unmerged because the rebase merge changed the shas) and `w3-agent-workflows-host-map` (#34 open), panes `w59:p1`/`w59:p2`.
7. Carried from the previous lead: direct capability calls not recorded (now Wave 4's first item); agent-gateway `dispatch-worktree.test.ts` credential-helper failure on the mini (not ours, report to the owner); modelpick's main checkout `ahead 1, behind 2` with `scripts/verify-deployments.ts` still calling `agw`; confirm `~/.hermes/skills` picked up hermes-agent's dispatch skill; agent-gateway install-cli's narrow unlink match; `wave-watch.sh --agents` lag.

## make check

Master `2ffe773` via the train: 450 tests across 39 files, 0 fail, `==> check passed` (`make check` now runs `bun install --frozen-lockfile` first).

## Review verdicts

|PR|Reviews|Outcome|
|-|-|-|
|agw #12 CLI|gateway deep r1, lead `/code-review high` r1, gateway standard r2, r3|r1, r2 actionable → fixed; r3 clean; merged|
|agw #13 host|gateway deep r1, lead `/code-review high` r1, gateway deep r2, r3|r1, r2 actionable → fixed; r3 clean; merged|
|agw #14 OpenCode host|gateway deep r1 (needs-human → lead decision), lead `/code-review high` r1, gateway deep r2, r3, standard r4 (one attempt timed out, re-run)|actionable each round → fixed (+ lead-found pin lapse); r4's needs-human was only the failed adversary, its one blocker fixed; merged|
|agw #15 deploy|gateway deep r1, lead `/code-review high` r1, gateway deep r2|r1 no confirmed blockers, lead review 9 findings (release layout, rollback, unload wait, test state dir) → fixed; r2 one blocker (verify path) → fixed; adversary failed both times (IU balance); merged|
|dotfiles #35|gateway standard r1–r3, light r4|r1–r3 blocking fixed; r4 clean; merged|
|dotfiles #34|gateway standard, light (previous lead)|clean; open until the deploy|

## Live verification

- `rd say`: delivery proven to an idle worker (`delivered`, rc 0, answer `ack`).
- `make deploy`: fail-closed preflight proven, nothing changed.
- OpenCode host: live re-attach and the external-directory guard (worker runs, opencode-safe).
- Host, CLI end to end, spans, usage: **not proven**, blocked on item 1.

## IU spend

usage-tracker, `billing='iu'` since 2026-10-27 23:40Z: agent-gateway reviews ≈ $2.31 (opencode angles $1.02, adversary $1.01, router $0.15, synthesis $0.14), an upper bound because iris and prometheus jobs share the gateway (prometheus-epx alone $0.12). OpenCode live tests ≈ $0.007 over all rounds. `purpose=build` is not tagged on legacy gateway jobs.

## Retro notes

Previous lead:
- Fixing the cross-package HTTP contract in the briefs let CLI and host build in parallel without drift; the one mismatch (reserved flag names) was a contract gap, found by review and fixed on both sides.
- Lead `/code-review high` again found what the workers' own gateway reviews did not: a 30 s client abort on synchronous LLM calls, leases held through a late start failure, WarmCache races.
- A caller sweep across many repos needs an explicit "no work remotes" rule: the worker pushed to an IU GitLab repo with an active fleet.
- The secrets path is the critical path for a deploy: the 1Password item should be created at the start of the wave while the owner is awake.

This lead:
- The secrets lesson came true: everything merged by ~05:00, the deploy waits on one owner click requested at 00:55. Next wave: ask for every 1Password item in the plan's first hour, and plan for `ssh iumac` being down at night.
- Concurrency code converges slowly under review: #14 needed four rounds, and each round's fix produced the next round's finding (pins, re-attach directories, lapse timers). Read every fix diff yourself: the pin-lapse bug passed the worker's tests and the gateway.
- `/code-review` on a PR target checked out `origin/w3/deploy` in the shared main checkout (detached HEAD), where the mother also commits. Run it from a worktree, or check `git status -sb` right after it.
- A lost cross-family critic (IU balance) silently weakens the gateway verdicts to `needs-human`. Read `discussions` for failed angles and substitute a Max review on security-adjacent work.
- The Max 5-hour limit stopped every worker for an hour (02:49–03:50). Under that limit plus load ~200, wall time per round roughly doubled.
- Small hardening rounds after a clean review (CLI r4, host r4) were cheap (2–3 min each) and ran while the other PRs were reviewing, so they cost the train nothing.
