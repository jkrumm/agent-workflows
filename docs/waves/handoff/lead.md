# Lead handoff — Wave 5 (Eval foundations): IN FLIGHT

Lead `agent-workflows-w1-r8` (pane t73), started 2026-11-02. Briefs on the mini (not in git):
`~/.local/state/agent-workflows/briefs/gw5/`. Branch prefix `gw5/`. Wave 4's close-out is in git history (`509c79e`).

## Batches

The five steps are not file-disjoint (model-call.ts, runtime scope.ts, opencode-host host.ts, routes are shared), so
two batches, each brief owning named functions in the shared files:

| Batch | Branch | Step | Worker |
|-|-|-|-|
| 1 | `gw5/eval-children` | eval cost roll-up (case runs become children; a run's cost includes its children) | Opus (deep), t74 |
| 1 | `gw5/agent-json` | structured agent output (OpenCode 2.0.32 structured output or a submit tool; `parseStructured` deleted) | Opus (deep), t75 |
| 1 | `gw5/json-schema-wire` | json_schema on the `anthropic` and `iu-openai` wires; Sonnet effort `none` refused | Sonnet, t76 |
| 1 | `gw5/model-route-ids` | `canonicalModel`, `steps.route` (migration 0013) | Sonnet, t77 |
| 2 | `gw5/run-arms` | run-scoped arms (`runs.arm`, migration 0014), `AGW_ROUTES`/`routes.json` removed | Opus, after batch 1 lands (needs child case runs) |

**Batch 1 landed and live** (release `ca6181c`, `make verify` PASS, smoke review `01a19c0e-146a-…` $0.0861): #100 model/route
ids, #99 json_schema wire, #101 agent JSON via `submit_result`, #102 eval children + tree cost. Live: a 2-case
`factory-classify` eval `01a19c0f-0a41-…` costs $0.000640 = its two child case runs ($0.000320 each, gateway rows
`api_credit` iu at the same figures); review steps carry `route` and canonical models. Batch 2 (`gw5/run-arms`) spawned on
`ca6181c`, pane t7k.

No `~/.config/agw/routes.json` on the mini at start; `AGW_ROUTES` unset in the host's env.

## Outside Wave 5, in this train

- `fv-agw-digest` (software-factory lead's worker, track FV, new files under `packages/host/src/workflows/digest/`, plan
  `docs/waves/fv-digest.md`): the factory lead reviews it and tells this lead; this lead reads the diff, merges and deploys
  it. It rebases onto Wave 5 as landed (route resolution changes with `gw5/run-arms`).
