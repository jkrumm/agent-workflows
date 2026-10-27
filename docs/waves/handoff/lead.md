# Lead handoff — Wave 1 (Foundations)

Lead `agent-workflows-w1`, 2026-10-27. Wave 1 is complete: every step landed on master (or vps master), reviewed, with its gate evidence below. The mother writes PLAN.md's Left behind, the retro entry and the status flips; this file holds the source material.

## Per-step verdicts

| Step | Verdict | Evidence |
|-|-|-|
| S1 workflow runtime (Opus/medium) | **done: own journal on Postgres** | PR #4 (`spike/s1-runtime`), `docs/spikes/s1-runtime/REPORT.md`. Final run with isolated scenarios and a prompt ledger: own 13/13, 0 completed steps re-run, every effect inserted exactly once, every re-attach 1 session + 1 prompt (60.2 s after a SIGKILL at 30 s). DBOS 11/15: parks in-flight runs on any code edit (default app version = source hash) until an old-version process drains them; pinned version fails on an inserted step. Vercel 9/13: `CORRUPTED_EVENT_LOG` on an inserted step (2/2), a mid-step SIGKILL leaves a job lock graphile expires after 4 h, 358 deps / 190 MB. Research job `b57e893a`. |
| S2 telemetry (Sonnet/high) | **done: the shape holds** | PR #2, `docs/spikes/s2-telemetry/REPORT.md`. One trace of 21 spans, 0 orphans, across 5 processes; `traceparent` in (env, header) and out (child env, HTTP header); run record validates against Argo's own `UsageRecordInputSchema`. OpenCode 2.0.32 emits its own spans with `OTEL_EXPORTER_OTLP_ENDPOINT` and parents `http.server` spans to ours; model/tool spans not observed; prompts wedged 6/6 (open risk). |
| S3 stack (Sonnet/high) | **done: oRPC 1.16.1 + zod 4.6.7, bun test, Biome 2.6.3 + oxlint type-aware, TS 7.0.2** | PR #1, `docs/spikes/s3-stack/REPORT.md`. Only oRPC calls one definition in-process through the same validation and middleware as HTTP; the spike-7 CLI runner drove all three frameworks. |
| P0b Postgres (vps, Sonnet/high) | **done** | vps PR #13 (merged `7819f29`), activation `a2ad409`, weatherorb note `64b875b`. `agent_workflows` DB + least-privilege role; nightly backup LaunchAgent `com.jkrumm.vps-pg-backup` (03:15, loaded from the main checkout) to the HomeLab with checksums, ending in a restore drill on exact snapshot counts (`pg_export_snapshot` + `pg_dump --snapshot`); `make dev-pg-restore-drill` passes for real (3 DBs, counts match), negative case proven; `make dev-pg-upgrade` ran 18.4 → 18.6, major refused; `make dev-pg-health` → `postgres ok`; whole-DB `sync-from-prod` deleted (no code callers anywhere). dotfiles side: heartbeat probe + architecture row (dotfiles `9336177`). |
| Scaffold (Sonnet/high) | **done** | PR #3. Bun workspaces, `packages/runtime` placeholder, `make check` (biome format, biome lint, oxlint type-aware, tsc, `bun test --isolate`), deploy/verify skeletons, CI on `ubuntu-latest` with SHA-pinned actions (green in 13 s). |
| Concept v3.1 (lead, inline) | **done, retro entry is the mother's** | `docs/concept.md` v3.1 note at the top; §3 (journal, replay by step id, re-attach order), §4 (telemetry), §5 (Argo projection), §8 (store, stack, OpenCode wedge risk), §12.4 resolved. No decision reversed. The retro-log entry AGENTS.md requires is left to the mother (she owns the log). |

## Review verdicts

The `/review` door (agent-gateway) was up for the whole wave; the mother-start timeout did not recur. No `/code-review` fallback was needed. Lead's own Max review: the S1 own-journal runtime (the design Wave 2 inherits) read in full; nothing else is a core package or cross-package interface yet.

