# @agent-workflows/routes

The route table: the **only place model ids live** in this repo (concept §4 Money, §5 fingerprint,
§8). Agent steps, capabilities and evals name a route id (`cheap.classify`, `decide`,
`review.angle`, …) and resolve it here. `src/guard.test.ts` fails with `file:line` when any other
package's `src/**` contains a model id from the table. No network calls.

```ts
import { resolveRoute, routeFingerprint, costFromUsage } from '@agent-workflows/routes'

const route = resolveRoute('cheap.classify') // { id, wire, model, effort?, maxOutputTokens?, rate? }
routeFingerprint('cheap.classify') // sha256 hex of the resolved entry, overrides included
costFromUsage(route.wire, usage, route.rate) // { usd, source: 'provider' | 'rate' | 'unknown' }
```

`resolveRoute` and `routeFingerprint` take a `RouteId` (the table's keys); `resolveRoute` returns a copy, so mutating it changes nothing shared. An unknown id from an untyped caller throws `UnknownRouteError`; a bad override throws `RouteOverrideError`.

## Entry

| Field | Meaning |
|-|-|
| `wire` | `iu-openai` (IU chat completions), `iu-anthropic` (native Messages), `iu-decision` (IU decision API), `opencode` (agent step on the OpenCode host) |
| `model` | the provider's model id |
| `effort` | `none\|low\|medium\|high\|xhigh\|max`. Absent when the model exposes none |
| `maxOutputTokens` | output ceiling; reasoning tokens count against it |
| `rate` | `{ inputPerM, outputPerM }` USD, only for wires whose provider reports no cost |

`iu-decision` entries take neither `effort` nor `maxOutputTokens`.

## Overrides

One variable, `AGW_ROUTES`, holds a JSON object of per-route patches:

```sh
AGW_ROUTES='{"review.angle":{"model":"<model-id>","effort":"high"},"cheap.classify":{"maxOutputTokens":null}}'
```

- A patch may set `model`, `effort`, `maxOutputTokens` (at most 200000) and `rate`; `null` clears an optional field. It is merged over the table entry and the result is validated like a table entry.
- **`wire` cannot be overridden** (`RouteOverrideError`): a route's transport is code, overrides are for model, effort, limit and rate experiments.
- Every patch is checked on every `resolveRoute`, not only the requested route. A route id that is not in the table, malformed JSON or an invalid result is a `RouteOverrideError`.
- Changing `model` without supplying a new `rate` drops the old rate, so cost reads `unknown` instead of a stale number.
- The variable is parsed on every call; `resolveRoute(id, env)` takes an explicit env for tests.
- Overrides never touch the table and are part of the fingerprint.

## Cost

`costFromUsage` returns the provider's `usage.cost` when present and valid (`source: 'provider'`, a reported `0` stays `0`). Otherwise it prices the route's `rate` (`source: 'rate'`): input excluding cache tokens at `inputPerM`, cache reads at `cacheReadPerM`, cache writes at `cacheWritePerM`, output at `outputPerM` (reasoning tokens are already in the output count). Cache tokens against a rate without the matching cache rate, or neither cost nor rate, return `{ usd: null, source: 'unknown' }`: never free, never 0. `input_tokens` (Anthropic) excludes cache tokens; `prompt_tokens` and `inputTokens` include them.

Cache counts above the cache-inclusive prompt total, and prompts above 100K tokens (input including cache), also return `unknown`: the vendor bills a higher tier that `Rate` does not model, so the call is never under-priced.

Rates are carried by every single-call route whose wire reports no cost: `decide` (the decision API drops IU's cost; UE price list in agent-gateway's `decision.ts`) and the Haiku 5.5 EU routes on `iu-anthropic` (`cheap.summarize`, `cheap.title`): $0.10 in, $0.50 out, $0.01 cache read, $0.125 cache write per million. Source: agent-gateway `server/lib/models.ts`, `claude-haiku-5-5-eu` (hermes-agent `docs/model-context-reasoning.md`, vendor list; cache write 1.25x input), dated 2026-10-14. The `opencode` routes (`review.angle`, `review.synthesis`, `check`) carry no rate: an agent step's cost is OpenCode's message cost, with no fallback. The `iu-openai` routes (deepseek) carry no rate: IU reports `usage.cost` on that wire.

## Source seats (agent-gateway `GET /api/routing`, 2026-10-27)

Model ids and efforts are what agent-gateway resolves today. None of these seats sets an effort: Haiku 5.5 EU exposes no variants and the single-shot calls send none.

| Route | agent-gateway seat | Model | Wire |
|-|-|-|-|
| `cheap.classify` | `triage` (SINGLE_SHOT) | deepseek-v4.1-flash | iu-openai |
| `cheap.summarize` | `overview` (CLASSIFY) | claude-haiku-5-5-eu | iu-anthropic |
| `cheap.title` | `narrative` (CLASSIFY) | claude-haiku-5-5-eu | iu-anthropic |
| `decide` | `DEFAULT_DECISION_MODEL` | pplx-decider-v1-27b | iu-decision |
| `review.router` | `review_router` (SINGLE_SHOT) | deepseek-v4.1-flash | iu-openai |
| `review.adversary` | `adversary` | deepseek-v4.1-flash | iu-openai |
| `review.angle` | `review_angle_senior_dev`, `_typescript`, `_frontend`, `_qa` (ANGLE_OC, identical) | claude-haiku-5-5-eu | opencode |
| `review.synthesis` | `review` (CLASSIFY) | claude-haiku-5-5-eu | opencode |
| `check` | `check` (CLASSIFY) | claude-haiku-5-5-eu | opencode |

Deliberate differences from the gateway:

- `cheap.summarize` and `cheap.title` run in the gateway as a Haiku 5.5 EU OpenCode session. As cheap single-shots they use the native Messages wire with the same model. There is no separate title seat there; `narrative` is the closest.
- `maxOutputTokens: 16000` is the floor `single-shot.ts` sends for reasoning models.
- Not ported: the Max-lane fallback (`fallback: sonnet` on Max), `prose_*`, `read_image`, `review_ocr`, dispatch and otel seats. They belong to the Claude runtime or to later waves.
- The `decide` rate is the UE price list from `decision.ts`.

## Token effect / cache effect

A route flip changes what the next run costs and how well it caches:

- **Model change on a route with a rate** (`decide`): tokens are priced at the new rate, or `unknown` if the override supplies none.
- **Model change in general:** the provider prompt cache is per model, so the first run after a flip pays full input price. Haiku 5.5 EU reports cache reads; DeepSeek on `iu-openai` reports `cached_tokens`; cost from `usage.cost` already reflects both.
- **Effort up** (`high`, `max`): more reasoning tokens, billed as output, counted against `maxOutputTokens`. Raise the ceiling with it or the answer starves.
- **Wire change** (for example `iu-openai` → `iu-anthropic`): different usage keys and cache semantics. `costFromUsage` accepts both shapes, but the cache hit rate starts from zero.
- **Haiku 5.5 EU** bills 5x above 100K prompt tokens per request; a long agent episode costs more than the list rate suggests, and `costFromUsage` returns `unknown` for a single call over that size.
- The fingerprint changes on any of these, so runs before and after a flip never share a group.
