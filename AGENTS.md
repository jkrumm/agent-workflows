# agent-workflows — Agent Instructions

## What this repo is

The one platform for every repetitive agent job on the Mac mini: review, check, research, otel,
brain, diagrams, prose, podcasts, images. The unit is the **workflow** (typed in/out, versioned,
evaluated); every workflow runs inside the same middleware; Claude Code and Hermes reach all of it
through one generated `agw` CLI. It replaces agent-gateway, research-gateway and audio-gateway by a
hard rewrite. **`docs/concept.md` is the design and wins on any difference with this file.**

**Status:** Wave 2 landed the core: `runtime`, `middleware`, `limits`, `routes`, `capabilities` (`packages/*`). Wave 3 landed the CLI (`agw`), the host process, the OpenCode host and the deploy (LaunchAgent on the mini, `make deploy|verify`). The inference gateway (`packages/gateway`) holds every provider key: agw holds none, and the host, the audio process and the OpenCode server reach every model through it (`AGW_GATEWAY_URL`). Wave 4 reconciled the credit pools against each org's cost API and gave Argo the gateway's payers; Wave 5 laid the eval foundations (run-scoped arms, eval cost roll-up, structured agent output, schema output on the wire, one model id per model). Wave 6 put every text and agent seat on a Claude tier (`FAST`, `EASY`, `HARD`, `DECIDE` in `packages/routes`; picks measured in `docs/evals/2026-11-02-claude-seats.md`) and gave the gateway credit pacing (an eval reserve per pool). Plan and status per wave: `docs/waves/PLAN.md`.

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
  both are out. API tokens (IU, the credit pools' Anthropic keys) only for agent steps inside workflows and research, and the gateway holds them: agw itself holds no provider key.

## Review flow (every change)

1. The worker's cheap check (`bun test <path>` or the brief's command).
2. The lead reads the diff — a report is a claim, the diff is the proof.
3. `/review` — review v4 (below): `agw review prepare` → the reviewer agent → `agw review submit` → `dispose` every
   finding. The router picks the tier from `REVIEW.md`'s globs; `--min deep` for the runtime, middleware, CLI contract
   and anything security-adjacent.
4. The lead's own review on Max: `/code-review high` on core packages and on every cross-package
   interface.
5. Fixes back to the worker with `rd say`; merge train (`rd merge`) runs `make check` after every rebase.
6. At each wave's end: deploy on the mini and `@verifier` proves the wiring live — run record in
   Postgres, spans in ClickStack, usage rows in the `usage` schema, the CLI end to end.

Review v4 (Max only, no API review spend, no LLM in agw) is the only review: host operations `agw review
prepare|submit|dispose|status|route|covered|cancel|stats` over a Postgres ledger (`packages/host/src/review/README.md`),
routed by `REVIEW.md`'s globs. `/review` (the dotfiles skill) runs `prepare` → the reviewer agent
(`docs/spikes/review-v4/reviewer.md`) on the printed seat → `submit` → `dispose` for every finding, rounds converging by
disposition. `covered` proves a commit range was reviewed; the wave gate and the factory's evidence read it. `eval.recall` was removed with the hidden transport; leaders review in-session with `/review`. Review v1 (the
LLM workflow with angle agents, OCR and react-doctor) was deleted in Wave 10.

## Other repos the fleet touches

One agent per checkout, always. Cross-repo edits go through a worktree or wait for the checkout to
be free (`rd agents`).

| Repo | Why |
|-|-|
| vps | P0b: the mini's Postgres as a maintained instance |
| dotfiles | architecture map, herdr groups, skills, global CLAUDE.md (P5). **Held by the P0 wave until it closes** |
| agent-gateway, research-gateway, audio-gateway | retired, archived (P6) |
| usage-tracker | owns the `usage` schema agw writes its usage rows into (`migrations/pg`); trimmed collectors (P4) |
| argo | overview and review-stats pushes only; no longer receives usage |
| hermes-agent, `~/.hermes` | `agw` instead of HTTP calls (P5) |

PR-required repos (`~/.claude/pr-required-repos.json`) go through a PR, self-review, merge.

## Validate / Deploy / Verify

Bun workspaces (`packages/*`), pinned toolchain per `docs/spikes/s3-stack/REPORT.md`. `docs/spikes/**` is
excluded from every tool.

