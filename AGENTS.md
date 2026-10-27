# agent-workflows — Agent Instructions

## What this repo is

The one platform for every repetitive agent job on the Mac mini: review, check, research, otel,
brain, diagrams, prose, podcasts, images. The unit is the **workflow** (typed in/out, versioned,
evaluated); every workflow runs inside the same middleware; Claude Code and Hermes reach all of it
through one generated `agw` CLI. It replaces agent-gateway, research-gateway and audio-gateway by a
hard rewrite. **`docs/concept.md` is the design and wins on any difference with this file.**

**Status:** Wave 2: the runtime (`packages/runtime`), routes and capabilities landed; the middleware is next.

## Principles (concept §0)

- **The optimal outcome over the plan.** A better shape found on the way → a new concept version
  that says why, then a clean migration: the superseded path deleted, no shim, no half state.
- **Every phase ends with a retro** in `docs/concept.md` §Retro log.
- **Round over fast.** Done means the callers work well on the new path, verified live.
- **Limits teach, they don't interrupt.** Turns, cost and wall time are recorded; only runaway caps
  far above normal stop a run.

## Public repo

This repo is public. Never commit IPs, hostnames, internal URLs, tokens, usernames or account ids.
Configuration comes from the environment; templates are `.env.tpl` files of `op://` refs resolved
by `secrets-run` on the mini. Placeholders: `<your-domain>`, `<tailscale-ip>`, `example.com`.
CI runs on GitHub-hosted runners (public repo).

## The fleet that builds it

Shape and roles: the `/wave` skill, fleet mode (`~/.claude/skills/wave/roles/{mother,lead,worker}.md`).

| Role | Model / effort | Owns |
|-|-|-|
| **mother** | Opus / high | `docs/waves/PLAN.md`, `docs/waves/handoff/mother.md`, spawning and rotating the lead, phase moves, the retro log. Never reads or edits code |
| **lead** | Opus / high | briefs, `rd fan` batches, reading every diff, all reviews, the merge train, deploys on the mini, live verification |
| **worker, hard logic** | Opus / medium | journal and resume, the middleware pipeline, the CLI generator, OpenCode re-attach, eval statistics |
| **worker, standard** | Sonnet / high | ports, integrations, tests, capabilities, LaunchAgents, docs that describe code |
| **worker, mechanical** | Haiku | inventories, renames, caller sweeps, fixture extraction, link checks |

- `rd fan` takes one model per batch (`RD_WAVE_MODEL`, `RD_WAVE_EFFORT`): the lead batches briefs
  by model class.
- Spawn prompts carry **no `(Wave <n>)` token** for the mother and the lead, so each takes the next
  free tab number and never collides with a phase number. Spawns from the mother set
  `RD_ORCHESTRATED=1`; the mother decides when a deploy happens, not a keyword gate.
- Max subscriptions only for every Claude session; the picker switches accounts, `rd` pauses when
  both are out. IU tokens only for agent steps inside workflows, review and research.

## Review flow (every change)

1. The worker's cheap check (`bun test <path>` or the brief's command).
2. The lead reads the diff — a report is a claim, the diff is the proof.
3. `/review` — agent-gateway until the new `agw review` passes its cutover (concept §11 P1), then
   the new one (dogfood). Standard depth; `--deep` for the runtime, middleware, CLI contract and
   anything security-adjacent. OCR stays off (IU budget).
4. The lead's own review on Max: `/code-review high` on core packages and on every cross-package
   interface.
5. Fixes back to the worker with `rd say`; merge train (`rd merge`) runs `make check` after every rebase.
6. At each wave's end: deploy on the mini and `@verifier` proves the wiring live — run record in
   Postgres, spans in ClickStack, usage in Argo, the CLI end to end.

## Other repos the fleet touches

One agent per checkout, always. Cross-repo edits go through a worktree or wait for the checkout to
be free (`rd agents`).

| Repo | Why |
|-|-|
| vps | P0b: the mini's Postgres as a maintained instance |
| dotfiles | architecture map, herdr groups, skills, global CLAUDE.md (P5). **Held by the P0 wave until it closes** |
| agent-gateway | rename its CLI to `agw-legacy` (P1); shrink to `dispatch` (P6). Frozen otherwise |
| research-gateway, audio-gateway | frozen (fixes only) until cut over; archived in P6 |
| argo, usage-tracker | usage projection and trimmed collectors (P4) |
| hermes-agent, `~/.hermes` | `agw` instead of HTTP calls (P5) |

PR-required repos (`~/.claude/pr-required-repos.json`) go through a PR, self-review, merge.

## Validate / Deploy / Verify

Bun workspaces (`packages/*`), pinned toolchain per `docs/spikes/s3-stack/REPORT.md`. `docs/spikes/**` is
excluded from every tool.

| Command | Runs |
|-|-|
| `make check` | `biome format`, `biome lint`, `oxlint --type-aware`, `tsc --noEmit`, `bun test --isolate`; non-zero on any failure. **The merge train's gate**, and what CI runs |
| `make fmt` | `biome format --write` |
| `make deploy` | Skeleton: nothing is deployable yet (Wave 3: LaunchAgents on the mini) |
| `make verify` | Skeleton: nothing is deployable yet (Wave 3: health, a smoke run, its trace) |

CI (`.github/workflows/ci.yml`) runs `bun install --frozen-lockfile` and `make check` on pushes to `master` and
on pull requests, on GitHub-hosted runners.

`make check` needs Postgres: tests read `AGW_TEST_PG_URL` and fail when it is unset. On the mini `make check` builds it from `.env.test.tpl` through `secrets-run`; elsewhere set `AGW_TEST_PG_URL` (CI uses a `postgres:18` service). Each test file works in its own throwaway schema.

## Gotchas

- `docs/concept.md` changes only with a version note at the top and a retro-log entry.
- Never point an LLM probe at an endpoint with bare `opencode run`; use `opencode-safe` and `timeout`.
- Docker only through Makefile targets; dev servers are never started by agents.
