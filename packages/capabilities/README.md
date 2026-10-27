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
- Errors come out of `call` as `CapabilityCallError` with the same fields as the HTTP body: `{ defined, code, status, message, data }`. Callers never see the HTTP framework's error class.
- Registering the same id twice, a taken `METHOD path`, or an id nested under another id throws at `createRegistry`.

### `ctx` and usage

```ts
type Usage = {
  model: string
  tokens: { input: number; output: number; cacheRead: number; reasoning: number }
  cost: number | null
  costSource: 'provider' | 'rate' | 'unknown'
}
```

Tokens are the raw provider counts: `input` includes cache reads, `output` includes reasoning. The Argo projection normalises later. `cost` is the provider's `usage.cost`, else the route's rate, else `null` with `costSource: 'unknown'`, never 0 (`costFromUsage` in routes). A re-ask after a rejected answer reports each attempt, and a call whose content turned out unusable is reported before the error is thrown. Adapters report every attempt that came back with usage, including one that then failed (a stream cut before its finish chunk, a 200 whose body does not fit), through an `onUsage` hook on the port. The transport's own retries of requests that returned no usage (429, 5xx, a reset) report nothing. A call that returned no usage at all is reported with zero tokens and `unknown` cost. A stream that ends without a finish chunk counts as a dropped connection and is retried; a body that cannot be read or parsed is retried, and parsed JSON that does not fit the schema is not.

The runtime package defines its own step `addUsage`. This one is structurally identical (`Ctx.addUsage: (usage: Usage) => void`); the lead reconciles the type at merge.

### Typed errors

Declared on every operation (they land in the OpenAPI document), keyed by `code` so the CLI generator can map them to exit codes. Input validation failures are oRPC's `BAD_REQUEST` (400, `defined: false`); anything else a handler throws is an opaque `INTERNAL_SERVER_ERROR`.

| Code | Status | Meaning |
|-|-|-|
| `NOT_CONFIGURED` | 503 | `IU_API_KEY` or `IU_BASE_URL` missing or malformed, a bad `AGW_ROUTES`, or a route on a wire that is not a single call. Nothing was sent. Messages name the variable, never a value |
| `UPSTREAM_ERROR` | 502 | the provider was unreachable or answered with an error status after retries; `data.status` when there was one. Also an empty or refused answer |
| `INVALID_OUTPUT` | 502 | the answer failed the schema after one re-ask; `data: { attempts, reason }` |
| `OUTPUT_TRUNCATED` | 502 | the output ceiling ended the answer; `data.reason` is `starved` (reasoning ate it, no text) or `truncated` |
| `CANCELLED` | 499 | the caller's signal aborted |

### `x-cli`

Every operation carries `x-cli`, with defaults filled in: `{ command, positional, mutating, defaultFormat, stdin?, plainField? }`. Flags come from the input schema's properties that are not positional. `stdin` names the input property that is read from stdin when it is not given as an argument or flag. It is new in this package (the S3 spike's `x-cli` had no equivalent), so the Wave 3 generator must read it. The block is attached through one `spec` callback in `procedure.ts`.

## Transports

Ports and adapters: `ChatPort` (`iu-openai` and `iu-anthropic` both implement it), `DecisionPort` (`iu-decision`). The production adapters live in `src/transports/`, in-memory fakes and a fake IU server on a real socket in `src/testing/` (exported as `@agent-workflows/capabilities/testing`).

| Adapter | Wire | Behaviour ported from agent-gateway |
|-|-|-|
| `iuOpenai` | `POST <origin>/openai/v1/chat/completions`, SSE with `include_usage` | idle watchdog only (5 min without a chunk, never a wall-clock cap), 3 attempts at 0.5 s / 1.5 s on 429/5xx and network errors, 410 and client errors fail fast, an upstream `invalid_request_error` wrapped in a 503 is not retried, `max_completion_tokens` (reasoning tokens count against it), no `temperature`, `reasoning_effort` only when the route has an effort |
| `iuAnthropic` | `POST <IU_BASE_URL>/v1/messages`, one non-streamed request | 30 min hang guard (not retried), same retry rules, `thinking: adaptive` plus `output_config.effort` only when the route has an effort, `max_tokens` as the ceiling |
| `iuDecision` | `POST <origin>/decisions/v1/systemone` | boolean questions go as `noul`, choice options as `criteria`; same retry rules |

Credentials come from the environment only: `IU_API_KEY` and `IU_BASE_URL` (ending in `/anthropic`; the other two bases derive from it). They are read on each call, so importing the package never fails without them. `.env.tpl` holds the `op://` references; resolve with `secrets-run run --env-file=.env.tpl -- <cmd>`. There is no keychain fallback.

