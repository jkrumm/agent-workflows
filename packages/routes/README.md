# @agent-workflows/routes

The route table: the **only place model ids live** in this repo (concept §4 Money, §5 fingerprint,
§8). Agent steps, capabilities and evals name a route id (`cheap.classify`, `decide`,
`research.agent`, …) and resolve it here. `src/guard.test.ts` fails with `file:line` when any source outside
`src/table/` (other packages' `src/**`, this package's non-test files) contains a model id from the table. No network
calls.

```ts
import { resolveRoute, routeFingerprint, costFromUsage } from '@agent-workflows/routes'

const route = resolveRoute('cheap.classify') // { id, wire, model, effort?, maxOutputTokens?, rate?, fallback? }
fallbackRoute(route) // the fallback as a route of the same id (isFallback: true), or undefined
isBalanceFailure({ status: 503, text: body }) // the provider-balance classifier
routeFingerprint('cheap.classify') // sha256 hex of the resolved entry
resolveRoute('check', scope.arm?.routes) // inside a run: the table with the run's arm applied
validateArm(arm) // the whole arm checked at admission (`agw eval run --arm`)
costFromUsage(route.wire, usage, route.rate) // { usd, source: 'provider' | 'rate' | 'unknown' }
```

`resolveRoute` and `routeFingerprint` take a `RouteId` (the table's keys, typed: see §Table) and an optional patch (a run's arm's `routes`, §Arms); `resolveRoute` returns a copy, so mutating it changes nothing shared. An unknown id from an untyped caller throws `UnknownRouteError`; a bad patch throws `RouteOverrideError`.

The host serves the plain table as `agw routes` (`GET /routes`, unjournaled): per route id the wire, model, effort, fallback, rate and price; `--format plain` is a compact table.

## Table

`src/table/<group>.ts`, one file per workflow or capability group (`review.ts`, `check.ts`, `cheap.ts`, ...), each
default-exporting its entries; `src/table/_shared.ts` holds the rates and fallbacks several groups use
(the rates, the tiers `FAST`/`EASY`/`HARD`/`DECIDE`, the cross-lab seats; §Tiers). `discoverRoutes(dir)` imports every
`*.ts` there in sorted order (only `_shared.ts` and `*.test.ts` skipped; any other file is a group) once per process; `DEFAULT_ROUTES` is the result,
validated and deeply frozen. An empty directory, a default export that is not an object, an invalid id or entry, or a
route id a second file declares fails the import, naming the file.

Route ids stay typed though the table is discovered: each group file adds its ids to the `RouteTable` interface by
module augmentation, and `RouteId = keyof RouteTable`, so a typo in a caller is a compile error. `guard.test.ts` holds
every group to that shape (`export default routes` plus the augmentation over `keyof typeof routes`, so the typed key
set is the exported one by construction; a type cannot be listed at runtime to compare) and to importing only
`../schema.ts` and `./_shared.ts`, so the table's top-level await can never wait on an import cycle. It also checks that
every route literal in a route position under `packages/*/src` (`route:`, `routeId:`, `resolve(…)`,
`resolveRoute(…)`, `*_ROUTE[: RouteId] = …`) is a route the table serves: that covers call-time routes such as a step's untyped
`options.route`. The host also checks at
boot that every agent a workflow lists runs on a route the table has (`packages/host/README.md` §Adding a workflow).

A new workflow's routes are a new group file, ending with the augmentation (copy it from any group):

```ts
import type { RouteEntry } from '../schema.ts'
import { EASY } from './_shared.ts'

const routes = {
  // `EASY.agent` carries the model, effort, rate and the Terra-low fallback; `.call` is the single-call twin.
  'brain.agent': { wire: 'opencode', ...EASY.agent },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
```

`_shared.ts` is imported, never edited by a port: a rate only one group uses lives in that group's file. A group's
provenance (which legacy seat it copies, and why) is its file's comments and its workflow's README.

## Tiers

A text model is chosen once, in `src/table/_shared.ts`, as one of four **tiers** (owner, 2026-10-31) or a named cross-lab constant. A route spreads it and nothing else names a model. **The tiers are Claude** (owner decision 2026-11-01, provisional until Waves 9–10) so the monthly credit is spent, except `DECIDE`; the rate of each Claude tier is `CLAUDE_RATES` (`claude.ts`, the one source):

| Tier | Primary today | Routes |
|-|-|-|
| `FAST` | Haiku 5.5, effort none | `cheap.classify`, `cheap.title`, `factory.classify`, `factory.ask`, `hermes.title`, `hermes.approval`, `digest.items`, `audio.tts.prep`, `audio.tts.summary` (the prep follows the route's wire), the image enhance planner (effort high); `.agent`: `diagram.agent` |
| `EASY` | Haiku 5.5, effort high | `cheap.summarize`, `cheap.extract`, `overview.classify`, `triage`, `check`, `brain.agent`, `otel.agent`, `research.agent`, `podcast.metadata`, `hermes.brain`, `hermes.compress`, `factory.steward`, `factory.queue`, `factory.triage`, `factory.screen`, `factory.errand`, `factory.hygiene` |
| `HARD` | Sonnet 5.5, effort medium | `hermes.vision`, `prose.write`, `narrative`, the retro agent, the podcast writers' room (`podcast.research`, `.editorial`, `.outline`, `.write`) |
| `DECIDE` | `decision-1` (IU decision API), input-priced, no fallback | `decide` |

A tier holds one entry per step kind, `.call` (a single call) and `.agent` (an OpenCode step), each `{ model, effort, rate, fallback }` (a `.call` also its `maxOutputTokens`); the route picks the kind and owns the wire:

```ts
'cheap.title': { wire: 'anthropic', ...FAST.call },
'retro.analyze': { wire: 'opencode', ...HARD.agent },
'research.agent': { wire: 'opencode', ...EASY.agent },
```

Only the kinds in use exist: `DECIDE` has `.call` only, `FAST`, `EASY` and `HARD` have both. The tier owns the output ceiling (FAST 16 000, EASY and HARD 32 000) along with model, effort, rate and fallback; a route adds only its `wire` and overrides nothing (guard.test.ts). Moving every route of a tier to another model, rate, effort or ceiling is one edit to the tier. The wire is the route's own (a transport is code, an arm cannot change it), so a tier that moves to another provider family also needs its routes' `wire` changed where the family speaks another dialect (the Claude tiers did: single calls moved from `iu-openai` to `anthropic`).

Evidence (agw's 2026-10-31 eval, `docs/evals/2026-10-31-review-claude-direct.md`): Haiku at effort high is the Haiku knee, Haiku at max is unusable for agent steps. Sonnet at medium was not measured; `HARD` was Terra medium until this change.

### Fallback

A single-call route on a Claude tier takes `wire: 'anthropic'` (native Messages on the gateway, which pays from the credit); an agent route stays on `opencode`. Both wires send `x-agw-fallback: none`, so a drained credit is a 402 (never a silent move onto IU's Claude) and the route's fallback runs. **The fallback is GPT on IU, per tier and step kind, and travels with the tier:**

| Tier and kind | Fallback |
|-|-|
| `FAST.call` | Luna low on `iu-openai` |
| `EASY.call` | Terra low on `iu-openai` |
| `EASY.agent` | Terra low on `opencode` (Responses API) |
| `HARD.call` | Terra medium on `iu-openai` |
| `HARD.agent` | Terra medium on `opencode` |

Every fallback has `maxOutputTokens` 32000. The GPT models are constants (`LUNA`, `TERRA_LOW`, `TERRA_MEDIUM`), not tiers: a tier's fallback is built from one.

### Cross-lab seats

Constants in `_shared.ts`, spread like a tier (`{ wire: 'iu-openai', ...CRITIC.call }`), each with its rate and fallback. Not tiers: they stay off Claude by principle, as the reviewers of Claude-written output (the cross-lab list: `podcast.review`, `prose.review`).

| Constant | Model | Routes | Fallback |
|-|-|-|-|
| `CRITIC` | Terra medium | `podcast.review`, `prose.review` | Luna medium |

`vision.describe` (behind `image.read`) spreads `FAST`: Haiku on the Messages wire, Luna low behind it on the chat wire. Image input rides `ChatRequest.images` on both wires; the effort pick is in `docs/shop.md` §Vision.

`podcast.review` is the cross-family critic: a Claude critic of a Claude writer defeats it. The podcast writers' room moved to Claude in Wave 6 (the single calls and the writer's tool loop speak the Messages wire); its reviewers stay on other labs. `prose.review` is a cross-lab reviewer of a Claude writer: its capability refuses a Claude model or any wire but `iu-openai`. `agw routes` shows `default` in the effort column where no effort is sent (the vendor's own level), and `none` where thinking is off.

### Eval seats

The review eval's ground truth (`docs/review-v2.md` §The eval) runs on four pinned seats in `src/table/eval.ts`, built from `LABELER_CLAUDE`, `LABELER_GPT`, `JUDGE` and `JUDGE_GPT` in `_shared.ts`. They are not tiers and have **no fallback**: a fallback would silently change a labeller or the grader, so a drained credit fails the call and never moves it. A change to a seat or to its capability's prompt bumps its version: `LABELER_VERSION` (seats `a` and `b`), `JUDGE_VERSION` (judge `a`) and `JUDGE_B_VERSION` (judge `b`) in `packages/capabilities`, each pinned by a test that recomputes it. Each second seat has its own version so adding it never invalidates the records and calls of the first.

| Route | Wire | Model | Effort | Output ceiling |
|-|-|-|-|-|
| `eval.label.a` | `anthropic` | Sonnet 5.5 | medium | 16000 |
| `eval.label.b` | `iu-openai` | Terra (the GPT stack's rate) | medium | 16000 |
| `eval.judge` | `anthropic` | Sonnet 5.5 | medium | 16000 |
| `eval.judge.b` | `iu-openai` | Terra (the GPT stack's rate) | medium | 16000 |

### Guard

`guard.test.ts` holds the shape:

- A text route's group file has no `model:` literal (failing with `file:line`); its model comes from a tier or a `_shared.ts` constant. The media routes (TTS, STT, image and Replicate models) are exempt by the explicit, commented list in the test. Model ids stay under `src/table/` only.
- Every route on a Claude model deep-equals a tier's `.call` or `.agent` (model, effort, rate, fallback), overrides aside.
- Every route on `anthropic`, and every `opencode` route on a Claude model, has a fallback on a GPT model; no route on `iu-openai` or `opencode` falls back onto Claude; no `claude-` single call sits on `iu-openai`.
- The cross-lab reviewers (`podcast.review`, `prose.review`) are never on a Claude model or the `anthropic` wire, primary or fallback.

## Entry

| Field | Meaning |
|-|-|
| `wire` | `iu-openai` (IU OpenAI dialect: chat completions, `/audio/transcriptions`), `anthropic` (native Messages on the gateway, which pays from a Claude credit pool or IU), `iu-decision` (IU decision API), `opencode` (agent step on the OpenCode host), `iu-gemini` (native Gemini TTS), `iu-replicate` (Replicate predictions) |
| `model` | the provider's model id |
| `effort` | `none\|low\|medium\|high\|xhigh\|max`. Absent when the model exposes none. A Sonnet model at `none` is a configuration error (table import and every arm patch fail, naming the route): Sonnet 5.5 has no effort level that switches thinking off |
| `maxOutputTokens` | output ceiling; reasoning tokens count against it |
| `rate` | `{ inputPerM, outputPerM, cacheReadPerM?, cacheWritePerM?, longPromptTokens? }` USD per million; the provider's `usage.cost` wins where it sends one |
| `contextLimit` | `opencode` routes on a Claude model only, one of `CONTEXT_LIMITS` (60000, 80000, 100000 prompt tokens); off when absent, and no route of the table sets it. The route's own, never its fallback's. Keeps every call of the agent step under that many prompt tokens (input plus cache reads and writes) by having OpenCode compact the session in time; why the Haiku long-prompt tier matters, how the bound is met and what it costs: `packages/opencode-host` README §Bounded context |
| `fallback` | a full route spec (`wire`, `model`, `effort?`, `maxOutputTokens?`, `rate?`) the call moves to once on a provider-balance failure (below) |

`iu-decision` entries take neither `effort` nor `maxOutputTokens`. A fallback runs the same kind of step: an `opencode` route falls back to `opencode`, a single call to a single call (its wire may differ: `anthropic` routes fall back over `iu-openai`, the rule for every Claude tier).

## Fallback on provider balance

Owner direction 2026-10-28: a route that fails because the provider account is empty falls back instead of failing.

- **Trigger:** `isBalanceFailure` (`src/balance.ts`), the one classifier: HTTP 402; 503 whose body says "Insufficient Balance" or "PaymentRequired" (IU today: `IU request failed (503) — Insufficient Balance (PaymentRequired) on <provider>`); or 400 whose body says "credit balance is too low to access the Anthropic API" (Anthropic's refusal of a drained Console org, a 400 `invalid_request_error`, not a 402), or which carries `BALANCE_MARKER` (the transports' own message, re-classified with its status; the body is cut to 300 chars, so the marker is what survives). Any other 400 is not balance. Without a status (an OpenCode turn error, a step's failure reason) `BALANCE_MARKER` (`provider balance exhausted`, written by the transports), IU's body shape `Insufficient Balance (PaymentRequired)`, Anthropic's full sentence above, or a `402` token together with "payment required" / "insufficient balance" count; a 402 or the wording alone does not. The classifier is never fed diff text: review's failure reasons carry none (zod schema messages hold no values, OpenCode turn errors are the provider's). Any other error keeps its usual handling.
- **Once:** the capability transports fail fast on it (no retry loop on the primary) and the call runs once on `fallbackRoute(route)`; the OpenCode host reopens a step whose turn was refused before it did anything on the fallback route, once (`packages/opencode-host` README); A failing fallback answers the primary's error. The usage records the model that actually ran.
- **Default:** a Claude route falls back to GPT on IU by tier (Luna low, Terra low, Terra medium; §Tiers), the critic to Luna medium, `decide` and the audio and image-model routes to nothing. Every fallback has `maxOutputTokens` 32000 (see §Tiers). Claude routes lean on this: with the credit gone the gateway answers 402, so a Claude route without a fallback is a failed call.
- **Arms:** an arm patches a fallback like a primary: `{"cheap.classify": {"fallback": {"model": "<model-id>", "effort": "high"}}}` (merged over the table's fallback; a new model takes the table's rate for it, as on the primary) and `{"cheap.classify": {"fallback": null}}` removes it. A route without a fallback cannot gain one through an arm, and a fallback's `wire` cannot be patched.
- **Price:** the fallback carries its own rate (below); `usage.cost`, when IU sends it, wins as on any route.

## Arms

An arm is the one way to run a route other than the table's: `{ routes?: { <route id>: <patch> }, params?: { <name>: <json> } }`,
passed with `agw eval run <workflow> --arm <file>` (`packages/host/src/workflows/eval/README.md`). It applies to that eval
run and every run below it (the regression judge's calls excepted: the grader stays on the table), never to production: a
run without an arm resolves the plain table. An arm whose `routes` and `params` are both empty is no arm, the unarmed
baseline. There is no environment variable and no config file.

```json
{
  "routes": { "research.agent": { "effort": "high" }, "cheap.classify": { "model": "<model-id>", "effort": "low" } },
  "params": { "finders": 3 }
}
```

- A patch may set `model`, `effort`, `maxOutputTokens` (at most 200000), `rate`, `price`, `contextLimit` and `fallback` (a patch of the same fields, or `null`); `null` clears an optional field. It is merged over the table entry and the result is validated like a table entry.
- **`wire` cannot be patched** (`RouteOverrideError`): a route's transport is code.
- **Only models the table names** (`TABLE_MODELS`: routes, fallbacks, the Claude models), on every wire: agw's own usage rows (`callerRecords`) and the prices come from the table, so a new model goes into the table first.
- **A new model keeps a price.** Unless the patch sets them, it takes the table's `rate` and `price` for that model (`routeRate`, `claudeRate`); a priced route never moves to a model the table prices no such way.
- **Efforts per provider** (`effortsOf`, `src/schema.ts`): a Sonnet takes no `none`, GPT-6 Astra and GPT-6.1 Sol take no `none`, DeepSeek takes `none`, `low`, `high`, `max` (its `medium`/`xhigh` are only aliases of `high`); every other model all six. The table import and every patch are held to it.
- **`contextLimit`** (one of `CONTEXT_LIMITS`, `null` clears it) is accepted on an `opencode` route running a Claude model, and nowhere else: another value, a route on another wire, or a move to a non-Claude model is refused at admission. It is part of the resolved route, so it moves the run fingerprint. The fallback has none.
- **Agent routes** (`opencode` wire) move only among the models the OpenCode server serves (`opencodeModels()`: every opencode-wire model of the table and its fallbacks, and every Claude model, Opus included), at any effort its provider takes; the server registers exactly those variants of each (`packages/opencode-host` README). `rate`, `maxOutputTokens` and `price` cannot be patched there: the server's config prices and limits a model, not a route.
- `validateArm(arm)` checks the arm whole at admission: its shape, every patch (an unknown route id, a bad entry, a model the table does not name, an effort the provider does not take, an unserved agent model). A message names the route id and the problem, and the model for an unknown or unserved one; never a parser message or another value.
- `resolveRoute(id, patch)` validates every patch on every call, not only the requested route. The run fingerprint includes the arm (`packages/middleware` fingerprint), so an armed run never shares a fingerprint with a production run.

## Cost

`costFromUsage` returns the provider's `usage.cost` when present and valid (`source: 'provider'`, a reported `0` stays `0`). Otherwise it prices the route's `rate` (`source: 'rate'`): input excluding cache tokens at `inputPerM`, cache reads at `cacheReadPerM`, cache writes at `cacheWritePerM`, output at `outputPerM` (reasoning tokens are already in the output count). Cache tokens against a rate without the matching cache rate, or neither cost nor rate, return `{ usd: null, source: 'unknown' }`: never free, never 0. `input_tokens` (Anthropic) excludes cache tokens; `prompt_tokens` and `inputTokens` include them.

Cache counts above the cache-inclusive prompt total return `unknown`. One rule for size: a rate without `longPrompt` has no tier and is priced flat at any size; a rate with `longPrompt: { inputMultiplier, outputMultiplier }` (and the `longPromptTokens` it starts above, required with it) prices a request whose prompt (input including cache, per request) is above that size at the tier: the whole request, input, cache read and cache write at `inputMultiplier` times their rate, output at `outputMultiplier` times. Haiku 5.5 is `5 / 5` over 100K (Anthropic pricing page, read 2026-10-29: "a request over the threshold pays the higher prices even when part of its prompt is a cache hit"), Terra `2 / 1.5` over 272K. The threshold is exclusive: exactly 100K is the base card.

Rates are carried by every text route whose wire reports no cost, from the tiers and constants in `src/table/_shared.ts`: `decide` (the decision API drops IU's cost; UE price list in agent-gateway's `decision.ts`), Terra ($1.00 in, $5.00 out, $0.05 cache read, $1.25 cache write per million, 2x input and 1.5x output above 272K prompt tokens: OpenAI price page via `/research` and a probe of the IU OpenAI endpoint, 2026-10-28), Luna ($0.10 in, $0.50 out, $0.01 cache read), and the Claude tiers from `CLAUDE_RATES` (Haiku 5.5 and Sonnet 5.5; Haiku was dropped from the table on 2026-10-30 and came back as `FAST`/`EASY` on 2026-11-01, owner decision). On the `opencode` wire the OpenCode host writes the rate into the server config's cost rows, so OpenCode prices each message with it; a message OpenCode reports at cost 0 with tokens is priced with the rate by the host (`costFromUsage`), else `unknown`.

The Terra fallbacks carry a rate on every route: $1.00 in, $0.05 cached in, $5.00 out, $1.25 cache write (30-min) per million, Standard tier, and a `longPrompt` tier over 272K input tokens: the whole request bills 2x input/cache and 1.5x output. Context 1,050,000, max output 128,000, effort `none|low|medium|high|xhigh|max`. Source: developers.openai.com (via /research) and a probe of IU's OpenAI endpoint (listed in `/models`, chat completions with `reasoning_effort: medium` answered 200, served as `openai.gpt-6.1-terra`), 2026-10-28.

## Source seats (agent-gateway `GET /api/routing`, 2026-10-27, wires and models as of 2026-11-01)

The capability seats (`src/table/cheap.ts`, `decide.ts`); a workflow's seats are in its README's §Route
(`packages/host/src/workflows/<id>/README.md`). The agent-gateway column is where the seat came from; Model and Wire are the table today (the tiers are Claude, §Tiers), with the effort the tier sets (`FAST` none, `EASY` high).

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
- Not ported: the Max-lane fallback (`fallback: sonnet` on Max), `prose_*`, `read_image` and dispatch seats (`otel` is `otel.agent`). They belong to the Claude runtime or to later waves.
- The `decide` rate is the UE price list from `decision.ts`. The gateway's default `pplx-decider-v1-27b` is served by IU's "Requesty decision compatibility API" (`x-middleware-forwarded-server`, probed 2026-10-29), so `decide` runs `decision-1` (Microsoft; header "Global Sink Sweden Decisions API"): same wire, request shape and 60k-character cap, input-only rate $0.042/M. Its confidences are calibrated by another model; a caller that thresholds on them re-checks the threshold.
- No route is region-pinned and none goes via Requesty (owner direction, 2026-10-29). A route is judged by the response header `x-middleware-forwarded-server`, not by its id: `deepseek-v4.1-flash`, `DeepSeek-V4-Flash` and `pplx-decider-v1-27b` all answer from Requesty-Global, and the one non-Requesty DeepSeek id the model list shows (`deepseek-ai/DeepSeek-V3.2`, Nebius) answers "model does not exist". The retired `-eu` Claude ids are no longer listed. The Claude tiers go to the gateway's `anthropic` wire, which pays from a credit pool; IU's `claude-haiku-5-5` and `claude-sonnet-5-5` (LiteLLM on the chat wire, AWS Bedrock on Messages) are never a fallback: `x-agw-fallback: none` turns a drained credit into a 402 and the route's GPT fallback runs.
- `triage` and `cheap.classify` run Haiku 5.5 on the native Messages wire (the route carries the rate). `triage` gained a fallback, Terra low on the chat wire (it had none while a Requesty model was the only candidate); `decide` has none.
- `podcast.review` is the cross-family critic, so it stays on `gpt-6.1-terra` (medium effort, chat wire, rate carried), fallback Luna medium: a Claude critic of a Claude writer defeats it.
- `research.agent`, `otel.agent` and the podcast stages (`podcast.research`, `.editorial`, `.outline`, `.write`, `.metadata`; `podcast.review` to Terra medium) moved to Claude in Wave 6 (docs/evals/2026-11-02-claude-seats.md); `diagram.agent` moved to `FAST.agent`. `prose.review` still runs `deepseek-v4.1-flash`, which is Requesty-Global, as a cross-lab reviewer.

## Model ids

`canonicalModel(raw)` is the one id a model is recorded under. Providers echo the same model several ways (`openai.<id>`,
`vertex_ai_eu/<id>`, `deepseek/<id>`, a dated Claude snapshot, a `[1m]` suffix, an alias such as `sonnet`); the journal
(`steps.model`, `usage_by_model`) and the agent steps' usage take the canonical form, and each step also records its route id
(`steps.route`), so a report groups by route and model. An echo collapses only onto a model the table names (routes, fallbacks, the Claude models): the raw id first (a table id is
never cut, `<owner>/<name>` ids included), then the id with its one-segment provider prefix stripped, with a trailing
`-YYYY-MM-DD` snapshot date stripped (any family), both, each with a Claude snapshot date and `[1m]` removed, then a Claude
alias resolved. The first table model wins; otherwise the raw id comes back untouched, so `alice/<id>` and `bob/<id>` never
merge. The prefix is `PROVIDER_ECHO`, the regex `callerRecords` already used. The gateway keeps its own `rowModel` and writes its
rows as before.

## Token effect / cache effect

A route flip changes what the next run costs and how well it caches:

- **Model change on a route with a rate** (`decide`): tokens are priced at the table's rate for the new model (a model the table names); one the table prices no such way is refused.
- **Model change in general:** the provider prompt cache is per model, so the first run after a flip pays full input price. Claude reports cache reads and writes; DeepSeek on `iu-openai` reports `cached_tokens`; cost from `usage.cost` already reflects both.
- **Effort up** (`high`, `max`): more reasoning tokens, billed as output, counted against `maxOutputTokens`. Raise the ceiling with it or the answer starves.
- **Wire change** (for example `iu-openai` → `anthropic`): different usage keys and cache semantics. `costFromUsage` accepts both shapes, but the cache hit rate starts from zero.
- **A fallback** runs on another model: its first call pays full input price (the cache is per model), at Terra's rate, which is 10x Haiku 5.5's input and output (Terra against Sonnet 5.5: half the input, half the output). It only runs while the primary's provider is out of balance.
- **Haiku 5.5** bills 5x above 100K prompt tokens per request; a long agent episode costs more than the list rate suggests. `costFromUsage` prices a single call over that size at the tier; OpenCode's own per-message cost knows only the base card, so the OpenCode host re-prices a message over the threshold with the rate (`priceOpenCodeMessages`).
- The fingerprint changes on any of these, so runs before and after a flip never share a group.

## Claude models

`src/table/claude.ts` holds the three current Claude models (`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`), their
list rates and the alias map `haiku | sonnet | opus`. It is a route group with no routes: the route table reaches Claude through the
tiers in `_shared.ts`, which read their rates from `CLAUDE_RATES` here. The other user is the inference gateway (`docs/gateway.md`
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
