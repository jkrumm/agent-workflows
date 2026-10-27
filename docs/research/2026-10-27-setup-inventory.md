# Claude Code + Hermes setup inventory (2026-10-27)

Facts only, as input to the target picture in `../concept.md` §10. Skill sizes are SKILL.md lines.

## Global skills (`dotfiles/skills/<name>/SKILL.md`)

| Skill | Does | Backend | Lines |
|-|-|-|-|
| check | format/lint/tsc/test | `mcp__agent-gateway__check` + `job_wait` | 14 |
| review | multi-angle review (`--deep`) | `mcp__agent-gateway__review` + `job_wait` | 78 |
| research | cited deep research | `mcp__research-gateway__research` + `job_wait`; fallback `research` CLI | 28 |
| prose | polish drafts | `agw prose` CLI (MCP as alternative) | 51 |
| excalidraw-diagram | `.excalidraw` files | `mcp__agent-gateway__excalidraw_diagram` | 245 |
| otel | traces/logs/metrics | `mcp__agent-gateway__otel`; `scripts/hdx.py`; `scripts/query.py` | 171 |
| implement | guided implementation | names `mcp__agent-gateway__dispatch`, `job_wait`, `/research`, `rd`, `agw` | 191 |
| wave | chained contexts on the mini | `rd`, `opencode`; mentions dispatch | 190 |
| remote-dev | operate the mini | `rd`, herdr socket; mentions `agw dispatch` | 201 |
| upgrade-deps | dependency upgrades | `/research`, `rd`, `gh` | 446 |
| podcast | notes → episode | `bun run podcast` in audio-gateway (HTTP :7719) | 112 |
| img | image gen/upload/share | `imgcli` (image-gateway HTTP) | 103 |
| browse | Chrome DevTools via subagent | `mcp__chrome-devtools__*` | 50 |
| brain, distill, archify | vault, prose pipeline, diagrams | none | 75 / 96 / 137 |
| analyze | static analysis | `fallow` + `claude -p` | 136 |
| cloudflare, secrets | DNS/tunnels, 1Password | `curl`, `op` | 235 / 265 |
| commit, git-cleanup, pr, ship, herdr | git/GitHub/herdr | git, `gh`, herdr | 312 / 234 / 604 / 99 / 195 |

No per-repo skill calls a gateway MCP tool directly.

## MCP servers (registered per Claude account by `dotfiles/Makefile`)

| Server | Transport | Callers |
|-|-|-|
| agent-gateway | stdio `bun run agent-gateway/server/mcp.ts` | check, review, prose (alt), excalidraw-diagram, otel, implement, wave; CLAUDE.md "Async jobs" |
| research-gateway | HTTP `research.mini…/mcp`, headersHelper | research skill; CLAUDE.md "Async jobs" |
| chrome-devtools | stdio `npx chrome-devtools-mcp@latest` | browse, `@verifier` |

## agent-gateway MCP tools vs the existing `agw` CLI

`agw` exists today: `agent-gateway/bin/agw.ts`, 1,557 hand-written lines, against `127.0.0.1:7705`.

| Tool | `agw` today | Caller found by MCP name |
|-|-|-|
| check, review, dispatch, prose | yes | yes |
| job_status / wait / cancel / steer | `status` `wait` `cancel` `steer` | wait/status yes, steer no |
| triage, decide, update_pr | yes | no |
| otel, excalidraw_diagram | **no** | yes |
| read_image, read_drawing, narrative, overview | **no** | no (Hermes calls narrative/overview over HTTP) |

`agw` also has `routing`, `policy`, `health`, `help`.

## Agents, hooks, rules

- **Agents:** `implementer.md`, `verifier.md`.
- **Hooks:** `docker-makefile`, `iu-model-guard`, `machine-role`, `model-discipline`,
  `protect-branches`, `session-env` — none touches MCP or gateways.
- **Rules:** always on — attribution, code-style, formatting, research-first, security; lazy — 13 others.

## global.CLAUDE.md rows that move

- Routing table: `agw dispatch` row; `warden run` row; `/check` `/research` `/review` rows (MCP-backed skills).
- "Four lanes" paragraph (includes `warden run`).
- "Async jobs" section (`mcp__…` submit → `job_wait`).
- "Model ids live only in `agw routing`".

## Hermes (`hermes-agent/`, `~/.hermes/`)

No gateway MCP; everything via `terminal` (curl/scripts). Only MCP: `weatherorb`.

| Target | Path |
|-|-|
| agent-gateway | HTTP `localhost:7705/api/jobs` from `~/.hermes/scripts/{prose,narratives-cron,project-narratives,agents-overview}.py`; `dispatch` skill |
| warden | `scripts/hermes-cc.sh run <repo>` shim; read-only `warden` skill on warden's HTTP API |
| research-gateway | `skills/research-gateway`: `POST /research/`, poll `GET /research/{jobId}` |
| audio-gateway | OpenAI-compatible base URL for `tts` and `stt` in config; skills `briefing-tts`, `podcast` |
| image-gateway | `image-delivery` → `imgcli` |
| HyperDX | `hyperdx` skill: curl JSON-RPC to HyperDX `/api/mcp` |
| argo, herdr/rd, brain | `argo-api` skill; `herdr`, `human-queue`; `obsidian`, `capture`, `brain-commit.sh` |

## CLIs in `~/.local/bin` that matter here

`agw` (agent-gateway), `research` (research-gateway REST), `imgcli` (image-gateway), `rd`, `warden`
(shim), `jobrun` / `jobs-grade`, `claude-account`, `opencode` / `opencode-safe`. `hdx` is not on PATH —
it exists only as `dotfiles/skills/otel/scripts/hdx.py`.

## Eval sets that exist

- research-gateway: `evals/golden.jsonl` (28 regex-checked questions) + results.
- agent-gateway: unit tests only — **no quality eval set for review or check**.