| Command | Runs |
|-|-|
| `make check` | `bun install --frozen-lockfile` first (stale `node_modules` never passes), then `oxfmt --check`, `oxlint --type-aware`, `tsc --noEmit`, `bun test --isolate`; non-zero on any failure. **The merge train's gate**, and what CI runs |
| `make fmt` | `oxfmt --write` |
| `make deploy` | On the mini: fetch `origin/master` into `~/.agent-workflows/repo`, export it to `releases/<sha>` and `bun install --frozen-lockfile` there, render and bootstrap the LaunchAgents for that release (`com.jkrumm.agent-workflows-host` on 7791, `com.jkrumm.agent-workflows-audio` on 7792), and the gateway's (`com.jkrumm.agent-workflows-gateway` on 7794; bundled to `gateway/<build>/` and restarted only when its build changed, otherwise left running), create `data/door-tokens` if missing (one token each for `hermes`, `studio`, `agw-opencode`, `oc`, `modelpick`; an existing file gains the lines it lacks of the last four, never printed, other lines untouched) and check it with the host's door-token parser before anything is stopped; the gateway reads the file only at start, so a file whose sha256 differs from `data/gateway-door-tokens` (written when a deploy started it healthy) restarts it even at an unchanged build. A restarted gateway is stopped after host and audio and started first, and must be healthy (`build`) before they start, forward and in a rollback or redeploy recovery alike; then wait for host's and audio's `/health` (version = the sha), then `current`, `~/.config/agw/env` (with `AGW_PROCESSES`), `~/.local/bin/agw`, `data/deployed-sha`. A release where one never turns healthy is rolled back to the previous one, the restarted processes together (the gateway to its previous build directory; a gateway the deploy left running is not touched); a process left down on a failed sha (no previous release, or one that predates it) has the plist this deploy rendered removed, a failed redeploy of the live sha keeps its plists and starts the processes from them once more, naming which are up (exit 1). `DRY_RUN=1` prints the plan, every plist and the gateway's build id and decision, and changes nothing. Details: `packages/host/README.md` §Deploy |
| `make verify` | Exit 0 only if the pinned OpenCode build of the deployed release is installed (`scripts/pins.sh check`; a miss names `make install-opencode`), `/health` is ok, the deployed sha is `origin/master`, `AGW_PURPOSE=verify agw smoke ping` returns a `title`, and its `agw.runs` row is `done` with a trace id and priced usage, and a direct `AGW_PURPOSE=verify agw llm title …` left a `cap.llm.title` run `done` with priced usage, and the audio process is ok at the same sha, `agw audio ping` left a `done` run, and its door answers 401 without a caller token and the legacy 400 to an authenticated bad body, and the gateway is ok at `data/gateway-build` and three real Haiku calls through it behave (a credit pool; the same call again reading the cache; a Claude-Code-shaped one on `iu-api`) and land `usage.records` (`api_credit` with a priced cost, `api_credit`, `api_key`/`personal`) and `usage.gateway_picks` rows, a fourth with the `agw-opencode` door token lands `lane='agw_workflow'`, and the smoke run and the `cap.llm.title` run each have `source='gateway'` rows, every one qualifying (`agw_workflow`, workflow and step set, priced; `api_credit` on a pool `/health` lists or `api_key`/`personal`), and, once the host outbox synced their usage steps (`argo_synced_at`), no `source='agent-workflows'` row, all within 120 s (never waits on the Anthropic cost API). Prints the run ids and the four request ids |
| `make version` | Print the deployed commit sha (`~/.agent-workflows/data/deployed-sha`, `AGW_ROOT` redirects), one line, read-only; the factory checks a shipped commit against it. `project.yaml` (deploy mode `make`, target `mini`, `verify: make verify`, ship by push) is the factory manifest |
| `make live-routes` | One real call per route: every route on the `anthropic` or `opencode` wire and every `iu-openai` text route (`agw routes`; `ROUTES='a b'` narrows), each as `AGW_PURPOSE=verify agw smoke route <id>` (a fixed prompt; media routes are refused), four at a time, then within 120 s a `source='gateway'` `usage.records` row of the run with the route's model, `cost_usd` and lane `agw_workflow`, and the run's `agw.runs` row `done` with a cost. Prints route, model, billing, account, input, cache read, output, cost, run id; exits non-zero naming each failed route. Costs cents. A Claude alias in a route resolves through `CLAUDE_ALIASES`, read from the source of the deployed release (`~/.agent-workflows/current/packages/routes/src/table/claude.ts`, via `bun`); a missing or malformed map fails the run, there is no copy in the script. The proof behind a changed route; needs the `smoke` agent for opencode routes |
| `make research-chrome` | Install and start the headed Chrome LaunchAgent (`com.jkrumm.research-chrome`, DevTools on loopback `127.0.0.1:9222`, profile `~/.local/share/research-chrome`) that `web.fetch` falls back to for pages a plain client cannot read (`AGW_BROWSER_CDP_URL` in `.env.tpl`). Not part of a release; idempotent, an unchanged loaded agent is left alone. A Chrome that cannot pass a challenge returns `blocked` `needs-human`: a dialog on the MacBook asks the owner (`ask-human.sh`; `AGW_ASK_HUMAN`, `AGW_SCREENSHARE_HOST`; once per host per 30 minutes) to solve it once on screen share, the cookie stays in the profile |
| `make eval-mine-job` | Install the nightly labelling job of the review ground truth (LaunchAgent `com.jkrumm.agent-workflows-eval-mine`, 04:30, runs `scripts/eval-mine-daily.sh` of the live release): `AGW_PURPOSE=eval agw eval mine review --auto --yes` under the key `eval-mine-daily-<UTC date>` (a second trigger adopts the run), sized by the workflow from the gateway's eval credit and the line on IU eval spend (the eval workflows' spend on the personal key, not the key's whole total: `usage.records` total + plan at 1.25 × the measured cost stays under $19.25; a personal-key eval row without a cost fails the read), one line per night in `~/Library/Logs/agent-workflows-eval-mine.log`. Removes its own agent at 200 bug cases. Not part of `make deploy`; idempotent. Fails when the live release has no script: deploy first |
| `make install-opencode` | Install the pinned OpenCode build (`OPENCODE_VERSION`, `packages/opencode-host/src/server.ts`) under `~/.local/share/agent-workflows/opencode-bin/<version>` with a `current` link; link `~/.local/bin/opencode` and `opencode-safe` to this checkout's `scripts/` (refused from a linked worktree, so run it in the main checkout). Idempotent (a present version is not downloaded again); never restarts the host, whose OpenCode server runs the new binary on its next start. Upgrade steps: `packages/opencode-host/README.md` §Pinned build |

