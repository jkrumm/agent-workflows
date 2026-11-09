# @agent-workflows/capabilities

A **capability** is a typed function defined once and exposed three ways: as an import, over HTTP and as an `agw` command (concept §2, §8). The model-backed ones go through the route table (`@agent-workflows/routes`) and never name a model id.

```ts
import { createCapabilities, createRegistry } from '@agent-workflows/capabilities'

const registry = createRegistry(createCapabilities(), {
  onUsage: (capability, usage) => record(capability, usage), // every billed model call, HTTP or import
})

await registry.call('llm.title', { text }) // import: same validation and typed errors as HTTP
Bun.serve({ port: 0, fetch: registry.fetch }) // HTTP: POST /llm/title
await registry.openapi() // OpenAPI 3.1, every operation carries `x-cli`
```

## Defining one

```ts
const title = defineCapability({
  id: 'llm.title', // dotted lowercase; HTTP path /llm/title, operation id llmTitle, CLI `agw llm title`
  summary: 'Title a text',
  input: z.object({ text: z.string().min(1) }),
  output: z.object({ title: z.string() }),
  cli: { positional: ['text'], stdin: 'text', plainField: 'title' },
  async handler({ text }, ctx) {
    // ctx = { signal, addUsage(usage) }; throw fail('INVALID_OUTPUT', …) for a typed error
  },
})
await title.call({ text: 'x' }) // also callable on its own
```

- The handler is a plain function of `(input, ctx)`. oRPC is imported in `src/procedure.ts` and `src/registry.ts` only.
- `call` runs oRPC's `call` on the same procedure the HTTP handler serves, so defaults, validation and the error-mapping middleware are identical on both doors. `registry.test.ts` asserts identical results and identical error bodies.
- Inputs are strict: an unknown key is a `BAD_REQUEST` on both doors, so a renamed flag fails loudly instead of being dropped.
- Errors come out of `call` as `CapabilityCallError` with the same fields as the HTTP body: `{ defined, code, status, message, data }`. Callers never see the HTTP framework's error class.
- Registering the same id twice, a taken `METHOD path`, or an id nested under another id throws at `createRegistry`.

### `ctx` and usage

```ts
type Usage = {
  model: string
  tokens: { input: number; output: number; cacheRead: number; cacheWrite?: number; reasoning: number }
  cost: number | null
  costSource: 'provider' | 'rate' | 'unknown'
}
```

Tokens are the raw provider counts: `input` includes cache reads and writes (`cacheWrite` is set by the Messages wire, which reports it), `output` includes reasoning. The Argo projection normalises later. `cost` is the provider's `usage.cost`, else the route's rate (input excluding cache, cache reads, cache writes and output each at their own rate; cache tokens without the matching cache rate are `unknown`), else `null` with `costSource: 'unknown'`, never 0 (`costFromUsage` in routes). A re-ask after a rejected answer reports each attempt, and a call whose content turned out unusable is reported before the error is thrown. Adapters report every attempt that came back with usage, including one that then failed (a stream cut before its finish chunk, a 200 whose body does not fit), through an `onUsage` hook on the port. The transport's own retries of requests that returned no usage (429, 5xx, a reset) report nothing. A call that returned no usage at all is reported with zero tokens and `unknown` cost. A stream that ends without a finish chunk counts as a dropped connection and is retried; a body that cannot be read or parsed is retried, and parsed JSON that does not fit the schema is not.

The runtime package defines its own step `addUsage`. This one is structurally identical (`Ctx.addUsage: (usage: Usage) => void`); the lead reconciles the type at merge.

### Typed errors

Declared on every operation (they land in the OpenAPI document), keyed by `code` so the CLI generator can map them to exit codes. Input validation failures are oRPC's `BAD_REQUEST` (400, `defined: false`); anything else a handler throws is an opaque `INTERNAL_SERVER_ERROR`.

| Code | Status | Meaning |
|-|-|-|
| `NOT_CONFIGURED` | 503 | `AGW_GATEWAY_URL` or `AGW_API_SECRET` missing or malformed, a bad route patch in the calling run's arm, or a route on a wire that is not a single call. Nothing was sent. Messages name the variable, never a value |
| `UPSTREAM_ERROR` | 502 | the provider was unreachable or answered with an error status after retries; `data.status` when there was one. Also an empty or refused answer |
| `INVALID_OUTPUT` | 502 | the answer failed the schema after one re-ask; `data: { attempts, reason }` |
| `OUTPUT_TRUNCATED` | 502 | the output ceiling ended the answer; `data.reason` is `starved` (reasoning ate it, no text) or `truncated` |
| `URL_REFUSED` | 422 | `web.fetch` will not fetch the URL (not http(s), credentials in it, an internal name, or a non-public address, on the first URL or on a redirect hop). Nothing was sent. The CLI maps 422 to its usage exit code |
| `CANCELLED` | 499 | the caller's signal aborted |

### `internal` and `hidden`

`cli.hidden` only drops the CLI command: the capability is still on the HTTP router and in OpenAPI. `internal: true` serves it nowhere (no route, no OpenAPI operation, no CLI, no host `cap.<id>` run, never grantable to an agent); `registry.call` from a workflow step still works, and `registry.served` is the one list of what has a door.

### `x-cli`

