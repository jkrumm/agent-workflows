# Factory input: what the re-plan can build on

**TLDR.** The platform (concept §11, P0–P6) is done and the three gateways are retired. The factory
re-plan (dotfiles `docs/factory/`, TDD v2.4, deferred by N1) starts from a running, journaled,
evaluated workflow host on the mini, reached only through `agw`. Build stations as workflows on it.
Don't build a second runtime, a second CLI, or a second usage path.

Written at the close of Wave 11, 2026-10-29. `docs/concept.md` is the design; this page lists what is
proven live, what the factory gets for free, and what is still open.

## What exists and is proven live

| Piece | State | Where |
|-|-|-|
| **Runtime** | own journal on Postgres (`agent_workflows`): three step kinds, replay by step id, effect keys, leases with fencing, cancel/steer, recovery tick, bounded runs; survives a redeploy mid-run | `packages/runtime`, concept §3 |
| **Middleware** | `run/pre … run/post` on every workflow and step: run record and fingerprint, `purpose` tag, spans to ClickStack, usage outbox to Argo, runaway caps, wallet gate | `packages/middleware`, `packages/limits`, §4–§5 |
| **Routes** | the only home of model ids; per-route effort, fallback on provider balance (402/503) | `packages/routes`, `agw routes` |
| **Capabilities** | one zod definition = import, HTTP and CLI; `internal` for in-process only | `packages/capabilities`, v3.10 |
| **OpenCode host** | one pinned build (`make install-opencode`), deny-by-default sessions, a host-wide tool gate, re-attach across server restarts | `packages/opencode-host`, §8 |
| **CLI** | `agw`, generated from the registry; `--format json\|plain`, idempotency keys, `run status\|wait\|cancel` | `packages/cli`, §9 |
| **Evals** | scorers, `agw eval run\|compare`, reproducibility check before a set judges, friction counters, `agw retrospective`, learnings | `packages/eval`, §6–§7 |
| **Audio** | its own process, OpenAI-compatible TTS/STT door with per-caller tokens (Hermes, MacWhisper, iris) | `packages/audio` |
| **Deploy** | release directories with rollback, fail-closed on the secrets cache, `make verify` proves a priced run end to end | AGENTS.md §Validate / Deploy / Verify |

Workflows on it: review, check, research, otel, brain, diagram, prose (+ polish, gate), image, image-icon, podcast,
narrative, overview, triage, decide, eval, retrospective, learnings, smoke. Callers: Claude Code
skills, Hermes, iris, Argo (overview, usage), usage-tracker (runtimes outside the platform only).

## What a factory station gets for free

- **Durability.** A station that is a workflow resumes after a crash or deploy at its last journaled
  step. Long agent steps re-attach; liveness is an idle watchdog, not a ceiling (D5).
- **Cost and trace per run.** Every run is priced (or "cost unknown", never 0), traced, tagged with
  `purpose` and caller, and projected to Argo. No station writes its own usage code.
- **Model choice by name.** A station asks for a route, never a model id; fallback is per route.
- **Measurement.** A station with an eval set can answer a model or prompt question with numbers in
  one `eval compare`. Write the decision rule before the first run (Waves 6–7).
- **One door.** Claude Code and Hermes reach a new station the day it registers: the CLI is generated.

## Rules the build learned (carry them into the factory)

- **Verify before building.** Three times the inventory was wrong in the cheap direction (Argo
  projection already right, iris needed no port) and twice in the expensive one (the platform itself
  depended on agent-gateway's OpenCode build; MacWhisper was an undocumented caller). Read access logs
  for callers, not only code.
- **Pre-registered rules turn verdicts into queries.** Name the aggregation (per item vs mean).
- **A design change beats patch rounds.** When a review round finds the same class twice, re-brief.
- **Live criteria catch what tests pass.** Best-effort steps need one; so do JSON shapes quoted in docs.
- **Registration by directory**, never a shared registry file: it removed the merge collisions.
- **The lead's review on Max is the review step.** Security reviews changed designs, not only diffs.
- **Load is the fleet's main flake source.** The mini runs at load 60–120 when several fleets work;
  tests scale their timeouts by load, and a red test in an untouched file is re-run before it blocks.

## Open, not built

- **Promote-after-gate for OpenCode upgrades** (#67 review): today `install-opencode` switches `current`
  before `make verify` has seen the new build.
- **Review rework** (owner: later, outside this plan): recall is low on the paired set (Haiku angles
  0.017, Sonnet 0.13 at 9.4× cost); OCR paused until the owner re-enables it.
- **IU constraint**: the DeepSeek provider balance; routes fall back, the gateway `/review` is off for
  the fleet until lifted.
- **One shared OpenCode server and IU key** for every agent stays an accepted risk (v3.2).
- **No multi-host story.** Everything runs on the mini; the VPS hosts nothing of the platform.
