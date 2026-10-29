# @agent-workflows/routes

The route table: the **only place model ids live** in this repo (concept §4 Money, §5 fingerprint,
§8). Agent steps, capabilities and evals name a route id (`cheap.classify`, `decide`,
`review.angle`, …) and resolve it here. `src/guard.test.ts` fails with `file:line` when any source outside
`src/table/` (other packages' `src/**`, this package's non-test files) contains a model id from the table. No network
calls.

```ts
import { resolveRoute, routeFingerprint, costFromUsage } from '@agent-workflows/routes'

const route = resolveRoute('cheap.classify') // { id, wire, model, effort?, maxOutputTokens?, rate?, fallback? }
fallbackRoute(route) // the fallback as a route of the same id (isFallback: true), or undefined
isBalanceFailure({ status: 503, text: body }) // the provider-balance classifier
routeFingerprint('cheap.classify') // sha256 hex of the resolved entry, overrides included
costFromUsage(route.wire, usage, route.rate) // { usd, source: 'provider' | 'rate' | 'unknown' }
```

`resolveRoute` and `routeFingerprint` take a `RouteId` (the table's keys, typed: see §Table); `resolveRoute` returns a copy, so mutating it changes nothing shared. An unknown id from an untyped caller throws `UnknownRouteError`; a bad override throws `RouteOverrideError`.

## Table

`src/table/<group>.ts`, one file per workflow or capability group (`review.ts`, `check.ts`, `cheap.ts`, ...), each
default-exporting its entries; `src/table/_shared.ts` holds the rates and fallbacks several groups use
(`HAIKU_55_RATE`, `SONNET_55_RATE`, `CALL_FALLBACK`, `AGENT_FALLBACK`). `discoverRoutes(dir)` imports every
`*.ts` there in sorted order (only `_shared.ts` and `*.test.ts` skipped; any other file is a group) once per process; `DEFAULT_ROUTES` is the result,
validated and deeply frozen. An empty directory, a default export that is not an object, an invalid id or entry, or a
route id a second file declares fails the import, naming the file.

Route ids stay typed though the table is discovered: each group file adds its ids to the `RouteTable` interface by
module augmentation, and `RouteId = keyof RouteTable`, so a typo in a caller is a compile error. `guard.test.ts` holds
every group to that shape (`export default routes` plus the augmentation over `keyof typeof routes`, so the typed key
set is the exported one by construction; a type cannot be listed at runtime to compare) and to importing only
`../schema.ts` and `./_shared.ts`, so the table's top-level await can never wait on an import cycle. It also checks that
every route literal in a route position under `packages/*/src` (`route:`, `routeId:`, `resolve(deps, …)`,
`resolveRoute(…)`, `*_ROUTE[: RouteId] = …`) is a route the table serves: that covers call-time routes such as a step's untyped
`options.route`. The host also checks at
boot that every agent a workflow lists runs on a route the table has (`packages/host/README.md` §Adding a workflow).

A new workflow's routes are a new group file, ending with the augmentation (copy it from any group):

```ts
import type { RouteEntry } from '../schema.ts'
import { AGENT_FALLBACK, HAIKU_55_RATE } from './_shared.ts'

const routes = {
  'audio.agent': { wire: 'opencode', model: '<model-id>', rate: HAIKU_55_RATE, fallback: AGENT_FALLBACK },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
```

`_shared.ts` is imported, never edited by a port: a rate only one group uses lives in that group's file. A group's
seat provenance (which legacy seat it copies, and why) is its file's comments and its workflow's README.

## Entry

| Field | Meaning |
|-|-|
| `wire` | `iu-openai` (IU OpenAI dialect: chat completions, `/audio/transcriptions`), `iu-anthropic` (native Messages), `iu-decision` (IU decision API), `opencode` (agent step on the OpenCode host), `iu-gemini` (native Gemini TTS), `iu-replicate` (Replicate predictions) |
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

Cache counts above the cache-inclusive prompt total return `unknown`. One rule for size: a rate without `longPrompt` has no tier and is priced flat at any size; a rate with `longPrompt: { inputMultiplier, outputMultiplier }` (and the `longPromptTokens` it starts above, required with it) prices a request whose prompt (input including cache, per request) is above that size at the tier: the whole request, input, cache read and cache write at `inputMultiplier` times their rate, output at `outputMultiplier` times. Haiku 5.5 is `5 / 5` over 100K (Anthropic pricing page, read 2026-10-29: "a request over the threshold pays the higher prices even when part of its prompt is a cache hit"), Terra `2 / 1.5` over 272K. The threshold is exclusive: exactly 100K is the base card.

Rates are carried by every route whose wire reports no cost: `decide` (the decision API drops IU's cost; UE price list in agent-gateway's `decision.ts`), the Haiku 5.5 routes on `iu-anthropic` (`cheap.summarize`, `cheap.title`) and the Haiku 5.5 routes on `opencode` (`review.angle`, `review.synthesis`, `check`, `retro.analyze`, `diagram.agent`): $0.10 in, $0.50 out, $0.01 cache read, $0.125 cache write per million. Source: the Anthropic pricing page (platform.claude.com/docs/en/about-claude/pricing), read 2026-10-29, which lists one Haiku 5.5 card (the retired region-pinned id carried the same numbers); cache write is the 5-minute 1.25x input. Above 100K prompt tokens the whole request bills 5x on every column (`longPrompt`). On the `opencode` wire the OpenCode host writes the rate into the server config's cost rows, so OpenCode prices each message with it; a message OpenCode reports at cost 0 with tokens is priced with the rate by the host (`costFromUsage`), else `unknown`. `review.angle.deep` carries the Sonnet 5.5 EU list rate: $2.00 in, $10.00 out, $0.10 cache read (0.05x), $2.50 cache write (5-minute, 1.25x) per million (Anthropic pricing page, read 2026-10-29). The page lists no long-context tier for Sonnet 5.5, so its rate has no `longPrompt` and is flat at any size (before 2026-10-29 a 100K default applied to every rate and priced 13 deep-review steps `unknown`). The `iu-openai` routes (deepseek) carry no rate: IU reports `usage.cost` on that wire. `research.agent` runs deepseek on `opencode`, where IU's `usage.cost` never reaches the host, so it carries the rate that cost was measured at: $0.30 in, $0.006 cache read, $1.20 out per million (research-gateway `src/lib/cost.ts`, the 2026-09-25 peak reading; an off-peak reading was half, so off-peak runs are over-priced, never under-priced).

The fallback (GPT-6.1 Terra) carries a rate on every route: $1.00 in, $0.05 cached in, $5.00 out, $1.25 cache write (30-min) per million, Standard tier, and a `longPrompt` tier over 272K input tokens: the whole request bills 2x input/cache and 1.5x output. Context 1,050,000, max output 128,000, effort `none|low|medium|high|xhigh|max`. Source: developers.openai.com (via /research) and a probe of IU's OpenAI endpoint (listed in `/models`, chat completions with `reasoning_effort: medium` answered 200, served as `openai.gpt-6.1-terra`), 2026-10-28.

## Source seats (agent-gateway `GET /api/routing`, 2026-10-27)

The capability seats (`src/table/cheap.ts`, `decide.ts`); a workflow's seats are in its README's §Route
(`packages/host/src/workflows/<id>/README.md`). Model ids and efforts are what agent-gateway resolves today. None of these seats sets an effort: Haiku 5.5 exposes no variants and the single-shot calls send none.

| Route | agent-gateway seat | Model | Wire |
|-|-|-|-|
| `cheap.classify` | `triage` (SINGLE_SHOT) | claude-haiku-5-5 | iu-openai |
| `cheap.summarize` | `overview` (CLASSIFY) | claude-haiku-5-5 | iu-anthropic |
| `cheap.title` | `narrative` (CLASSIFY) | claude-haiku-5-5 | iu-anthropic |
| `decide` | `DEFAULT_DECISION_MODEL` | decision-1 | iu-decision |
| `triage` | `triage` (SINGLE_SHOT) | claude-haiku-5-5 | iu-anthropic |

Deliberate differences from the gateway:

- `cheap.summarize` and `cheap.title` run in the gateway as a Haiku 5.5 OpenCode session. As cheap single-shots they use the native Messages wire with the same model. There is no separate title seat there; `narrative` is the closest.
- `maxOutputTokens: 16000` is the floor `single-shot.ts` sends for reasoning models.
- Not ported: the Max-lane fallback (`fallback: sonnet` on Max), `prose_*`, `read_image`, `review_ocr` and dispatch seats (`otel` is `otel.agent`). They belong to the Claude runtime or to later waves.
- The `decide` rate is the UE price list from `decision.ts`. The gateway's default `pplx-decider-v1-27b` is served by IU's "Requesty decision compatibility API" (`x-middleware-forwarded-server`, probed 2026-10-29), so `decide` runs `decision-1` (Microsoft; header "Global Sink Sweden Decisions API"): same wire, request shape and 60k-character cap, input-only rate $0.042/M. Its confidences are calibrated by another model; a caller that thresholds on them re-checks the threshold.
- No route is region-pinned and none goes via Requesty (owner direction, 2026-10-29). A route is judged by the response header `x-middleware-forwarded-server`, not by its id: `deepseek-v4.1-flash`, `DeepSeek-V4-Flash` and `pplx-decider-v1-27b` all answer from Requesty-Global, and the one non-Requesty DeepSeek id the model list shows (`deepseek-ai/DeepSeek-V3.2`, Nebius) answers "model does not exist". The retired `-eu` Claude ids are no longer listed; `claude-haiku-5-5` and `claude-sonnet-5-5` answer from IU's LiteLLM gateway (chat wire) and AWS Bedrock (Messages wire), at the same list price (the pricing page has one card).
- `triage` and `cheap.classify` run Haiku 5.5, `triage` on the native Messages wire and `cheap.classify` on the chat wire with JSON mode (IU reports no `usage.cost` there; the route carries the rate). `triage` has no fallback (parity with its Wave 7 port; Terra is not on Requesty, so one could be added); `decide` has none either.
- `review.router` and `review.ocr` run Haiku 5.5 on the chat wire, fallback Terra. `review.adversary` is the cross-family critic, so it runs `gpt-6.1-terra` (medium effort, chat wire, rate carried), fallback Haiku 5.5 (a Terra fallback would be Terra). Deliberate: on a provider-balance failure the critique comes from the writer's family rather than not at all.
- `research.agent`, `otel.agent`, `prose.review` and the podcast routes still run `deepseek-v4.1-flash`, which is Requesty-Global; their pre-registered port rules ran on that model, so they move by the lead's decision, not in this sweep.

## Token effect / cache effect

A route flip changes what the next run costs and how well it caches:

- **Model change on a route with a rate** (`decide`): tokens are priced at the new rate, or `unknown` if the override supplies none.
- **Model change in general:** the provider prompt cache is per model, so the first run after a flip pays full input price. Haiku 5.5 reports cache reads; DeepSeek on `iu-openai` reports `cached_tokens`; cost from `usage.cost` already reflects both.
- **Effort up** (`high`, `max`): more reasoning tokens, billed as output, counted against `maxOutputTokens`. Raise the ceiling with it or the answer starves.
- **Wire change** (for example `iu-openai` → `iu-anthropic`): different usage keys and cache semantics. `costFromUsage` accepts both shapes, but the cache hit rate starts from zero.
- **A fallback** runs on another model: its first call pays full input price (the cache is per model), at Terra's rate, which is 10x Haiku 5.5's input and output. It only runs while the primary's provider is out of balance.
- **Haiku 5.5** bills 5x above 100K prompt tokens per request; a long agent episode costs more than the list rate suggests. `costFromUsage` prices a single call over that size at the tier; OpenCode's own per-message cost knows only the base card, so the OpenCode host re-prices a message over the threshold with the rate (`priceOpenCodeMessages`).
- The fingerprint changes on any of these, so runs before and after a flip never share a group.
