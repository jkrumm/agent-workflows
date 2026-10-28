# @agent-workflows/routes

The route table: the **only place model ids live** in this repo (concept §4 Money, §5 fingerprint,
§8). Agent steps, capabilities and evals name a route id (`cheap.classify`, `decide`,
`review.angle`, …) and resolve it here. `src/guard.test.ts` fails with `file:line` when any other
package's `src/**` contains a model id from the table. No network calls.

```ts
import { resolveRoute, routeFingerprint, costFromUsage } from '@agent-workflows/routes'

const route = resolveRoute('cheap.classify') // { id, wire, model, effort?, maxOutputTokens?, rate?, fallback? }
fallbackRoute(route) // the fallback as a route of the same id (isFallback: true), or undefined
isBalanceFailure({ status: 503, text: body }) // the provider-balance classifier
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
| `rate` | `{ inputPerM, outputPerM, cacheReadPerM?, cacheWritePerM?, longPromptTokens? }` USD per million; the provider's `usage.cost` wins where it sends one |
| `fallback` | a full route spec (`wire`, `model`, `effort?`, `maxOutputTokens?`, `rate?`) the call moves to once on a provider-balance failure (below) |

`iu-decision` entries take neither `effort` nor `maxOutputTokens`. A fallback runs the same kind of step: an `opencode` route falls back to `opencode`, a single call to a single call (its wire may differ: `iu-anthropic` routes fall back over `iu-openai`).

## Fallback on provider balance

Owner direction 2026-10-28: a route that fails because the provider account is empty falls back instead of failing.

- **Trigger:** `isBalanceFailure` (`src/balance.ts`), the one classifier: HTTP 402, or 503 whose body says "Insufficient Balance" or "PaymentRequired" (IU today: `IU request failed (503) — Insufficient Balance (PaymentRequired) on <provider>`). Without a status (an OpenCode turn error, a step's failure reason, `ocr`'s stderr) `BALANCE_MARKER` (`provider balance exhausted`, written by the transports), IU's body shape `Insufficient Balance (PaymentRequired)`, or a `402` token together with "payment required" / "insufficient balance" count; a 402 or the wording alone does not. The classifier is never fed diff text: review's failure reasons carry none (zod schema messages hold no values, OpenCode turn errors are the provider's). Any other error keeps its usual handling.
- **Once:** the capability transports fail fast on it (no retry loop on the primary) and the call runs once on `fallbackRoute(route)`; the OpenCode host reopens a step whose turn was refused before it did anything on the fallback route, once (`packages/opencode-host` README); review's OCR child reruns `ocr` once. A failing fallback answers the primary's error. The usage records the model that actually ran.
- **Default:** every `iu-openai`, `iu-anthropic` and `opencode` route falls back to GPT-6.1 Terra (`gpt-6.1-terra`), effort `medium`, `maxOutputTokens` 32000: over `iu-openai` for single calls, on `opencode` for agent steps (the host speaks the Responses API to it: tool calls need it). `decide` has none.
- **Overrides:** `AGW_ROUTES` patches a fallback like a primary: `{"cheap.classify": {"fallback": {"model": "<model-id>", "effort": "high"}}}` (merged over the table's fallback; a new model without a rate drops the rate) and `{"cheap.classify": {"fallback": null}}` removes it. A route without a fallback cannot gain one through the variable, and a fallback's `wire` cannot be overridden.
- **Price:** the fallback carries its own rate (below); `usage.cost`, when IU sends it, wins as on any route.

## Overrides

One variable, `AGW_ROUTES`, holds a JSON object of per-route patches:

```sh
AGW_ROUTES='{"review.angle":{"model":"<model-id>","effort":"high"},"cheap.classify":{"maxOutputTokens":null}}'
```

- A patch may set `model`, `effort`, `maxOutputTokens` (at most 200000), `rate` and `fallback` (a patch of the same fields, or `null`); `null` clears an optional field. It is merged over the table entry and the result is validated like a table entry.
- **`wire` cannot be overridden** (`RouteOverrideError`): a route's transport is code, overrides are for model, effort, limit and rate experiments.
- Every patch is checked on every `resolveRoute`, not only the requested route. A route id that is not in the table, malformed JSON or an invalid result is a `RouteOverrideError`.
- Changing `model` without supplying a new `rate` drops the old rate, so cost reads `unknown` instead of a stale number.
- The variable is parsed on every call; `resolveRoute(id, env)` takes an explicit env for tests.
- Overrides never touch the table and are part of the fingerprint.

## Cost

`costFromUsage` returns the provider's `usage.cost` when present and valid (`source: 'provider'`, a reported `0` stays `0`). Otherwise it prices the route's `rate` (`source: 'rate'`): input excluding cache tokens at `inputPerM`, cache reads at `cacheReadPerM`, cache writes at `cacheWritePerM`, output at `outputPerM` (reasoning tokens are already in the output count). Cache tokens against a rate without the matching cache rate, or neither cost nor rate, return `{ usd: null, source: 'unknown' }`: never free, never 0. `input_tokens` (Anthropic) excludes cache tokens; `prompt_tokens` and `inputTokens` include them.

Cache counts above the cache-inclusive prompt total, and prompts above the rate's `longPromptTokens` (input including cache; default 100K, the Anthropic-family step), also return `unknown`: the vendor bills a higher tier that `Rate` does not model, so the call is never under-priced.

Rates are carried by every route whose wire reports no cost: `decide` (the decision API drops IU's cost; UE price list in agent-gateway's `decision.ts`), the Haiku 5.5 EU routes on `iu-anthropic` (`cheap.summarize`, `cheap.title`) and the Haiku 5.5 EU routes on `opencode` (`review.angle`, `review.synthesis`, `check`, `retro.analyze`): $0.10 in, $0.50 out, $0.01 cache read, $0.125 cache write per million. Source: agent-gateway `server/lib/models.ts`, `claude-haiku-5-5-eu` (hermes-agent `docs/model-context-reasoning.md`, vendor list; cache write 1.25x input), dated 2026-10-14. On the `opencode` wire the OpenCode host writes the rate into the server config's cost rows, so OpenCode prices each message with it; a message OpenCode reports at cost 0 with tokens is priced with the rate by the host (`costFromUsage`), else `unknown`. The `iu-openai` routes (deepseek) carry no rate: IU reports `usage.cost` on that wire.

The fallback (GPT-6.1 Terra) carries a rate on every route: $1.00 in, $0.05 cached in, $5.00 out, $1.25 cache write (30-min) per million, Standard tier, and `longPromptTokens: 272000`: above 272K input tokens the whole request bills 2x input/cache and 1.5x output, which `Rate` does not model, so such a call is `unknown`. Context 1,050,000, max output 128,000, effort `none|low|medium|high|xhigh|max`. Source: developers.openai.com (via /research) and a probe of IU's OpenAI endpoint (listed in `/models`, chat completions with `reasoning_effort: medium` answered 200, served as `openai.gpt-6.1-terra`), 2026-10-28.

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
| `retro.analyze` | none (new; copied from `check`, concept §7) | claude-haiku-5-5-eu | opencode |

Deliberate differences from the gateway:

- `cheap.summarize` and `cheap.title` run in the gateway as a Haiku 5.5 EU OpenCode session. As cheap single-shots they use the native Messages wire with the same model. There is no separate title seat there; `narrative` is the closest.
- `maxOutputTokens: 16000` is the floor `single-shot.ts` sends for reasoning models.
- Not ported: the Max-lane fallback (`fallback: sonnet` on Max), `prose_*`, `read_image`, `review_ocr`, dispatch and otel seats. They belong to the Claude runtime or to later waves.
- The `decide` rate is the UE price list from `decision.ts`.

## Token effect / cache effect

`retro.analyze` is a new seat (the weekly retrospective's one agent step) on `check`'s model and wire: a cheap Haiku-class call, no new cache group beyond its own agent.

A route flip changes what the next run costs and how well it caches:

- **Model change on a route with a rate** (`decide`): tokens are priced at the new rate, or `unknown` if the override supplies none.
- **Model change in general:** the provider prompt cache is per model, so the first run after a flip pays full input price. Haiku 5.5 EU reports cache reads; DeepSeek on `iu-openai` reports `cached_tokens`; cost from `usage.cost` already reflects both.
- **Effort up** (`high`, `max`): more reasoning tokens, billed as output, counted against `maxOutputTokens`. Raise the ceiling with it or the answer starves.
- **Wire change** (for example `iu-openai` → `iu-anthropic`): different usage keys and cache semantics. `costFromUsage` accepts both shapes, but the cache hit rate starts from zero.
- **A fallback** runs on another model: its first call pays full input price (the cache is per model), at Terra's rate, which is 10x Haiku 5.5 EU's input and output. It only runs while the primary's provider is out of balance.
- **Haiku 5.5 EU** bills 5x above 100K prompt tokens per request; a long agent episode costs more than the list rate suggests, and `costFromUsage` returns `unknown` for a single call over that size.
- The fingerprint changes on any of these, so runs before and after a flip never share a group.
