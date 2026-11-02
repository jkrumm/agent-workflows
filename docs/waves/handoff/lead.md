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

No `~/.config/agw/routes.json` on the mini at start; `AGW_ROUTES` unset in the host's env.