| Change | Review | Outcome |
|-|-|-|
| S3 | agent-gateway light | actionable: 1 blocking (Elysia SSE empty 200 on unknown run) + 3 → fixed in `c0340ba`; Elysia footprint corrected 6 → 18 packages, verdict unchanged |
| S2 | agent-gateway light | actionable: 3 blocking (`out/` never created, reachability guard accepted 401/403, servers bound all interfaces) + 5 → fixed in `d0656f5`. Not re-reviewed: targeted fixes, lead checked the diff and the rerun output |
| P0b | agent-gateway deep | actionable: 3 blocking. Fixed: drill bracket false-fail (now exact snapshot counts), worktree guard now structural. Not changed, by decision: the `homelab:/mnt/hdd/backups/...` default (public precedent: homelab `docs/backups.md`, hermes backup). Improvements taken: scratch-DB/TMPDIR sweep, psql-variable password, ownership convergence, stale DR doc |
| Scaffold | agent-gateway light | clean. Kept by decision: deploy/verify skeletons exit 0 (the brief's choice; Wave 3 replaces them) |
| S1 | agent-gateway standard | actionable: 11 blocking — harness asserted rather than measured (sessions, prompts, effect attempts), unscoped kills, shared schemas made verdicts order-dependent, the 4 h headline overreached, plus own-runtime gaps (active-set leak, unfenced lease, pool starvation, infra errors made permanent, post-hook downgrade, unhandled rejections, JSON replay types). Harness and report fixed and fully re-measured in `ef877d7`; the own-runtime gaps are a 'Wave 2 must' list in the report, not fixed in throwaway code. Verdict unchanged. Kept by decision: `env.ts`'s default template path and the research job id |
| S1 own runtime | lead, Max | two corrections to the report, both fixed in `9f4d7bb`: own re-fires `run/pre` on recovery like DBOS (Wave 2 sketch now carries a `resume` flag); lease connections share the 20-connection pool, so the 20th concurrent run deadlocks every journal query |

## make check

`make check` green on master after the scaffold merge (biome format, biome lint, oxlint type-aware, tsc, 1 test); CI green on PR #3. Spike merges ran `--no-check` before the scaffold existed (docs-only, each spike's own command rerun by the lead). S1 merged with `--check 'bun install --frozen-lockfile && make check'`: a fresh worktree has no `node_modules`, so the train's bare `make check` fails on the missing `tsgolint` binary. vps: `make check` → `OK: local validation passed` in the train. Final master (`5950d1b`): `make check` → `==> check passed` from the main checkout, CI green (run 40573188043). That run needed `acf01fd`: Biome walked `.claude/worktrees/`, hit the worktrees' nested `biome.json` and refused to run, so `make check` failed from the main checkout whenever workers existed.

## Live verification

Wave 1 deploys nothing of this repo (`make deploy|verify` are Wave 3). What is live and proven on the mini:

- `launchctl list` shows `com.jkrumm.vps-pg-backup`; `make dev-pg-health ENV=dev` → `postgres ok`; `make postgres-setup ENV=dev` (the real invocation) provisions `agent_workflows`; a TCP login as the role with the cached password returns `agent_workflows|agent_workflows`.
- Backup `20261027T172640Z` on the HomeLab, verify drill inside it: `DRILL PASS ... 3 database(s) restored and matched the source counts`.
- S2's trace read back out of the local ClickStack (21 spans, 0 orphans).

No `@verifier` run: nothing of this repo is deployed yet, and the P0b proofs above were run directly.

**dotfiles gate, judged on this fleet's rows only (owner note via the mother):** `make check` in dotfiles fails only at `architecture-check`, on rows outside this fleet: `com.iu.athena-postgres` unmapped, `com.iu.teamchat-*` mapped but absent (plus the collie pin and tailscale drift the doctor reports). Not fixed, by instruction. This fleet's row `com.jkrumm.vps-pg-backup` is mapped and no longer flagged; every other dotfiles suite passed under `make -k check`.

## IU spend (purpose=build)

**≤ $1.35 for the wave**, upper bound: every IU row in usage-tracker's `usage.db` since 16:40Z — research $0.64 (research-gateway worker+lead+sonar, the spikes' `/research` jobs), review $0.68 (adversary $0.34, angles $0.24, router $0.05, synthesis $0.05), S2's one direct IU call $0.00001. Other fleets ran reviews in the same window, so the true figure is lower. **The legacy gateways cannot tag `purpose=build`**: no field exists; the figure is reconstructed from the time window. Workers and lead ran on Max.

## Left behind for the next wave

