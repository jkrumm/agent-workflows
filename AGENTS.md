# agent-workflows — Agent Instructions

## What this repo is

The one platform for every repetitive agent job on the Mac mini: review, check, research, otel, brain, diagrams, prose, podcasts, images. The unit is the **workflow** (typed in/out, versioned, evaluated); every workflow runs inside the same middleware; Claude Code and Hermes reach all of it through one generated `agw` CLI. **`docs/concept.md` is the design and wins on any difference with this file.** Plan and status per wave: `docs/waves/PLAN.md`.

Every text and agent seat sits on a Claude tier (`FAST`, `EASY`, `HARD`, `DECIDE` in `packages/routes`). The inference gateway (`packages/gateway`) holds every provider key; agw holds none.

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

## Who builds it

Work reaches this repo as factory Issues, one lead per Issue (software-factory owns the lifecycle, deploy and
verification). Claude sessions run on the Max subscriptions only. API tokens (IU, the credit pools' Anthropic keys)
serve agent steps inside workflows and research, and the gateway holds them: agw itself holds no provider key.

## Review flow (every change)

1. A cheap check while building (`bun test <path>`).
2. Read the diff, including a subagent's: a report is a claim, the diff is the proof.
3. `/review` — review v4 (below): `agw review prepare` → the reviewer agent → `agw review submit` → `dispose` every
   finding. The router picks the tier from `REVIEW.md`'s globs; `--min deep` for the runtime, middleware, CLI contract
   and anything security-adjacent.
4. `/code-review high` on core packages and on every cross-package interface.
5. `make check-fast` after each change (CI's `make check` is the full gate on the pull request head); `make check` after every rebase.
6. After a deploy on the mini, `@verifier` proves the wiring live: run record in Postgres, spans in ClickStack,
   usage rows in the `usage` schema, the CLI end to end.

Review v4 is the only review: host operations `agw review prepare|submit|dispose|status|route|covered|cancel|stats` over a Postgres ledger, routed by `REVIEW.md`'s globs. The ledger, the repeat-`prepare` and `a..b` rules, and what `covered` proves: `docs/review-v4.md`. The reviewer agent's live definition: dotfiles `agents/reviewer.md`.

## Other repos this one touches

One agent per checkout, always. Cross-repo edits go through a worktree or wait for the checkout to
be free (`agw agents`).

| Repo | Why |
|-|-|
| vps | P0b: the mini's Postgres as a maintained instance |
| dotfiles | architecture map, herdr groups, skills, global CLAUDE.md (P5). **Held by the P0 wave until it closes** |
| agent-gateway, research-gateway, audio-gateway | retired, archived (P6) |
| usage-tracker | owns the `usage` schema agw writes its usage rows into (`migrations/pg`); trimmed collectors (P4) |
| argo | the host no longer pushes the overview or review stats to it (its `/agents/*` API is gone); usage goes to Postgres |
| hermes-agent, `~/.hermes` | `agw` instead of HTTP calls (P5) |

PR-required repos (`~/.claude/pr-required-repos.json`) go through a PR, self-review, merge.

## Validate / Deploy / Verify

Bun workspaces (`packages/*`). `docs/spikes/**` is excluded from every tool. The full table, every gate and the CI and Postgres paragraphs: `docs/validate-deploy-verify.md`. Read it before a deploy, a verify, a live-routes run or a change to a Makefile gate.

| Command | Does |
|-|-|
| `make check` | Frozen install, mini-registry lint, `make static` (oxfmt, oxlint, tsc), `make test` (the merge train's gate), `make usage`. Needs Postgres: `AGW_TEST_PG_URL`, else the mini's through `secrets-run`. |
| `make check-fast` | The lead tier (`project.yaml` `checks`): install, registry lint, `make static`, `make test-fast` (`bun test --changed` against the merge base: the tests the branch's TypeScript reaches; none for docs-only; the whole suite for any other change), `make usage`. CI runs `make check` on the pull request head and the merge waits for it. |
| `make deploy` | Releases `origin/master` to `~/.agent-workflows/releases/<sha>` and restarts the LaunchAgents from it. A release that never turns healthy rolls back. |
| `make verify` | Exits 0 only when the deployed sha is `origin/master`, `/health` is ok, and the smoke run, the direct LLM call and the gateway calls each land a `done` run with priced usage. |
| `make live-routes` | One real call per route. Costs cents. |
| `make hyperdx-apply` | Upserts the prod dashboard and alerts. A definition change is not live until it runs. |
| `make install-opencode` | Pinned OpenCode build. Run it in the main checkout: refused from a worktree. |
| `make research-chrome` | Headed Chrome LaunchAgent that `web.fetch` falls back to. |
| `make test-timings` | Re-records test timings. Run it on an idle machine and commit the result. |
| `make version` | The deployed sha, one line, read-only. |

## Gotchas

Full text with the mechanisms behind each: `docs/gotchas.md`. Read it before you change the deploy, the gateway, the doors, the secrets handling or a CLI verb's shape.

- **A release is what runs, never a checkout.** Never edit a release; the dev checkout and its dirty tree never go live.
- **The host fails closed on the secrets cache.** A new `op://` ref in `.env.tpl` or `.env.gateway.tpl` must be seeded before the deploy that needs it. Never `op read` on the mini: use `secrets-run`.
- **No provider key in `.env.tpl`.** The host reaches models through the gateway (`AGW_GATEWAY_URL`).
- **Callers outlive a release.** Never remove or change the meaning of a flag or verb in the change that introduces its replacement. Remove the old one a release later, once `rg` over `~/SourceRoot` finds no caller. A step whose meaning or output shape changes takes a new step id.
- **Never point an LLM probe at a bare `opencode run`.** Use `opencode-safe` and `timeout`.
- **Docker only through Makefile targets; dev servers are never started by agents.**
- **`docs/concept.md` changes only with a version note at the top and a retro-log entry.**