**Decision API: direct HTTP, no `ai` or `@ai-sdk/typesafe-ai`.** The provider package is a 200-line adapter over one `POST /systemone` with a three-variant response (checked against `@ai-sdk/typesafe-ai` 3.0.17 in the frozen gateway). `ai`'s `decide` adds input validation and an answer sanity check; the capability validates both itself (zod on the wire body, every asked question answered, a choice among its options). The dependency would pull in `ai`, the provider and their trees for that. The gateway's own `decide` test fixtures (choice, `noul`, missing confidence falling back to the option's probability) are ported.

Content failures (`stop_reason: max_tokens`, empty text, a refusal or any non-final stop) are judged once in `src/llm/model-call.ts`, after usage is reported. JSON answers are parsed loosely (code fence, prose around the object), validated, re-asked once with the rejection reason, then `INVALID_OUTPUT`; a transport failure is never re-asked, so a retry cannot bill twice.

## Capabilities

All four are `POST` with a JSON body. The model comes from the route; override with `AGW_ROUTES` (see the routes README).

### `llm.summarize` — route `cheap.summarize` (`iu-anthropic`)

`agw llm summarize [text] [--max-words 100] [--format paragraph|bullets]`, text from stdin when omitted. Input `{ text, maxWords = 100, format = 'paragraph' }`, output `{ summary }`.

**Token effect / cache effect.** Cost grows with the text: the whole input is sent once, output is capped by `maxWords` in the prompt (the ceiling is `maxOutputTokens`, default 8192, or 32000 when the route has an effort). The system prompt is fixed and first, so repeated calls share a cacheable prefix; the text follows it. IU's Messages wire reports no cost, so `costSource` is `unknown` unless the route carries a `rate`. A route flip to a model with an effort turns adaptive thinking on: reasoning tokens bill as output and count against the ceiling.

### `llm.title` — route `cheap.title` (`iu-anthropic`)

`agw llm title [text] [--max-words 8]`. Input `{ text, maxWords = 8 }`, output `{ title }`. The first non-empty line is kept, with a leading `#`, a `Title:` label, quotes and a final period removed; nothing left is `INVALID_OUTPUT`.

**Token effect / cache effect.** Output is a handful of tokens, so cost is almost all input. Same fixed-prefix layout and unknown cost as `llm.summarize`. Titling a text you already summarized with `llm.summarize` is cheaper on the summary than on the original.

### `llm.classify` — route `cheap.classify` (`iu-openai`)

`agw llm classify [text] --labels '{"bug":"something is broken","feature":"a new behaviour"}'`. Input `{ text, labels }` where `labels` maps each label to what it means (at least two); output `{ label, reason }` with `label` exactly one of the keys, validated per call. JSON mode is requested; a wrong label or unparseable answer is re-asked once with the reason.

**Token effect / cache effect.** The label list and the instruction come first and the text last, so the prefix is identical across calls with the same labels and the provider's prompt cache applies (`cacheRead` is reported; the cost in `usage.cost` already reflects it). The model reasons, so `output` includes reasoning tokens, and `max_completion_tokens` is the route's 16000 so reasoning cannot starve the answer. A failed first answer costs a second full call. Cost is the provider's.

### `decide` — route `decide` (`iu-decision`)

`agw decide --questions '{"q":{"type":"choice","instructions":"…","options":{"a":"…","b":"…"}}}'`, state from stdin; JSON output. Input `{ state, questions }` where each question is `choice` (`options`: id → description, 2 to 255) or `boolean`. Output `{ answers, model, truncatedChars }`: a choice answers `{ choice, confidence, probabilities }`, a boolean `{ value, confidence, probability }` (`probability` is P(true), `value` is `probability >= 0.5`). The API rounds probabilities to two decimals. The model cannot search or read anything: `state` is its whole world. State beyond 60 000 characters is cut and reported in `truncatedChars`.

**Token effect / cache effect.** There is no generated text, so output is a few tokens and cost is the input at the route's rate (`costSource: 'rate'`, because the decision API drops IU's own cost). More questions in one call share one state, which is the cheap way to ask: the state is paid for once. No cache effect is reported on this wire. Changing the model through `AGW_ROUTES` drops the rate, so cost reads `unknown` until a new rate is supplied.

## Tests

`bun test packages/capabilities` (Bun's `--isolate` runs it under `make check`):

- `registry.test.ts`: in-process and HTTP (`Bun.serve`, port 0) agree on results and on typed errors; the OpenAPI document; definition rules.
- `capabilities.test.ts`: each capability against a fake IU server through the production adapters: request wire, usage and cost via `ctx.addUsage`, `unknown` when the provider omits cost, schema-failure re-ask.
- `transports.test.ts`: retries, fail-fast statuses, cancel, idle watchdog.
- `live.test.ts`: one real call per capability, **skipped unless `AGW_LIVE=1`** (the skipped names say so). It costs well under $0.001:

  ```sh
  AGW_LIVE=1 secrets-run run --env-file=.env.tpl -- bun test packages/capabilities
  ```
