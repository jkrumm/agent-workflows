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

The host serves the resolved table (`AGW_ROUTES` applied) as `agw routes` (`GET /routes`, unjournaled): per route id the wire, model, effort, fallback, rate and price; `--format plain` is a compact table.

## Table

`src/table/<group>.ts`, one file per workflow or capability group (`review.ts`, `check.ts`, `cheap.ts`, ...), each
default-exporting its entries; `src/table/_shared.ts` holds the rates and fallbacks several groups use
(`TERRA_RATE`, `LUNA_RATE`, `DEEPSEEK_FLASH_RATE`, the seats, `CALL_FALLBACK`, `AGENT_FALLBACK`). `discoverRoutes(dir)` imports every
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
import { EASY, TERRA_LOW_AGENT_FALLBACK } from './_shared.ts'

const routes = {
  'audio.agent': { wire: 'opencode', ...EASY, fallback: TERRA_LOW_AGENT_FALLBACK },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
```

`_shared.ts` is imported, never edited by a port: a rate only one group uses lives in that group's file. A group's
seat provenance (which legacy seat it copies, and why) is its file's comments and its workflow's README.

## Seats

A text model is chosen once per role, in `src/table/_shared.ts`, and a route spreads the seat instead of naming the model. **The seats are Claude** (owner decision 2026-11-01, provisional until Waves 9–10) so the monthly credit is spent; the rate of each is `CLAUDE_RATES` (`claude.ts`, the one source):

| Seat | Model today | Routes |
|-|-|-|
| `TRIVIAL` | Haiku 5.5, effort none | `cheap.classify`, `cheap.title`, `factory.classify`, `audio.tts.prep` (the prep follows the route's wire), the image enhance planner (effort high) |
| `EASY` | Haiku 5.5, effort high | `cheap.summarize`, `cheap.extract`, `overview.classify`, `triage`, `review.router`, `review.ocr`, `check`, `brain.agent` |
| `STRONG` | Sonnet 5.5, effort medium | `review.angle`, `review.angle.deep`, `review.synthesis`, `prose.write`, `narrative`, the diagram and retro agents |
| `CHEAP` | DeepSeek flash | research, otel, the podcast stages, prose review |

Evidence (agw's 2026-10-31 eval, `docs/evals/2026-10-31-review-claude-direct.md`): Haiku at effort high is the Haiku knee, Haiku at max is unusable for agent steps. Sonnet at medium was not measured; `STRONG` was Terra medium until this change.

A single-call route on a Claude seat takes `wire: 'anthropic'` (native Messages on the gateway, which pays from the credit); an agent route stays on `opencode`. Both wires send `x-agw-fallback: none`, so a drained credit is a 402 (never a silent move onto IU's Claude) and the route's fallback runs. **The fallback is GPT on IU, by seat:**

| Primary | Fallback | Constant |
|-|-|-|
| `TRIVIAL` single call | Luna low on `iu-openai` | `LUNA_CALL_FALLBACK` |
| `EASY` single call | Terra low on `iu-openai` | `TERRA_LOW_CALL_FALLBACK` |
| `EASY` agent | Terra low on `opencode` (Responses API) | `TERRA_LOW_AGENT_FALLBACK` |
| `STRONG` single call | Terra medium on `iu-openai` | `CALL_FALLBACK` |
| `STRONG` agent | Terra medium on `opencode` | `AGENT_FALLBACK` |
| `CHEAP` (DeepSeek) call or agent | Terra medium, as the two above | `CALL_FALLBACK`, `AGENT_FALLBACK` |

The GPT models are named constants (`LUNA`, `TERRA_LOW`, `TERRA_MEDIUM`), not seats: a fallback spreads one, a route spreads a seat. `guard.test.ts` holds the shape: every route on `anthropic`, and every `opencode` route on a Claude model, has a fallback on a GPT model; no route on `iu-openai` or `opencode` falls back onto Claude; no `claude-` single call sits on `iu-openai`.

Two routes stay on GPT by design. `review.adversary` is pinned to `TERRA_MEDIUM`, not to `STRONG`: it is the cross-family critic and its capability refuses any wire but the OpenAI chat wire (a Claude critic of a Claude writer defeats it; fallback Luna medium). `podcast.write` is `TERRA_MEDIUM` at effort high, not `STRONG`, because `Llm.round`, the writer's tool loop, speaks only the OpenAI dialects (`packages/audio/src/workflows/podcast/iu.ts`); any route used through it stays on `iu-openai` (guarded), its fallback is DeepSeek flash. `prose.review` stays on `CHEAP` (its capability refuses a Claude model or any wire but `iu-openai`; fallback Terra medium). `agw routes` shows `default` in the effort column where no effort is sent (the vendor's own level), and `none` where thinking is off.

```ts
'cheap.title': { wire: 'anthropic', ...TRIVIAL, fallback: LUNA_CALL_FALLBACK },
'research.agent': { wire: 'opencode', ...CHEAP, maxOutputTokens: 16_000, fallback: AGENT_FALLBACK },
```

Moving every route of a role to another model, rate or effort is one edit to the seat. Effort and output limit after the spread override the seat for one route. The wire is the route's own (a transport is code, `AGW_ROUTES` cannot change it), so a seat that moves to another provider family also needs its routes' `wire` changed where the family speaks another dialect (the Claude seats did: single calls moved from `iu-openai` to `anthropic`). Specialist models stay in their group file: the TTS and STT voices, the image models, `decide`, the Gemini reviewer seat. Model ids stay under `src/table/` only (`guard.test.ts`).

## Entry

| Field | Meaning |
|-|-|
| `wire` | `iu-openai` (IU OpenAI dialect: chat completions, `/audio/transcriptions`), `anthropic` (native Messages on the gateway, which pays from a Claude credit pool or IU), `iu-decision` (IU decision API), `opencode` (agent step on the OpenCode host), `iu-gemini` (native Gemini TTS), `iu-replicate` (Replicate predictions) |
| `model` | the provider's model id |
| `effort` | `none\|low\|medium\|high\|xhigh\|max`. Absent when the model exposes none |
| `maxOutputTokens` | output ceiling; reasoning tokens count against it |
| `rate` | `{ inputPerM, outputPerM, cacheReadPerM?, cacheWritePerM?, longPromptTokens? }` USD per million; the provider's `usage.cost` wins where it sends one |
| `fallback` | a full route spec (`wire`, `model`, `effort?`, `maxOutputTokens?`, `rate?`) the call moves to once on a provider-balance failure (below) |

`iu-decision` entries take neither `effort` nor `maxOutputTokens`. A fallback runs the same kind of step: an `opencode` route falls back to `opencode`, a single call to a single call (its wire may differ: `anthropic` routes fall back over `iu-openai`, the rule for every Claude seat).

## Fallback on provider balance

Owner direction 2026-10-28: a route that fails because the provider account is empty falls back instead of failing.

- **Trigger:** `isBalanceFailure` (`src/balance.ts`), the one classifier: HTTP 402; 503 whose body says "Insufficient Balance" or "PaymentRequired" (IU today: `IU request failed (503) — Insufficient Balance (PaymentRequired) on <provider>`); or 400 whose body says "credit balance is too low to access the Anthropic API" (Anthropic's refusal of a drained Console org, a 400 `invalid_request_error`, not a 402), or which carries `BALANCE_MARKER` (the transports' own message, re-classified with its status; the body is cut to 300 chars, so the marker is what survives). Any other 400 is not balance. Without a status (an OpenCode turn error, a step's failure reason, `ocr`'s stderr) `BALANCE_MARKER` (`provider balance exhausted`, written by the transports), IU's body shape `Insufficient Balance (PaymentRequired)`, Anthropic's full sentence above, or a `402` token together with "payment required" / "insufficient balance" count; a 402 or the wording alone does not. The classifier is never fed diff text: review's failure reasons carry none (zod schema messages hold no values, OpenCode turn errors are the provider's). Any other error keeps its usual handling.
- **Once:** the capability transports fail fast on it (no retry loop on the primary) and the call runs once on `fallbackRoute(route)`; the OpenCode host reopens a step whose turn was refused before it did anything on the fallback route, once (`packages/opencode-host` README); review's OCR child reruns `ocr` once. A failing fallback answers the primary's error. The usage records the model that actually ran.
- **Default:** a Claude route falls back to GPT on IU by seat (Luna low, Terra low, Terra medium; §Seats), a DeepSeek route to GPT-6.1 Terra at effort medium, `review.adversary` to Luna medium, `decide` and the audio and image-model routes to nothing. Every fallback has `maxOutputTokens` 32000 (see §Seats). Claude routes lean on this: with the credit gone the gateway answers 402, so a Claude route without a fallback is a failed call.
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

Rates are carried by every text route whose wire reports no cost, from the seats in `src/table/_shared.ts`: `decide` (the decision API drops IU's cost; UE price list in agent-gateway's `decision.ts`), Terra ($1.00 in, $5.00 out, $0.05 cache read, $1.25 cache write per million, 2x input and 1.5x output above 272K prompt tokens: OpenAI price page via `/research` and a probe of the IU OpenAI endpoint, 2026-10-28), Luna ($0.10 in, $0.50 out, $0.01 cache read), and the Claude seats from `CLAUDE_RATES` (Haiku 5.5 and Sonnet 5.5; Haiku was dropped from the table on 2026-10-30 and came back as `TRIVIAL`/`EASY` on 2026-11-01, owner decision). On the `opencode` wire the OpenCode host writes the rate into the server config's cost rows, so OpenCode prices each message with it; a message OpenCode reports at cost 0 with tokens is priced with the rate by the host (`costFromUsage`), else `unknown`. IU bills DeepSeek at the list peak rate at every hour, off-peak included (billed over list 1.00 at 00:00-02:00 UTC, checked on 10 days of steps, 2026-10-30), so the rate below is what a call costs. `research.agent` runs deepseek on `opencode`, where IU's `usage.cost` never reaches the host, so it carries the rate that cost was measured at: $0.30 in, $0.006 cache read, $1.20 out per million (research-gateway `src/lib/cost.ts`, the 2026-09-25 peak reading; an off-peak reading was half, so off-peak runs are over-priced, never under-priced).

The Terra fallbacks (and the DeepSeek routes' fallback) carry a rate on every route: $1.00 in, $0.05 cached in, $5.00 out, $1.25 cache write (30-min) per million, Standard tier, and a `longPrompt` tier over 272K input tokens: the whole request bills 2x input/cache and 1.5x output. Context 1,050,000, max output 128,000, effort `none|low|medium|high|xhigh|max`. Source: developers.openai.com (via /research) and a probe of IU's OpenAI endpoint (listed in `/models`, chat completions with `reasoning_effort: medium` answered 200, served as `openai.gpt-6.1-terra`), 2026-10-28.

## Source seats (agent-gateway `GET /api/routing`, 2026-10-27, wires and models as of 2026-11-01)

The capability seats (`src/table/cheap.ts`, `decide.ts`); a workflow's seats are in its README's §Route
(`packages/host/src/workflows/<id>/README.md`). The agent-gateway column is where the seat came from; Model and Wire are the table today (the seats are Claude, §Seats), with the effort the seat sets (`TRIVIAL` none, `EASY` high).

| Route | agent-gateway seat | Model | Wire |
|-|-|-|-|
| `cheap.classify` | `triage` (SINGLE_SHOT) | claude-haiku-5-5 (none) | anthropic |
| `cheap.summarize` | `overview` (CLASSIFY) | claude-haiku-5-5 (high) | anthropic |
| `cheap.title` | `narrative` (CLASSIFY) | claude-haiku-5-5 (none) | anthropic |
| `decide` | `DEFAULT_DECISION_MODEL` | decision-1 | iu-decision |
| `triage` | `triage` (SINGLE_SHOT) | claude-haiku-5-5 (high) | anthropic |

Deliberate differences from the gateway:

- `cheap.summarize` and `cheap.title` run in the gateway as a Haiku 5.5 OpenCode session. As cheap single-shots they use the native Messages wire with the same model. There is no separate title seat there; `narrative` is the closest.
- `maxOutputTokens: 16000` is the floor `single-shot.ts` sends for reasoning models.
- Not ported: the Max-lane fallback (`fallback: sonnet` on Max), `prose_*`, `read_image`, `review_ocr` and dispatch seats (`otel` is `otel.agent`). They belong to the Claude runtime or to later waves.
- The `decide` rate is the UE price list from `decision.ts`. The gateway's default `pplx-decider-v1-27b` is served by IU's "Requesty decision compatibility API" (`x-middleware-forwarded-server`, probed 2026-10-29), so `decide` runs `decision-1` (Microsoft; header "Global Sink Sweden Decisions API"): same wire, request shape and 60k-character cap, input-only rate $0.042/M. Its confidences are calibrated by another model; a caller that thresholds on them re-checks the threshold.
- No route is region-pinned and none goes via Requesty (owner direction, 2026-10-29). A route is judged by the response header `x-middleware-forwarded-server`, not by its id: `deepseek-v4.1-flash`, `DeepSeek-V4-Flash` and `pplx-decider-v1-27b` all answer from Requesty-Global, and the one non-Requesty DeepSeek id the model list shows (`deepseek-ai/DeepSeek-V3.2`, Nebius) answers "model does not exist". The retired `-eu` Claude ids are no longer listed. The Claude seats go to the gateway's `anthropic` wire, which pays from a credit pool; IU's `claude-haiku-5-5` and `claude-sonnet-5-5` (LiteLLM on the chat wire, AWS Bedrock on Messages) are never a fallback: `x-agw-fallback: none` turns a drained credit into a 402 and the route's GPT fallback runs.
- `triage` and `cheap.classify` run Haiku 5.5 on the native Messages wire (the route carries the rate). `triage` gained a fallback, Terra low on the chat wire (it had none while a Requesty model was the only candidate); `decide` has none.
- `review.router` and `review.ocr` run Haiku 5.5 on the native Messages wire (`review/ocr.ts` speaks the `anthropic` protocol for it), fallback Terra low on the chat wire. `review.adversary` is the cross-family critic, so it stays on `gpt-6.1-terra` (medium effort, chat wire, rate carried), fallback Luna medium: a Claude critic of a Claude writer defeats it, and its capability refuses any wire but the OpenAI chat wire.
- `research.agent`, `otel.agent`, `prose.review` and the podcast routes still run `deepseek-v4.1-flash`, which is Requesty-Global; their pre-registered port rules ran on that model, so they move by the lead's decision, not in this sweep.

## Model ids

`canonicalModel(raw)` is the one id a model is recorded under. Providers echo the same model several ways (`openai.<id>`,
`vertex_ai_eu/<id>`, `deepseek/<id>`, a dated Claude snapshot, a `[1m]` suffix, an alias such as `sonnet`); the journal
(`steps.model`, `usage_by_model`) and the agent steps' usage take the canonical form, and each step also records its route id
(`steps.route`), so a report groups by route and model. An echo collapses only onto a model the table names (routes, fallbacks, the Claude models): the raw id first (a table id is
never cut, `<owner>/<name>` ids included), then the id with its one-segment provider prefix stripped, with a trailing
`-YYYY-MM-DD` snapshot date stripped (any family), both, each with a Claude snapshot date and `[1m]` removed, then a Claude
alias resolved. The first table model wins; otherwise the raw id comes back untouched, so `alice/<id>` and `bob/<id>` never
merge. The prefix is `PROVIDER_ECHO`, the regex `gatewayRecords` already used. The gateway keeps its own `rowModel` and writes its
rows as before.

## Token effect / cache effect

A route flip changes what the next run costs and how well it caches:

- **Model change on a route with a rate** (`decide`): tokens are priced at the new rate, or `unknown` if the override supplies none.
- **Model change in general:** the provider prompt cache is per model, so the first run after a flip pays full input price. Claude reports cache reads and writes; DeepSeek on `iu-openai` reports `cached_tokens`; cost from `usage.cost` already reflects both.
- **Effort up** (`high`, `max`): more reasoning tokens, billed as output, counted against `maxOutputTokens`. Raise the ceiling with it or the answer starves.
- **Wire change** (for example `iu-openai` → `anthropic`): different usage keys and cache semantics. `costFromUsage` accepts both shapes, but the cache hit rate starts from zero.
- **A fallback** runs on another model: its first call pays full input price (the cache is per model), at Terra's rate, which is 10x Haiku 5.5's input and output (Terra against Sonnet 5.5: half the input, half the output). It only runs while the primary's provider is out of balance.
- **Haiku 5.5** bills 5x above 100K prompt tokens per request; a long agent episode costs more than the list rate suggests. `costFromUsage` prices a single call over that size at the tier; OpenCode's own per-message cost knows only the base card, so the OpenCode host re-prices a message over the threshold with the rate (`priceOpenCodeMessages`).
- The fingerprint changes on any of these, so runs before and after a flip never share a group.

## Claude models

`src/table/claude.ts` holds the three current Claude models (`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`), their
list rates and the alias map `haiku | sonnet | opus`. It is a route group with no routes: the route table reaches Claude through the
seats in `_shared.ts`, which read their rates from `CLAUDE_RATES` here. The other user is the inference gateway (`docs/gateway.md`
§Model aliases, §Picking a pool), which resolves the alias a client sends and prices each Anthropic response.

```ts
import { claudeRate, CLAUDE_MODELS, costFromUsage, resolveModelAlias } from '@agent-workflows/routes'

resolveModelAlias('sonnet') // the Sonnet id; anything else (an id, 'Sonnet', 'gpt-x') comes back untouched
claudeRate('opus') // Rate | undefined, by id or alias; the shared, deeply frozen rate (not a copy)
costFromUsage('anthropic', usage, claudeRate(model)) // usage as Anthropic returns it
```

`claudeRate` takes an alias, a concrete id, or a dated snapshot / `[1m]` form of one (`claude-sonnet-5-5-20261001`); it returns the
shared, deeply frozen rate. `Rate.cacheWrite1hPerM` prices the 1-hour cache write (2x input; the 5-minute write, `cacheWritePerM`,
is 1.25x). `costFromUsage` reads Anthropic's `usage.cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens`:
`cache_creation_input_tokens` is the total, the 1h part is priced at the 1h rate and the rest as 5m; without the split every write is 5m.
The cost is `unknown` when the split contradicts the total (a negative or non-finite count, or 5m plus 1h above the total) and when a
call has 1h writes against a rate without `cacheWrite1hPerM`. Haiku 5.5 carries the long-prompt tier (5x over 100,000 prompt tokens, the
whole request; the pricing page's threshold, which overstates against the Admin API's 200k label, the safe side for the meter); Sonnet and
Opus 5.5 bill the full 1M context flat. Sources and dates are in the file.

The gateway passes `cache_creation` through, and so does capabilities' `toUsage`: the `anthropic` wire reads
`ephemeral_1h_input_tokens` into `Tokens.cacheWrite1h` and prices it at the 1h rate. The OpenCode pricing passes only
`cache_creation_input_tokens`, which is right as it stands: the pinned build asks for 5m writes only (plain
`{ "type": "ephemeral" }`, measured in `packages/opencode-host/test/live-gateway.test.ts`), so an agent step's writes
price at `cacheWritePerM`.