CI (`.github/workflows/ci.yml`) runs `bun install --frozen-lockfile` and `make check` on pushes to `master` and
on pull requests, on GitHub-hosted runners.

`make check` needs Postgres: tests read `AGW_TEST_PG_URL` and fail when it is unset. On the mini `make check` builds it from `.env.test.tpl` through `secrets-run`; elsewhere set `AGW_TEST_PG_URL` (CI uses a `postgres:18` service). `packages/middleware/test/usage-pg.test.ts` also needs `USAGE_TEST_PG_URL` (an admin connection, built by `make check` from `.env.test.tpl`) and the usage-tracker checkout beside this repo (`USAGE_MIGRATIONS_DIR` overrides); without either it skips with the reason in its name, so it never runs in CI. Each test file works in its own throwaway schema. Each test file sets a load-scaled default timeout as it starts (`packages/testing` preload from `bunfig.toml`: 5000 ms × 1-minute load average per core, floor 5000, cap 30000; Bun binds a timeout at test registration, so per file is the finest grain); a test with its own explicit timeout keeps it.

## Gotchas

- **A release is what runs, never a checkout.** `make deploy` exports `origin/master` to `~/.agent-workflows/releases/<sha>` and starts the LaunchAgent from there; the dev checkout (and its dirty tree) never goes live, the live release is never written to, and a failed deploy rolls back to `previous-sha`. Never edit a release; the first deploy that fails leaves the LaunchAgent booted out.
- **The host fails closed on the secrets cache.** `scripts/launch.sh` exits 78 unless every ref in `.env.tpl` resolves through `secrets-run` (the offline cache), and names the missing refs. A new `op://` ref in `.env.tpl` must be seeded (`dotfiles-private/headless.refs`, `make secrets-seed` on the MacBook) before the deploy that needs it; until then the LaunchAgent restarts every 30 s and logs the refs to `~/Library/Logs/agent-workflows-host.err.log`. `.env.tpl` holds no provider key (no `IU_*`, no `ANTHROPIC_API_KEY`): `AGW_GATEWAY_URL` is a plain loopback value, and the host's `AGW_GATEWAY_TOOL_TOKEN` comes from the `agw-opencode` line of `data/door-tokens` (missing or empty: exit 78 naming the file and the caller). The podcast notice goes to ntfy (topic `updates`): `NTFY_TOKEN` is a ref in `.env.tpl`, `NTFY_URL` is deployment config that `launch.sh` reads from the `base-url:` line of the ntfy server config (`NTFY_SERVER_CONFIG`, default `~/SourceRoot/homelab/config/ntfy/server.yml`) when unset; a missing file leaves it unset and the notice off. Never `op read` on the mini.