Every operation carries `x-cli`, with defaults filled in: `{ command, positional, mutating, defaultFormat, kind, stdin?, plainField?, resume? }`. Flags come from the input schema's properties that are not positional. `kind` is `capability` here; the host's workflow and run operations set `workflow` and `run`, and `resume` (`{ command, positional }`, the command that continues a still-running workflow) rides on workflows only. The host attaches the same block to its own operations through the exported `withCli`, and merges a registry into its router through `registry.router` and `registry.requestContext` (see the host README). `stdin` names the input property that is read from stdin when it is not given as an argument or flag. It is new in this package (the S3 spike's `x-cli` had no equivalent), so the Wave 3 generator must read it. The block is attached through one `spec` callback in `procedure.ts`.

## Transports

Ports and adapters: `ChatPort` (`iu-openai` and `anthropic` both implement it), `DecisionPort` (`iu-decision`). The production adapters live in `src/transports/`, the in-memory fakes (`fakeTransports`) and the fake gateway on a real socket live in `packages/testing` (`@agent-workflows/testing/transports`, `/gateway`).

| Adapter | Wire | Behaviour ported from agent-gateway |
|-|-|-|
| `iuOpenai` | `POST <gateway>/openai/v1/chat/completions`, SSE with `include_usage` | idle watchdog only (5 min without a chunk, never a wall-clock cap), 3 attempts at 0.5 s / 1.5 s on 429/5xx and network errors, 410, client errors and provider-balance failures fail fast, an upstream `invalid_request_error` wrapped in a 503 is not retried, `max_completion_tokens` (reasoning tokens count against it), no `temperature`, `reasoning_effort` only when the route has an effort |
| `anthropicWire` | `POST <gateway>/anthropic/v1/messages`, one non-streamed request | 30 min hang guard (not retried), same retry rules, `thinking: adaptive` plus `output_config.effort` only when the route has an effort (a schema adds `output_config.format`, §Schema output), `max_tokens` as the ceiling, `x-agw-fallback: none` on every request; reads the 1 h part of the cache writes (`cache_creation.ephemeral_1h_input_tokens`, `Tokens.cacheWrite1h`), which `toUsage` prices at the 1 h rate |
| `iuDecision` | `POST <gateway>/decisions/v1/systemone` | boolean questions go as `noul`, choice options as `criteria`; same retry rules |

Every wire goes through the local inference gateway (`docs/gateway.md`), which holds the IU and Claude keys; this package holds none. `gatewayConfig(env)` reads `AGW_GATEWAY_URL` (an origin, no default) and `AGW_API_SECRET` (the host's API secret, which the gateway accepts as the caller `agw`) on each call, so importing the package never fails without them, and derives every base (`/anthropic`, `/openai/v1`, `/decisions/v1`, `/replicate/v1`). Each request sends `authorization: Bearer <token>`.

**Attribution.** `Ctx.attribution` (`Attribution` in `src/context.ts`: run, root, workflow, step, purpose, project, workspace, traceparent) is the calling step. `registry.call(id, input, scope)` and `capability.call` take it in their options (a runtime `StepScope` is assignable as is), the procedure hands it to the handler, `complete` and `decide` put it on the request, and `gatewayHeaders` turns it into `x-agw-session` (the root run), `x-agw-run-id`, `x-agw-workflow`, `x-agw-step`, `x-agw-purpose`, `x-agw-project`, `x-agw-workspace` and `traceparent` on every wire. An absent value, or one that is not printable ASCII up to 200 characters, is left out rather than failing the call. A caller that rebuilds the options as `{ addUsage, signal }` drops it.

**Decision API: direct HTTP, no `ai` or `@ai-sdk/typesafe-ai`.** The provider package is a 200-line adapter over one `POST /systemone` with a three-variant response (checked against `@ai-sdk/typesafe-ai` 3.0.17 in the frozen gateway). `ai`'s `decide` adds input validation and an answer sanity check; the capability validates both itself (zod on the wire body, every asked question answered, a choice among its options). The dependency would pull in `ai`, the provider and their trees for that. The gateway's own `decide` test fixtures (choice, `noul`, missing confidence falling back to the option's probability) are ported.

**Provider-balance fallback.** A 402 (the gateway's answer to `x-agw-fallback: none` when no credit pool is eligible), a 503 whose body says "Insufficient Balance" / "PaymentRequired", Anthropic's 400 "credit balance is too low to access the Anthropic API", or OpenAI's 429 with `insufficient_quota` (an exhausted OpenAI-style account; an ordinary 429 rate limit is still retried; wording from OpenAI's documented error, not probed on the IU relay) (`isBalanceFailure` in `@agent-workflows/routes`, the one classifier), fails fast in the transport (no retry of the primary) with `provider balance exhausted` in the `UPSTREAM_ERROR` message (the body is cut to 300 chars; the marker is what `isBalanceError` re-classifies on a 400 or 429). `complete` then calls the route's `fallback` once (`fallbackRoute`; its own wire, model, effort, ceiling and rate) and logs it (`LlmDeps.warn`, default `console.warn`). Usage is reported under the model that ran, priced by `usage.cost` or the fallback's rate. A re-ask after a rejected answer stays on the route that answered. When the fallback fails too, an `UPSTREAM_ERROR` with data `{ reason: 'fallback_failed' }` is thrown (`FallbackFailedError` in `@agent-workflows/routes`): its `cause` is the fallback's error, its message names both models and carries no balance wording, so `isBalanceError` is false on it and the primary's refusal is not rethrown as if it were the outcome. A cancelled call passes through untouched. A caller's `effort` is for the primary: a fallback always runs at its own route's effort.

### Schema output

A single-call JSON capability (`completeJson`) sends the answer's JSON Schema, not only a request for JSON. `toJsonSchema` (`src/transports/json-schema.ts`, the one converter) turns the zod type into `z.toJSONSchema(…, { io: 'output' })` and keeps the subset both providers take: objects are closed (`additionalProperties: false`), numeric and string bounds, `maxItems`, `pattern`, a `minItems` over 1 and an unsupported `format` are dropped and written into the property's `description` (the model still reads them; zod still enforces them). A type with no wire form (a record, a tuple, a transform, a recursive type) converts to `null` and the call asks for JSON syntax only. The zod parse stays the last check, and a bad answer is still re-asked once.

| Wire | Request | Falls back to |
|-|-|-|
| `anthropic` | `output_config.format: { type: 'json_schema', schema }`, merged with `output_config.effort` when the route has one | no format when the schema has no wire form |
| `iu-openai` | `response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } }` for a `gpt-*` model and a schema whose every property is required | `json_object` (other models, an optional property) |

Measured 2026-11-02 through the gateway (Haiku 5.5, Luna, Terra; 14 calls under $0.001 in all, ids in the PR):

1. Haiku 5.5 takes `output_config.format` at effort none and at effort high, on a credit pool and forced to IU (`x-agw-upstream: iu`, Bedrock behind it): no beta header. Both enforce it (an enum of `zzq-alpha|zzq-beta` came back exactly, with thinking on). The answer is a `text` block, after an empty `thinking` block when the model thinks.
2. Anthropic answers 400 to `minimum`/`maximum` on an integer (`output_config.format.schema: For 'integer' type, properties maximum, minimum are not supported`), on the pool and through IU, where it comes back as a 503 wrapping the 400 (not retried). `minLength`/`maxLength` on a string were accepted. Optional properties are accepted.
3. Luna and Terra take `response_format` `json_schema` with `strict: true` on `/openai/v1/chat/completions` through IU and enforce an enum. Strict mode answers 400 (wrapped in a 503) to an object whose `required` omits a property (`Missing 'note'`), so a schema with an optional field is sent as `json_object`. `minLength` under strict was accepted.
4. The DeepSeek model behind Requesty (`prose.review`) answers 503 "This response_format type is unavailable" to `json_schema`: only `gpt-*` models get it.
5. Anthropic's docs (read 2026-11-02): no beta header; `additionalProperties` must be `false`; recursive schemas, numeric and string bounds, and `minItems` above 1 are unsupported; grammar applies to the final text, not to thinking; `stop_reason: refusal` and `max_tokens` can leave the output off-schema (both are judged before the parse); changing the format invalidates the prompt cache of that thread.

Content failures (`stop_reason: max_tokens`, empty text, a refusal or any non-final stop) are judged once in `src/llm/model-call.ts`, after usage is reported. JSON answers are parsed loosely (code fence, prose around the object), validated, re-asked once with the rejection reason, then `INVALID_OUTPUT`; a transport failure is never re-asked, so a retry cannot bill twice.

## Registering a group

`src/capabilities/index.ts` is one line per group (`createLlmCapabilities` in `src/capabilities/llm.ts`, web, hdx,
brain), each group in its own file. It stays a static list, not a directory scan: the `as const` tuple it returns is
what types `Registry<ReturnType<typeof createCapabilities>>`, so every `registry.call(id, input)` in a workflow is
checked against the capability's schemas; a runtime scan has no static type to give. A new group is its own file plus
one spread line (and its deps parameter); a new model-backed capability is one line in `llm.ts`.

## Capabilities

All four are `POST` with a JSON body. The model comes from the route; an eval run's arm patches it for the calls of its runs (`ctx.arm`, routes README §Arms), every other call resolves the table.

### `llm.summarize` — route `cheap.summarize` (`anthropic`)

`agw llm summarize [text] [--max-words 100] [--style paragraph|bullets]`, text from stdin when omitted. Input `{ text, maxWords = 100, style = 'paragraph' }`, output `{ summary }`.

**Token effect / cache effect.** Cost grows with the text: the whole input is sent once, output is capped by `maxWords` in the prompt (the ceiling is `maxOutputTokens`, default 8192, or 32000 when the route has an effort). The system prompt is fixed and first, so repeated calls share a cacheable prefix; the text follows it. IU's Messages wire reports no cost, so the cost comes from the route's Haiku 5.5 `rate` (`costSource: 'rate'`), cache reads and writes at their own rates. Prompts over 100K tokens bill at 5x on every column (the rate's `longPrompt` tier), and `costFromUsage` prices such a call at it. A route flip to a model with an effort turns adaptive thinking on: reasoning tokens bill as output and count against the ceiling.

### `llm.title` — route `cheap.title` (`anthropic`)

`agw llm title [text] [--max-words 8]`. Input `{ text, maxWords = 8 }`, output `{ title }`. The first non-empty line is kept, with a leading `#`, a `Title:` label, quotes and a final period removed; nothing left is `INVALID_OUTPUT`.

**Token effect / cache effect.** Output is a handful of tokens, so cost is almost all input. Same fixed-prefix layout and rate-based cost as `llm.summarize`. Titling a text you already summarized with `llm.summarize` is cheaper on the summary than on the original.

### `llm.classify` — route `cheap.classify` (`iu-openai`, Luna, effort low)

`agw llm classify [text] --labels '{"bug":"something is broken","feature":"a new behaviour"}'`. Input `{ text, labels }` where `labels` maps each label to what it means (at least two); output `{ label, reason }` with `label` exactly one of the keys, validated per call. Haiku 5.5 on the chat wire (the gateway used deepseek-v4.1-flash, a Requesty model; IU reports no cost there, so the route carries the rate). The answer schema is sent (§Schema output); a wrong label or unparseable answer is re-asked once with the reason.

**Token effect / cache effect.** The label list and the instruction come first and the text last, so the prefix is identical across calls with the same labels and the provider's prompt cache applies (`cacheRead` is reported; the cost in `usage.cost` already reflects it). The model reasons, so `output` includes reasoning tokens, and `max_completion_tokens` is the route's 16000 so reasoning cannot starve the answer. A failed first answer costs a second full call. Cost is the provider's.

### `decide` — route `decide` (`iu-decision`)

`agw decide --questions '{"q":{"type":"choice","instructions":"…","options":{"a":"…","b":"…"}}}'`, state from stdin; JSON output. Input `{ state, questions }` where each question is `choice` (`options`: id → description, 2 to 255) or `boolean`. Output `{ answers, model, truncatedChars, latencyMs, usage }` (`usage`: see `triage`): a choice answers `{ choice, confidence, probabilities }`, a boolean `{ value, confidence, probability }` (`probability` is P(true), `value` is `probability >= 0.5`). The API rounds probabilities to two decimals. The model cannot search or read anything: `state` is its whole world. State beyond 60 000 characters is cut and reported in `truncatedChars`.

**Token effect / cache effect.** There is no generated text, so output is a few tokens and cost is the input at the route's rate (`costSource: 'rate'`, because the decision API drops IU's own cost). More questions in one call share one state, which is the cheap way to ask: the state is paid for once. No cache effect is reported on this wire. An arm moving `decide` to another model needs a rate in its patch: the table prices no other decision model, so the arm is refused without one.

### `triage` — route `triage` (`iu-openai`, Terra, effort low)

Ported as-is from agent-gateway's `triage` job as iris uses it, for iris's voice-memo notification. `agw triage '<destination>' --reply '<text>'`, transcript from stdin; HTTP `POST /triage`; import `registry.call('triage', …)`. Input `{ destination, transcript, reply? }` (`reply` may be `null`); transcript and reply are cut to 4000 characters (`\n[truncated]` marks the cut), as iris's adapter did. Output `{ headline, detail, spoken, model, attempts, latencyMs, usage }`: `headline` at most 60 characters, `detail` at most 240, `spoken` at most 300 (the legacy length cap standing for "two sentences"; sentences are not counted). One model call, the prompt of iris's `buildPrompt` followed by the gateway's output contract (the JSON Schema). An answer that is not JSON or breaks a limit is re-asked once with the reason (`attempts` 2); a second bad answer is `INVALID_OUTPUT` (HTTP 502).

**`usage` and cost, on `triage` and `decide`.** Legacy's field names, which iris reads: `usage: { inputTokens, outputTokens, reasoningTokens, totalTokens, cacheReadTokens, costUsd }`, summed over every attempt of the call (`inputTokens` includes cache reads, `outputTokens` includes reasoning, as the provider reports them). `costUsd` is `null` when any attempt has no price, never a partial sum. The same calls are reported to the run record and Argo.

**Route.** Terra at effort low on the OpenAI chat wire; no Requesty hop and no fallback (`packages/routes` README §Seats). The gateway used deepseek-v4.1-flash, a Requesty model.

**Cancel.** The call's signal reaches the HTTP request: `agw run cancel <runId>` or `POST /runs/{runId}/cancel` ends an in-flight `triage` or `decide` (`packages/host/test/iris-calls.test.ts`), as does a client that disconnects without an `Idempotency-Key`.

**Caller.** The host has no caller identity beyond `x-agw-purpose`: iris sends `x-agw-purpose: iris`, and the run's `purpose`, its span attribute `agw.purpose` and the Argo row's `raw.purpose` carry it. A user's own call is `prod`; the follow-up and drift samples look at `prod` only, so iris's calls are not in them.

**Token effect / cache effect.** The prompt is about a page, the answer under 100 tokens; the instruction comes first and the memo last, so the prompt cache has a short common prefix at best. A rejected answer costs a second full call.

## Web capabilities (`src/web/`)

research-gateway's tools as capabilities (Wave 6), behaviour ported and code rewritten (concept N3). No model: every call is an HTTP request with its own timeout, the package's `withRetries` (3 attempts at 0.5 s / 1.5 s on 429/5xx and resets; a timeout is not retried), and a priced `Usage`. Credentials come from the environment on each call: `IU_API_KEY` + `IU_BASE_URL` (Sonar), `TAVILY_API_KEY`, `CONTEXT7_API_KEY`, optional `GITHUB_TOKEN`, `SEARCH_PROVIDER`, `SONAR_MODEL`. `.env.tpl` carries the same `op://` refs research-gateway reads, so no new item exists. `createCapabilities(llmDeps, webDeps)` registers all four; `WebDeps` injects `fetch`, DNS `resolve`, `env`, `retry` and `warn`.

| Capability | CLI | Input | Output |
|-|-|-|-|
| `web.search` | `agw web search <query> [--max-results n] [--depth basic\|advanced]` | `{ query, maxResults = 8 (1..20), depth = 'basic' }` | `{ results: [{ url, title, snippet, publishedAt? }], provider: 'sonar'\|'tavily' }` |
| `web.ask` | `agw web ask <query> [--depth basic\|advanced]` | `{ query, depth = 'basic' }` | `{ answer, citations: [{ url, title, snippet, publishedAt? }], provider: 'sonar' }` |
| `web.fetch` | `agw web fetch <url> [--max-chars n]` | `{ url, maxChars = 20000 (1..200000) }` | `{ url, finalUrl, title?, text, truncated, via: 'direct'\|'browser'\|'tavily-extract', cached, fetchedAt, incomplete?, tried? }` |
| `web.docs` | `agw web docs <library> [--topic t] [--tokens n]` | `{ library, topic?, tokens? }` | `{ text, source }` |
| `web.package` | `agw web package <registry> <name>` | `{ registry: 'npm'\|'pypi'\|'crates'\|'github-release', name }` | `{ name, latest, publishedAt?, url }` |

**`web.search`.** Sonar over IU's OpenAI-compatible endpoint is the default, Tavily the per-call fallback, as measured in research-gateway: the Sonar answer is thrown away (it hallucinates under confidence; only `search_results` are used), `max_tokens` is the API's floor of 16, a 429 gets one retry (two attempts), then any Sonar failure, a 200 with no `search_results` included (IU routing Sonar through a normalizing tier drops them), moves to Tavily. `SEARCH_PROVIDER=tavily` skips Sonar. A cancelled call does not fall back. Both failing answers the primary's error; neither configured is `NOT_CONFIGURED`. `depth` is Tavily's `search_depth`; for Sonar `basic` is `search_context_size: low` and `advanced` is `medium` (longer snippets, not more sources, per research-gateway's measurement). Not ported: the per-run query cache, the search budget and the dual-backend merge, which belong to a caller.

**`web.ask`.** The same Sonar request as `web.search` (`sonar.ts`, shared: retry, parse, provider-reported usage) with `max_tokens` 1024, keeping the answer. `citations` are the `search_results`, plus any URL of Sonar's own `citations` array they lack. No fallback: a failure or an empty answer is `UPSTREAM_ERROR`. The answer is unverified; the research agent treats its citations as `seen`, never `retrieved`.

**`web.fetch` chain.** Direct read (manual redirects, 10 s per hop, 5 hops, body read to 2 MB, and `truncated` is true when the body was longer than that, whatever `maxChars` says) then Tavily Extract (basic) when the direct read is blocked or errors (403, 429, 5xx, a reset), is empty or has no text, is not text (PDF; a response without a Content-Type is judged on its bytes: a NUL in the first kilobyte or a known binary signature is not text), or is a script-built shell (under 200 characters of text, a `<script>`, text under a tenth of the markup). A 404/410 ends the chain without the paid step. A thin page nobody can improve is returned rather than an error.

**Empty shells fall back by themselves** (`pages.ts`; the caller never needs `render`). A read is *incomplete* when it is a script-built shell, a text under 1,500 characters that says JavaScript is required or that nothing was found / no results (English and German), or a page of a known list kind without its items (a BoardGameGeek `/geeklist/<id>` page with no `#<n>` item line). An incomplete read is not an answer: the chain goes on to (1) the same URL in the headed browser (`AGW_BROWSER_CDP_URL`), whose text is judged by the same rule, (2) the other spellings of the URL, each read plain and then in the browser (at most 4: `/page/2` ↔ `?page=2`, a geeklist by its id without the slug, and the address a redirect ended at), (3) Tavily Extract. A complete read from any of them is the answer, cached under the URL as asked. Only when every one is still incomplete is the fullest read returned, with `incomplete` (why) and `tried` (the reads attempted, in order) in the output: a thin page is a result, not an error, but it is marked. A failure that ends the chain lists every read it tried in its message. `finalUrl` never carries a bot-challenge redirect's parameters (Reddit's `solution`, `js_challenge`, `jsc_token`): `cleanUrl` returns the clean permalink. The body is decoded by the Content-Type charset, else `<meta charset>` in the first 2 KB, else UTF-8 (an unknown label is UTF-8). **Decision: Lightpanda, the site adapters, Wayback, yt-dlp and the human-solve path are not carried.** They are research-gateway's answers to JS-rendered pages, specific sites and anti-bot walls; the golden set (28 items: RFCs, registry versions, docs pages, Wikipedia-style facts) is search plus plain pages, which the direct read and Extract cover, and each adapter drags in a process, a binary or a human. Add one when a golden item or a live run shows a miss it would fix.

**HTML to text** (`text.ts`, `parseHtml`) is Bun's built-in `HTMLRewriter` (lol-html: streaming, linear, browser-grade tokenizing), not anything hand-written: the body is hostile input scanned on the event loop, and two rounds of review found edge cases in a hand-rolled tokenizer (quotes after attribute names, `<script/>`, unclosed openings) that lol-html already handles per the HTML spec. The code only collects what the handlers see. `script`, `style`, `noscript`, `template`, `iframe`, `svg` and `<title>` are skipped with their content (one that never closes swallows the rest, as in a browser). Block tags break a line (paragraphs, lists, table parts and cells, `option`, `caption`, `legend`, `address`, `textarea`, ...); **every other tag is ignored and its content kept, `form`, `nav` and `button` included**: ASP.NET wraps a whole page in one `<form>`, and a menu kept costs a few lines where a page dropped costs the answer. The `<main>` text stands for the page when it is at least half of all the page text, else `<article>`'s, else the whole page, so a teaser `<article>` cannot hide a page. The title is the first `<title>` outside an `<svg>`, entities decoded (markup inside it stays literal, as in a browser). If the rewriter rejects, the direct read is a failure and the chain moves on. `web.test.ts` runs ten hostile 2 MB shapes (unclosed `<script `, `<article>`, `<title`, attribute quotes, comments, bare `<`, ...), each 5-200 ms.

**SSRF guard and connection pinning** (`ssrf.ts`, `pinned.ts`). On the first URL and on every redirect hop, before anything is sent: only `http`/`https`; no credentials in the URL; no `localhost`, `*.local`, `*.internal`, `*.localhost`, `*.localdomain`, `*.lan`, `*.home.arpa`, `*.ts.net`; then every address the name resolves to must be public: IPv4 (four decimal octets only; anything else is unparseable and fails closed) `0/8 10/8 100.64/10 (the tailnet) 127/8 169.254/16 (cloud metadata) 172.16/12 192.0.0/24 192.0.2/24 192.88.99/24 192.168/16 198.18/15 198.51.100/24 203.0.113/24 224/4+`, IPv6 outside `2000::/3`, `2001:db8::/32` and `3fff::/20` (documentation), all of `2001::/23` (IETF protocol assignments: Teredo, benchmarking, deprecated ORCHID) except the registry's globally reachable entries (`2001:1::1-3`, `2001:3::/32`, `2001:4:112::/48`, `2001:20::/28`, `2001:30::/28`; IANA IPv6 special-purpose registry, read 2026-10-28), `2620:4f:8000::/48` (AS112 direct delegation: reachable, but nothing a page fetch should go to), `64:ff9b:1::/48` (NAT64 local-use), and IPv4 embedded in mapped, compatible, translated, NAT64 and 6to4 forms. Unparseable fails closed. A policy refusal is `URL_REFUSED` (422); a name that authoritatively does not exist (`ENOTFOUND`, `ENODATA`) is not one: it is a failed direct read, and the chain goes on to Extract (or ends `UPSTREAM_ERROR`). Any other resolver failure (`EAI_AGAIN`, a timeout) says nothing about the URL, so the read ends `UPSTREAM_ERROR` and the URL is not forwarded to Tavily. **The vetted addresses are the ones connected to.** `fetch` resolves the name again at connect time, so a resolver that answers public to the guard and private to the connect (DNS rebinding) would walk past a check-then-fetch. The guard returns its addresses, and the request goes through `node:http(s)` with a `lookup` that returns only those, so DNS is asked once per hop and never again; the URL keeps the page's host name, so the Host header and the TLS server name (SNI and the certificate check) are the page's own. Redirects are followed by hand, each hop vetted and pinned to its own addresses. `agent: false`, `Accept-Encoding: gzip, br, deflate`: the decoders are the real path (through `stream.pipeline`, so a failed or cancelled decoder destroys the socket), and the 2 MB read cap counts *decoded* bytes, so a compression bomb costs the cap and a cancel, not its expansion. An unknown or stacked Content-Encoding on a 2xx body, a status outside 200-599, or any failure building the Response rejects the request, which the chain treats as a failed direct read (so Extract gets its turn); a redirect or an error status is judged on its status alone, since its body is never read. A body-less status destroys the socket at once. Page text is returned as data; nothing in it is interpreted. The search, docs, registry and Tavily calls go to fixed hosts and use the plain `fetch`.

**`web.docs`.** Context7 REST (`/api/v2/libs/search`, then `/api/v2/context?type=txt`), no SDK; each body is read inside the retry, so a cut or garbled one is retried and a failed read is `UPSTREAM_ERROR`, never an opaque 500. The top-ranked library for the name wins, ranked against `topic` (default: the library name). Without `CONTEXT7_API_KEY` it answers `NOT_CONFIGURED` ("web.docs unavailable: CONTEXT7_API_KEY is not set") and sends nothing. `tokens` cuts the text client-side at 4 characters per token (Context7 has no such parameter); without it the cap is research-gateway's 80 000 characters. `source` is the library's Context7 page. An unknown library (a 404 from the search) or one without docs is `UPSTREAM_ERROR` with `data.status` 404.

**Left behind for the lead:** `CONTEXT7_API_KEY` resolves through `op://vps/research-gateway/CONTEXT7_API_KEY`, an item under research-gateway, which P6 archives. Move the ref to a platform-owned item (`.env.tpl`, `dotfiles-private/headless.refs`, `make secrets-seed`) before then.

**`web.package`.** Latest stable version straight from the registry, the golden set's `live:` resolvers made a capability: `registry.npmjs.org/<name>/latest`, `pypi.org/pypi/<name>/json`, `crates.io/api/v1/crates/<name>` (`max_stable_version`; a crate with no stable version is a 404, never a prerelease as `latest`), `api.github.com/repos/<owner/repo>/releases/latest` (`v` and `bun-v` removed; `GITHUB_TOKEN` is used when set, empty counts as unset). `publishedAt` is the release's own date; npm's cheap endpoints carry none, so it is left out rather than guessed. A name that does not fit its registry's pattern, or has a `.`/`..` segment (the GitHub request carries the token), is `BAD_REQUEST`, validated in the input schema only; an unknown package is `UPSTREAM_ERROR` 404. research-gateway's `go` and `docker` lookups are not in the contract.

**Pricing** (N6: a direct `agw web search …` is a `cap.web.search` run `done` with priced usage).

| Call | `Usage` | Cost |
|-|-|-|
| Sonar | `model: sonar`, IU's token counts | `usage.cost.total_cost` as reported, `costSource: provider`; absent: `null`, `unknown`, never 0 |
| Tavily search | `model: tavily-search`, no tokens | credits (the response's `usage.credits`, else 1 basic / 2 advanced per the API-credits page) x `$0.008` |
| Tavily extract | `model: tavily-extract` | `1/5` credit per successful URL (basic: every 5 URLs cost 1 credit; a failed extraction is not billed; the response's `usage.credits` reads 0 for a single URL, measured by research-gateway) x `$0.008`; reported only when a page came back |
| Context7, registries | `model: context7` / the registry | `0`, `costSource: rate` (free) |
| Direct fetch | `model: direct`, no tokens | `0`, `costSource: rate`, once per read that went out (no external service; the run is priced at $0, not unknown); a refused URL sends nothing and reports nothing |

`$0.008` is Tavily's pay-as-you-go list price per credit (docs.tavily.com/documentation/api-credits and tavily.com/pricing, read 2026-10-28). The plan price is lower, so the figure never under-prices; research-gateway carried no USD rate for Tavily at all. It is `TAVILY_USD_PER_CREDIT`.

**Testing.** `fakeWeb(script?)` from `src/web/fake.ts` (built on the web capabilities' own schemas, so it stays here; `web.test.ts` is its only user) returns the four capabilities with the real ids, schemas and CLI shapes and canned results (`{ capabilities, calls }`); a per-capability reply (value, `Error`, or function of the input) scripts it, and each call reports a priced zero-cost usage unless `usage: null`.

## Brain capabilities (`src/brain/`)

The brain agent's tools (Wave 7): read-only search and read over the owner's vault, no model, no network. A direct
read is priced at `$0` (`rate`, like `web.fetch`'s direct read), not `unknown`. The vault is `AGW_BRAIN_DIR`, read on each call
(default `~/SourceRoot/brain`); a path that is no directory is `NOT_CONFIGURED`. The CLI commands are `agw vault …`, not
`agw brain …`: `agw brain "<question>"` is the workflow, and the host refuses a command that is the prefix of another.

| Capability | CLI | Input | Output |
|-|-|-|-|
| `brain.search` | `agw vault search <query> [--max-results n]` | `{ query, maxResults = 20 (1..50) }` | `{ matches: [{ path, line, snippet }], notes, truncated, warnings }` |
| `brain.read` | `agw vault read <note> [--max-chars n]` | `{ note, maxChars = 20000 (1..100000) }` | `{ found: true, path, frontmatter (raw text), body, links, truncated }` or `{ found: false, reason, candidates? }` |

**What is readable.** A positive list (`vault.ts`, `readable`): a `.md` file under `wiki/`, `Areas/` or `Projects/`, or the
root `index.md`. `Inbox/`, `docs/`, `log.md`, every other root file, every dotdir and dotfile, `node_modules` and anything
not `.md` are outside, for search and for read alike. Every comparison is case-insensitive (the vault lives on a case-insensitive file system: `INBOX`, `NODE_MODULES` and `.MD` are the same names). A new top-level directory in the vault stays unreadable until it is
added to the list.

**What cannot get out.** A request path is refused when it is empty, holds a NUL or a backslash, is absolute, has a `..`
segment, is not `.md`, or is not in the readable set; percent escapes are not decoded (`%2e%2e` is a file name, which does
not exist). A path that passes is resolved with `realpath`, and the real path must again be inside the vault's real path
and again readable: a symlink out of the vault, or into `Inbox/`, reads as not found. Refusal and absence give the same
answer (`found: false`), so the answer does not map what exists outside. 

**TOCTOU.** The check and the read are not two steps on a path: `readNote` resolves the path, vets the real path, then reads through **one descriptor** opened with `O_NOFOLLOW`, and that descriptor's `fstat` (device and inode) must equal the `lstat` of the vetted real path. A path swapped for a symlink or another file after the check is refused, not read; the path is never opened a second time. (A hard link to a file outside the vault is out of scope: it needs write access to the vault.)

**Canonical paths.** A tool prints the path of the file it opened, from its `realpath`, in Unicode NFC. A request is matched as typed first, then through the listing by NFC and case-folded comparison, so an NFD file name, a case variant (`WIKI/…/Pinning.MD`) and a `[[name]]` find the same note whether or not the file system folds them; two notes that fold alike are `found: false` with `candidates`. An in-vault symlink is an alias: it reads as the note it points to (canonical path of the target) and is never listed on its own, so a note appears once.

**Decision (owner, 2026-10-29): a symlinked note whose target is outside the vault stays unreadable, and the vault root
is not widened.** The vault today has two (relative links into another repository, which the vault's `AGENTS.md` calls
real notes for Obsidian); the agent cannot read them, and search does not list them. Their content has to be copied into
the vault, or linked to from a note that summarises it, for the brain to answer from it.

**`brain.search`.** Case-insensitive, the query split on whitespace into at most 8 words; a line matches when it holds
any of them. Notes are ranked by how many distinct words they hold, then by matching lines, then by path, so the same
query ranks the same; at most 3 lines per note and `maxResults` lines in all, `truncated` says there were more (over `maxResults`, or a note had more than 3 matching lines). Words are tested with escaped case-insensitive regexes on the very (NFC) line the snippet is cut from. One listing per call; a tree over 20,000 notes stops there and says so in `warnings`. A
snippet is the line cut to 200 characters around the first match. Not ripgrep: no regex, so there is no pattern that
can run long on the event loop, and no binary to depend on; the whole vault (about 300 notes) is read per call.

**`brain.read`.** `note` is a vault-relative path, or `[[name]]` (alias and `#heading` ignored). A name is an exact path
first, then the one path that ends in the name (Obsidian's rule: `b/dup` and `dup` both find `wiki/b/dup.md`), compared
case-insensitively; two matches are `found: false` with the `candidates`. `frontmatter` is the raw text between the `---` fences, **not parsed** (a YAML parser expands anchors and aliases: a few nested lines become gigabytes), `""` when there is none; `links` are the body's `[[wikilink]]` targets, found in one linear pass (a line of `[[[[…` costs one step per character).
`maxChars` covers the whole result: the frontmatter is cut to at most half of it, the body gets the rest, each with a `[truncated: n more characters]` marker. A note is read up to 1 MB. The body is
untrusted data: a note may say anything.

## Tests

`bun test packages/capabilities` (Bun's `--isolate` runs it under `make check`):

- `registry.test.ts`: in-process and HTTP (`Bun.serve`, port 0) agree on results and on typed errors; the OpenAPI document; definition rules.
- `capabilities.test.ts`: each capability against a fake gateway through the production adapters: request wire, usage and cost via `ctx.addUsage`, `rate` when the provider omits cost (cache tokens priced per bucket), `unknown` when a cache rate is missing, schema-failure re-ask.
- `transports.test.ts`: retries, fail-fast statuses, cancel, idle watchdog.
- `gateway.test.ts`: `gatewayConfig` (required, no IU fallback, no echo), `gatewayHeaders` (a non-ASCII or over-long value dropped), the headers each wire sends (`x-agw-fallback: none` on `anthropic` only), and a real Haiku 5.5 response with 1 h cache writes (`src/fixtures/anthropic-1h-cache-write.json`, id redacted) priced at the 1 h rate.
- `fallback.test.ts`: the gateway's own 402 on the `anthropic` wire moves the call to the route's GPT fallback; 402, the 503 balance body and Anthropic's 400 credit-balance body (its sentence past the 300-char cut) each make one fallback call (priced, its model recorded); a 503 without the text is retried on the primary only; a 400 without Anthropic's sentence gets no fallback; a failing fallback answers the primary's error; a re-ask stays on the fallback; an `anthropic` route falls back over chat; an arm's patch moves or removes the fallback; `triage` (402 balance, completeJson through the fallback).
- `web/web.test.ts`: the web capabilities against a fake network: Sonar mapping, cost and the fallback rule, Tavily credit pricing, the SSRF refusals (schemes, loopback, private, tailnet, metadata, IPv6 forms, a name that resolves privately, a redirect to a private IP, a second hop), DNS rebinding (a resolver that turns private after the guard is never asked again and the request is pinned per hop), the pinned transport against a local server, hostile 2 MB bodies, `parseHtml` edge cases (entities, separators), the streamed read cap, pinned-transport hardening (undecodable and stacked encodings, a failing gzip body), an unresolvable host, the byte-cap flag, charsets, empty and binary reads, truncation, the Extract chain, the typed errors, registry and OpenAPI shape, `fakeWeb`.
- `brain/brain.test.ts`: both capabilities on a temp vault with a secret outside it: search (scope, ranking, caps, snippets, priced `$0`), read (path, wikilink forms, ambiguity, frontmatter edge cases, truncation), and 27 refused reads (`..`, absolute, symlinks out of the vault and into `Inbox/`, `Inbox/`, dotdirs, `node_modules`, `docs/`, `log.md`, encoded names, backslash, NUL, wikilink escapes), `NOT_CONFIGURED`.
- `live.test.ts`: one real call per capability, **skipped unless `AGW_LIVE=1`** (the skipped names say so). It costs well under $0.001:

  ```sh
  AGW_LIVE=1 secrets-run run --env-file=.env.tpl -- bun test packages/capabilities
  ```

## HyperDX capabilities (`src/hdx/`)

The HyperDX / ClickStack HTTP API (concept N7), ported from `hdx.py`: the MCP endpoint (`POST <base>/api/mcp`, stateless JSON-RPC answered as SSE) and REST v2 (`<base>/api/api/v2`), one bearer key per environment. Every capability takes `env: 'local' | 'prod'` (default `prod`). A call costs no money and records `Usage` `{ model: 'hyperdx', cost: 0, costSource: 'rate' }`: a known price of 0, so it never counts as unpriced (`web.fetch`'s direct read is the precedent). Spans come from the middleware around every step, like any capability.

### Who may be granted what

| Capability | Door | Notes |
|-|-|-|
| `hdx.tools`, `hdx.guide`, `hdx.query`, `hdx.link` | **agent-safe**: may be granted through the tool gate | `hdx.query` runs the 20 tools of `AGENT_READ_TOOLS` and nothing else |
| `hdx.rest`, `hdx.write` | **CLI only**: never granted to an agent | `hdx.write` is `cli.mutating`; `hdx.rest` is a generic GET of the REST API, whose reads the MCP tools already cover |

The grantable set is a constant, not prose: `AGENT_SAFE_HDX` (and `CLI_ONLY_HDX`) are exported from `src/hdx/allowlist.ts` and the package root, and a grant must draw from `AGENT_SAFE_HDX`. A test pins that every `hdx.*` capability is in exactly one of the two lists (a new one cannot ship unclassified) and that every grantable one is non-mutating. A gate-level refusal of mutating capabilities is the otel PR's.

An agent-facing read boundary that rests on a server annotation alone is too thin, so it is narrowed by name:

- **Allowlist, not denylist** (`src/hdx/allowlist.ts`). `hdx.query` validates `tool` against `AGENT_READ_TOOLS` in the input schema: a mutating or unknown tool is a `400 BAD_REQUEST` on every door, nothing sent. A ClickStack upgrade that adds a tool leaves it refused until it is read and added. `hdx.write` refuses exactly those 20 tools (use `hdx.query`), so the two never overlap.
- **`clickstack_sql` is CLI-only.** The server annotates it `readOnlyHint: true`, but it runs raw ClickHouse SQL under the connection's credentials; the annotation is a claim, and whether the connection's user can write was not proven (no local ClickStack was reachable when this was built). Until it is proven on local, it is reachable through `hdx.write` only. The builder tools (`clickstack_table`, `clickstack_timeseries`, `clickstack_search`, …) cover single-table queries; the tool's own description calls raw SQL the last resort.
- **`clickstack_get_webhook` is CLI-only.** It lists the webhook destinations, the channel configuration alerts notify through. On prod it returned only `id`, `name`, `service` (no URL), and `clickstack_get_alert` returns `webhookId` references, no destination secrets; the tool stays off the agent path anyway, since a future version could add the URL. `clickstack_get_alert` stays agent-readable.
- `hdx.tools` marks each tool `queryable` (accepted by `hdx.query`) and passes the server's `readOnlyHint` along. The opt-in live test compares both lists with the server's annotations in both directions.

| `hdx.py` | Capability | `agw` |
|-|-|-|
| `tools`, `schema [tool]` | `hdx.tools` | `agw hdx tools [name]`: no name lists `{ name, summary, queryable, readOnlyHint }`; a name adds the description and the `inputSchema` as JSON text. Folded into one |
| `instructions`, `prompt <name>` | `hdx.guide` | `agw hdx guide [prompt]`: no prompt returns the server's tool-selection instructions, else that prompt (`query_guide`). Folded into one |
| `call <tool>` (reads) | `hdx.query` | `agw hdx query <tool> '<json>'` |
| `call <tool>` (mutating, sql, webhooks), `rest POST\|PUT\|PATCH\|DELETE` | `hdx.write` | `agw hdx write …`: needs `--commit` off a TTY |
| `rest GET` | `hdx.rest` | `agw hdx rest <path>` |
| `link <id> --last` | `hdx.link` | `agw hdx link <id> [--last 24h]`: needs no key |
| `call --raw` | dropped | the JSON-RPC envelope adds nothing over `isError` + `text` |

### Behaviour

- **The key stays with its host.** Redirects are never followed (`redirect: 'manual'`): a 3xx is `UPSTREAM_ERROR`. A base URL must be https, or http on `localhost`, `127.0.0.1` or `[::1]`, with no credentials, query or fragment; anything else is `NOT_CONFIGURED`.
- **Bounded reads.** An error body is read to 64 KiB, a success body to 4 000 000 bytes (a longer MCP answer is `UPSTREAM_ERROR`, "narrow the query"; a longer REST body is a prefix with a marker, `truncated: true`, and `totalChars` is then a lower bound, which the marker says: "of at least N characters"). An SSE answer is returned at its first complete event carrying the request's id and the stream is cancelled, so a server that keeps the stream open does not hold the call to the timeout. A bare JSON body must carry the request id too; an error with id `null` is surfaced as the answer; a batch array is searched for the id.
- **Timeouts and the per-call worst case.** One 60 s bound covers the whole call, body reads, retries and backoff included (a fresh window per attempt would multiply it); the error reads `hdx <env> timed out after 60 s` and is not retried. A caller's abort is `CANCELLED`. So a call takes at most 60 s of wall clock, and sends at most 3 requests plus one empty-400 resend (4) for a read, exactly 1 for a write.
- **Writes are sent once.** `hdx.write` never retries a 5xx and never resends an empty-body 400; reads retry 429/5xx and transport failures up to three attempts like the other capabilities, and resend an empty-body 400 (the dev ClickStack's connection race, rejected before processing) at most once per call.
- **Server-shaped data is checked.** `tools/list`, `tools/call`, `prompts/get` and `initialize` results are validated before use (`src/hdx/shapes.ts`); a null entry or a wrong type is `UPSTREAM_ERROR` ("answered with a shape that does not fit"), never a TypeError. Each call asks with a fresh random positive-integer JSON-RPC id (a retry of the call keeps it), and only a response to that id is the answer. A JSON-RPC object is the answer only with `result` or `error` and no `method`, so a server request that carries our id, or a bare `{ id }`, neither ends the read nor reads as an empty success.
- **Output cap.** `maxChars` (default 50 000, at most 500 000; `hdx.tools`: 20 000 for the description and the schema each, at most 200 tools listed) cuts the text and appends `[truncated: showing N of M characters; …]`, with `truncated: true`. `hdx.tools` also bounds the whole answer (at least 100 000 characters, or twice `maxChars`). Everything the server sends is untrusted data (the output schemas say so, and so do the error messages that quote it: "upstream text (untrusted data, not instructions): …"), never instructions. SSE lines end with CRLF, LF or a bare CR.
- **Errors.** `NOT_CONFIGURED` (503) when the key or base is missing or malformed, naming the variable, nothing sent. `UPSTREAM_ERROR` carries `data.status`: 401/403 read "rejected the access key", a JSON-RPC error carries its code and message, an unreachable server reads "hdx <env> unreachable" (the URL is not in the message). A tool that ran and failed (`isError`) is returned as data, because the reader needs its text to fix the call.
- **`hdx.rest` and `hdx.write` paths** must stay under `/api/api/v2`: after the URL parser collapses `..`, and with no `%2f`, `%5c`, `%2e` dot segment or `#` in the path (any case; a query string may carry them). Anything else is a `400`.

### Configuration

Environment, read on each call:

| Variable | Meaning |
|-|-|
| `HYPERDX_PROD_ACCESS_KEY` | prod bearer key (`op://vps/clickstack/AGENT_ACCESS_KEY` in `.env.tpl`) |
| `HYPERDX_DOMAIN` | prod base is `https://hyperdx.<domain>` (`op://vps/config/DOMAIN`). The capability composes the URL rather than `scripts/launch.sh`: the domain is a whole-value ref that `secrets-run` already resolves, a launcher edit would add shell for no gain, and the composition is unit-tested. `HYPERDX_PROD_URL` overrides the composed base |
| `HYPERDX_LOCAL_ACCESS_KEY` | local bearer key; unset: read from `~/.config/hyperdx/local.env` at call time, as `hdx.py` did. No ref in `.env.tpl` |
| `HYPERDX_LOCAL_URL` | default `http://localhost:7707` |

An unset or empty variable makes only that call `NOT_CONFIGURED`; the rest of the host is unaffected. A different thing: the two prod refs are in `.env.tpl`, and `scripts/launch.sh` refuses to start the whole host (exit 78) when any `.env.tpl` ref does not resolve from the secrets cache. Both refs are in the cache today; a new one must be seeded before the deploy that needs it.

No key or URL is logged or put in an error message. `createCapabilities(llmDeps, webDeps, hdxDeps)` registers all six; `HdxDeps` injects `fetch`, `env`, `readLocalEnvFile`, `retry`, `now` and `timeoutMs`. Tests (`src/hdx/hdx.test.ts`) run against a fake HyperDX on a real socket speaking the SSE framing; `src/hdx/hdx.live.test.ts` reaches a real one with `AGW_LIVE_HDX=local,prod` and prints counts only.