1. **`agent_workflows` is live** with its real password: the owner approved the queued request, the field exists, `dotfiles-private` `20a845d` seals the ref, vps `a2ad409` adds the `.env.dev.tpl` line, and the role converged (TCP login verified). Wave 2 connects with `secrets-run run --env-file=<vps>/.env.dev.tpl`, or a repo `.env.tpl` with the same ref. The first ref push (`d81e0fe`, before the field existed) was reverted in `a7459e5` because `secrets-seed` aborts the whole reseal on an unresolvable ref; worker briefs touching `headless.refs` must say "only after the field exists".
2. **OpenCode 2.0.32 prompt wedge** (S2, 6/6; an earlier spike prompted fine). Isolate before the OpenCode host (Wave 3): replay the dotfiles spike script verbatim, bisect env/cwd/HOME. Liveness stays the idle watchdog per `rules/agent-limits.md`; SIGKILL a wedged server and re-attach.
3. **Wave 2 runtime inputs from S1:** lease on a separate connection budget (or `lease_until` + heartbeat); `runPre` with a `resume` flag, admission rules on `resume: false` only; 64-bit lock keys, not `hashtext`; keep the kill harness as a regression test with concurrent runs; still to build: retry policy, step timeout as an idle rule, cancel/steer, concurrency limits, recovery tick.
4. **Wave 2 telemetry inputs from S2:** the middleware owns flush incl. crash handlers, logs export failures, re-raises signals; tokens from the OpenCode message API; Argo rows normalised to the additive contract and posted from an outbox; check that the exporter reads `OTEL_EXPORTER_OTLP_HEADERS` itself on Bun.
5. **Wave 2/3 CLI inputs from S3:** generator maps oRPC's typed `code` to exit codes, dereferences `$ref`, `JSON.parse`s object/union flags; pin oRPC 1.16.1 (v2 is a breaking beta; `orpc.dev` documents v2, v1 docs live at `v1.orpc.dev`).
6. **Brew `postgresql@18` on :5433 is not stray:** weatherorb's (7 GB `weatherorb`, `weatherorb_dbos`, PostGIS), and its binaries back `com.iu.athena-postgres`. Kept running. Moving weatherorb onto the maintained instance would be a weatherorb migration, not this platform's call.
7. **Stray Docker leftovers** from a P0b worktree attempt: empty volume `p0b-postgres_postgres-dev-data`, network `p0b-postgres_default`. Safe to remove; not removed (agents use Docker only via Makefile targets, and no target covers it).
8. **HomeLab backup dir** holds this session's test backups (counted in the 14 retained); `20261027T165644Z` has a valid checksum but does not restore (DDL during the dump, before the snapshot fix). Delete it by hand or let retention age it out.
9. Unprovisioned role `modelpick` on the mini Postgres (captured by the globals backup); nobody owns it in `setup-postgres.sh`.
10. **Train gate needs an install.** `rd merge` runs bare `make check` in a fresh worktree with no `node_modules`; pass `--check 'bun install --frozen-lockfile && make check'` until `make check` installs itself or the train installs first (decide in Wave 2).
11. **A worker kept committing after its branch merged:** P0b's activation commits landed on the already-merged branch and would have been orphaned; the lead cherry-picked them to vps master (`a2ad409`, `64b875b`). Close or `rd fan --clean` a worker right after its merge.
12. **Fleet tooling friction (dotfiles, now free):** the worker template opens **draft** PRs but `merge-train.sh` cannot merge a draft and misreports it as "main probably moved" three times; the lead ran `gh pr ready` first. Fix one side: the train marks the PR ready, or the template opens a ready PR.

## Retro notes

**What we learned**

- The starting bias held, on evidence: our own journal is 163 lines with 1 dependency and is the only candidate that survives a redeploy without a drain. Both libraries assume a deployment model we don't have (Vercel's per-deployment pinning; DBOS's blue-green drain).
- "Replay by step id" turns the deploy problem into one authoring rule (a changed step meaning takes a new id). That rule is now load-bearing; Wave 2 should lint it.
- The capability layer's "import, HTTP and CLI from one definition" picked the framework by itself: only oRPC has a validated in-process call. Throughput (oRPC 3–8× slower than Hono/Elysia) is irrelevant at our call rates.
- OpenCode telemetry is a join aid, not a record: tokens come from the message API.
- Reviews earned their cost: the deep P0b review caught a drill that would have false-failed valid backups, and the lead's own read caught a pool deadlock the spike's single-run harness could not see. A spike harness that runs one run at a time hides concurrency bugs.
- Workers given a secrets path will take it end to end: P0b pushed a ref the cache could not resolve, which would have blocked every reseal. Briefs touching `headless.refs` must say "only after the field exists".

**Does the concept still hold?** Yes. v3.1 adds detail and resolves §12.4; no decision reversed. One correction carried in: agent-step liveness is the idle watchdog (`rules/agent-limits.md`), not a ceiling. The S2 report's first draft said "hard ceiling"; fixed in the same commit.