- **Three processes, one journal.** The host and the audio process (`packages/audio`) boot through the same `bootProcess` (`packages/host/src/boot.ts`); each runtime recovers, leases and redelivers only the workflows it serves (`packages/runtime/test/processes.test.ts`), so a run whose process is down waits for it. Only the host serves capabilities over HTTP (the CLI refuses a command two processes declare). Each has its own state dir: two tool gates never share one `gate.json`. The gateway (`packages/gateway`, 7794) is the third process but shares neither the journal nor `bootProcess`: it serves no capability (not in `AGW_PROCESSES`), keeps its own SQLite ledger in `data/gateway`, runs from `~/.agent-workflows/gateway/<build>` rather than a release, and has its own env template `.env.gateway.tpl` and launcher `scripts/launch-gateway.sh`. Its launcher reads only `.env.gateway.tpl`; the gateway holds the `personal` IU key only, the Athena team key belongs to Athena Teamchat.
- **The doors' callers** (the gateway, the audio process's OpenAI-compatible door and the host's image door `/door/image/{generate,edit,enhance}`, the wire of the MacBook studio app) present a bearer from the one file `~/.agent-workflows/data/door-tokens` (`name=token`, mode 0600, created by `make deploy` with `hermes`, `studio`, `agw-opencode` (the host's OpenCode server), `oc` and `modelpick` tokens; a missing line of the last four appended, no other line ever rewritten). `agw-opencode`, `oc` and `modelpick` are gateway-only (`GATEWAY_ONLY_CALLERS`, `packages/host/src/door-tokens.ts`): the audio and image doors refuse them; the API secret is accepted as the caller `agw`, a door token never opens the API. A wider mode or a malformed line refuses the deploy before anything is stopped (and either process's start). Rotation: edit the file, restart all three LaunchAgents (the gateway reads it at start: `launchctl kickstart -k gui/$(id -u)/com.jkrumm.agent-workflows-gateway`, or the next deploy restarts it because the file's digest no longer matches `data/gateway-door-tokens`). The same goes for the API secret (`AGW_API_SECRET`): the gateway holds it from its launcher.

- **The gateway restarts only when its build changes.** The build id (16 hex) is a sha256 over the bundle, `scripts/launch-gateway.sh`, `.env.gateway.tpl`, the gateway plist template and `bun --version`; a deploy that leaves it unchanged, with the gateway loaded and its `/health` ok at that build, logs `gateway unchanged (build …), not restarted` and does not stop it, unless `data/door-tokens` differs from the digest recorded in `data/gateway-door-tokens` when the gateway last started healthy (logged as `restarted anyway: … differs from the one it started on`); a deploy that died after appending lines therefore still restarts it next time. Config the build does not contain does not restart it either: after editing dotfiles `config/claude-accounts.json`, run `launchctl kickstart -k gui/$(id -u)/com.jkrumm.agent-workflows-gateway`. A new `op://` ref in `.env.gateway.tpl` must already be in the mini's cache (the same seeding rule as `.env.tpl`).
- The factory (software-factory) is the one producer of agent state; `agw agents` reads the factory's /v1 read API (`factory read overview` + `factory read sessions --live`) and adds only recommendations and the Max quota.
- **Shop doors:** `agw shop search|item|find` and `agw image-read` read amazon.de at low volume and parse it in code; a wall (429, robot check, sign-in) stops the call with `blocked (<reason>)`, never a retry, a proxy or a second identity; a robot check is read once in the research Chrome and, if that meets it too, the owner is asked to solve it. Conduct, fixtures' provenance and the vision probe: `docs/shop.md`.
- `docs/concept.md` changes only with a version note at the top and a retro-log entry.
- Never point an LLM probe at an endpoint with bare `opencode run`; use `opencode-safe` (`scripts/opencode-safe`, linked by `make install-opencode`) and `timeout`.
- Docker only through Makefile targets; dev servers are never started by agents.
