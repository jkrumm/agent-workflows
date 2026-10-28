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
| `NOT_CONFIGURED` | 503 | `IU_API_KEY` or `IU_BASE_URL` missing or malformed, a bad `AGW_ROUTES`, or a route on a wire that is not a single call. Nothing was sent. Messages name the variable, never a value |
| `UPSTREAM_ERROR` | 502 | the provider was unreachable or answered with an error status after retries; `data.status` when there was one. Also an empty or refused answer |
| `INVALID_OUTPUT` | 502 | the answer failed the schema after one re-ask; `data: { attempts, reason }` |
| `OUTPUT_TRUNCATED` | 502 | the output ceiling ended the answer; `data.reason` is `starved` (reasoning ate it, no text) or `truncated` |
| `URL_REFUSED` | 422 | `web.fetch` will not fetch the URL (not http(s), credentials in it, an internal name, or a non-public address, on the first URL or on a redirect hop). Nothing was sent. The CLI maps 422 to its usage exit code |
| `CANCELLED` | 499 | the caller's signal aborted |

### `x-cli`

Every operation carries `x-cli`, with defaults filled in: `{ command, positional, mutating, defaultFormat, kind, stdin?, plainField?, resume? }`. Flags come from the input schema's properties that are not positional. `kind` is `capability` here; the host's workflow and run operations set `workflow` and `run`, and `resume` (`{ command, positional }`, the command that continues a still-running workflow) rides on workflows only. The host attaches the same block to its own operations through the exported `withCli`, and merges a registry into its router through `registry.router` and `registry.requestContext` (see the host README). `stdin` names the input property that is read from stdin when it is not given as an argument or flag. It is new in this package (the S3 spike's `x-cli` had no equivalent), so the Wave 3 generator must read it. The block is attached through one `spec` callback in `procedure.ts`.

## Transports

Ports and adapters: `ChatPort` (`iu-openai` and `iu-anthropic` both implement it), `DecisionPort` (`iu-decision`). The production adapters live in `src/transports/`, in-memory fakes and a fake IU server on a real socket in `src/testing/` (exported as `@agent-workflows/capabilities/testing`).

| Adapter | Wire | Behaviour ported from agent-gateway |
|-|-|-|
| `iuOpenai` | `POST <origin>/openai/v1/chat/completions`, SSE with `include_usage` | idle watchdog only (5 min without a chunk, never a wall-clock cap), 3 attempts at 0.5 s / 1.5 s on 429/5xx and network errors, 410, client errors and provider-balance failures fail fast, an upstream `invalid_request_error` wrapped in a 503 is not retried, `max_completion_tokens` (reasoning tokens count against it), no `temperature`, `reasoning_effort` only when the route has an effort |
| `iuAnthropic` | `POST <IU_BASE_URL>/v1/messages`, one non-streamed request | 30 min hang guard (not retried), same retry rules, `thinking: adaptive` plus `output_config.effort` only when the route has an effort, `max_tokens` as the ceiling |
| `iuDecision` | `POST <origin>/decisions/v1/systemone` | boolean questions go as `noul`, choice options as `criteria`; same retry rules |

Credentials come from the environment only: `IU_API_KEY` and `IU_BASE_URL` (ending in `/anthropic`; the other two bases derive from it). They are read on each call, so importing the package never fails without them. `.env.tpl` holds the `op://` references; resolve with `secrets-run run --env-file=.env.tpl -- <cmd>`. There is no keychain fallback.

**Decision API: direct HTTP, no `ai` or `@ai-sdk/typesafe-ai`.** The provider package is a 200-line adapter over one `POST /systemone` with a three-variant response (checked against `@ai-sdk/typesafe-ai` 3.0.17 in the frozen gateway). `ai`'s `decide` adds input validation and an answer sanity check; the capability validates both itself (zod on the wire body, every asked question answered, a choice among its options). The dependency would pull in `ai`, the provider and their trees for that. The gateway's own `decide` test fixtures (choice, `noul`, missing confidence falling back to the option's probability) are ported.

**Provider-balance fallback.** A 402, or a 503 whose body says "Insufficient Balance" / "PaymentRequired" (`isBalanceFailure` in `@agent-workflows/routes`, the one classifier), fails fast in the transport (no retry of the primary) with `provider balance exhausted` in the `UPSTREAM_ERROR` message. `complete` then calls the route's `fallback` once (`fallbackRoute`; its own wire, model, effort, ceiling and rate) and logs it (`LlmDeps.warn`, default `console.warn`). Usage is reported under the model that ran, priced by `usage.cost` or the fallback's rate. A re-ask after a rejected answer stays on the route that answered. When the fallback fails too, the primary's error is thrown. `review.adversary` asks through `complete` too, with its own effort (`effort`) and its own judgment of an empty answer (`raw`: the answer comes back unjudged); its re-ask stays on the route that answered. A caller's `effort` is for the primary: a fallback always runs at its own route's effort.

Content failures (`stop_reason: max_tokens`, empty text, a refusal or any non-final stop) are judged once in `src/llm/model-call.ts`, after usage is reported. JSON answers are parsed loosely (code fence, prose around the object), validated, re-asked once with the rejection reason, then `INVALID_OUTPUT`; a transport failure is never re-asked, so a retry cannot bill twice.

## Capabilities

All four are `POST` with a JSON body. The model comes from the route; override with `AGW_ROUTES` (see the routes README).

### `llm.summarize` — route `cheap.summarize` (`iu-anthropic`)

`agw llm summarize [text] [--max-words 100] [--style paragraph|bullets]`, text from stdin when omitted. Input `{ text, maxWords = 100, style = 'paragraph' }`, output `{ summary }`.

**Token effect / cache effect.** Cost grows with the text: the whole input is sent once, output is capped by `maxWords` in the prompt (the ceiling is `maxOutputTokens`, default 8192, or 32000 when the route has an effort). The system prompt is fixed and first, so repeated calls share a cacheable prefix; the text follows it. IU's Messages wire reports no cost, so the cost comes from the route's Haiku 5.5 EU `rate` (`costSource: 'rate'`), cache reads and writes at their own rates. Prompts over 100K tokens bill at 5x on the vendor list; `Rate` has no tier for that, so such a call reports `unknown` cost rather than an under-price. A route flip to a model with an effort turns adaptive thinking on: reasoning tokens bill as output and count against the ceiling.

### `llm.title` — route `cheap.title` (`iu-anthropic`)

`agw llm title [text] [--max-words 8]`. Input `{ text, maxWords = 8 }`, output `{ title }`. The first non-empty line is kept, with a leading `#`, a `Title:` label, quotes and a final period removed; nothing left is `INVALID_OUTPUT`.

**Token effect / cache effect.** Output is a handful of tokens, so cost is almost all input. Same fixed-prefix layout and rate-based cost as `llm.summarize`. Titling a text you already summarized with `llm.summarize` is cheaper on the summary than on the original.

### `llm.classify` — route `cheap.classify` (`iu-openai`)

`agw llm classify [text] --labels '{"bug":"something is broken","feature":"a new behaviour"}'`. Input `{ text, labels }` where `labels` maps each label to what it means (at least two); output `{ label, reason }` with `label` exactly one of the keys, validated per call. JSON mode is requested; a wrong label or unparseable answer is re-asked once with the reason.

**Token effect / cache effect.** The label list and the instruction come first and the text last, so the prefix is identical across calls with the same labels and the provider's prompt cache applies (`cacheRead` is reported; the cost in `usage.cost` already reflects it). The model reasons, so `output` includes reasoning tokens, and `max_completion_tokens` is the route's 16000 so reasoning cannot starve the answer. A failed first answer costs a second full call. Cost is the provider's.

### `decide` — route `decide` (`iu-decision`)

`agw decide --questions '{"q":{"type":"choice","instructions":"…","options":{"a":"…","b":"…"}}}'`, state from stdin; JSON output. Input `{ state, questions }` where each question is `choice` (`options`: id → description, 2 to 255) or `boolean`. Output `{ answers, model, truncatedChars }`: a choice answers `{ choice, confidence, probabilities }`, a boolean `{ value, confidence, probability }` (`probability` is P(true), `value` is `probability >= 0.5`). The API rounds probabilities to two decimals. The model cannot search or read anything: `state` is its whole world. State beyond 60 000 characters is cut and reported in `truncatedChars`.

**Token effect / cache effect.** There is no generated text, so output is a few tokens and cost is the input at the route's rate (`costSource: 'rate'`, because the decision API drops IU's own cost). More questions in one call share one state, which is the cheap way to ask: the state is paid for once. No cache effect is reported on this wire. Changing the model through `AGW_ROUTES` drops the rate, so cost reads `unknown` until a new rate is supplied.

## Web capabilities (`src/web/`)

research-gateway's tools as capabilities (Wave 6), behaviour ported and code rewritten (concept N3). No model: every call is an HTTP request with its own timeout, the package's `withRetries` (3 attempts at 0.5 s / 1.5 s on 429/5xx and resets; a timeout is not retried), and a priced `Usage`. Credentials come from the environment on each call: `IU_API_KEY` + `IU_BASE_URL` (Sonar), `TAVILY_API_KEY`, `CONTEXT7_API_KEY`, optional `GITHUB_TOKEN`, `SEARCH_PROVIDER`, `SONAR_MODEL`. `.env.tpl` carries the same `op://` refs research-gateway reads, so no new item exists. `createCapabilities(llmDeps, webDeps)` registers all four; `WebDeps` injects `fetch`, DNS `resolve`, `env`, `retry` and `warn`.

| Capability | CLI | Input | Output |
|-|-|-|-|
| `web.search` | `agw web search <query> [--max-results n] [--depth basic\|advanced]` | `{ query, maxResults = 8 (1..20), depth = 'basic' }` | `{ results: [{ url, title, snippet, publishedAt? }], provider: 'sonar'\|'tavily' }` |
| `web.fetch` | `agw web fetch <url> [--max-chars n]` | `{ url, maxChars = 20000 (1..200000) }` | `{ url, finalUrl, title?, text, truncated, via: 'direct'\|'tavily-extract' }` |
| `web.docs` | `agw web docs <library> [--topic t] [--tokens n]` | `{ library, topic?, tokens? }` | `{ text, source }` |
| `web.package` | `agw web package <registry> <name>` | `{ registry: 'npm'\|'pypi'\|'crates'\|'github-release', name }` | `{ name, latest, publishedAt?, url }` |

**`web.search`.** Sonar over IU's OpenAI-compatible endpoint is the default, Tavily the per-call fallback, as measured in research-gateway: the Sonar answer is thrown away (it hallucinates under confidence; only `search_results` are used), `max_tokens` is the API's floor of 16, a 429 gets one retry (two attempts), then any Sonar failure, a 200 with no `search_results` included (IU routing Sonar through a normalizing tier drops them), moves to Tavily. `SEARCH_PROVIDER=tavily` skips Sonar. A cancelled call does not fall back. Both failing answers the primary's error; neither configured is `NOT_CONFIGURED`. `depth` is Tavily's `search_depth`; for Sonar `basic` is `search_context_size: low` and `advanced` is `medium` (longer snippets, not more sources, per research-gateway's measurement). Not ported: the per-run query cache, the search budget and the dual-backend merge, which belong to a caller.

**`web.fetch` chain.** Direct read (manual redirects, 10 s per hop, 5 hops, body cut at 2 MB) then Tavily Extract (basic) when the direct read is blocked or errors (403, 429, 5xx, a reset), is empty or has no text, is not text (PDF; a response without a Content-Type is judged on its bytes: a NUL in the first kilobyte or a known binary signature is not text), or is a script-built shell (under 200 characters of text, a `<script>`, text under a tenth of the markup). A 404/410 ends the chain without the paid step. A thin page nobody can improve is returned rather than an error. The body is decoded by the Content-Type charset, else `<meta charset>` in the first 2 KB, else UTF-8 (an unknown label is UTF-8). **Decision: Lightpanda, the site adapters, Wayback, yt-dlp and the human-solve path are not carried.** They are research-gateway's answers to JS-rendered pages, specific sites and anti-bot walls; the golden set (28 items: RFCs, registry versions, docs pages, Wikipedia-style facts) is search plus plain pages, which the direct read and Extract cover, and each adapter drags in a process, a binary or a human. Add one when a golden item or a live run shows a miss it would fix.

**HTML to text** (`text.ts`) is a single forward pass, no regex over the body: the body is hostile input scanned on the event loop, and backtracking patterns over unclosed `<script `, `<article>` or `<title` openings go quadratic. Every search resumes where the last ended, so the work is linear in the size however many tags are left open (`web.test.ts` runs ten hostile 2 MB shapes, 5-500 ms each on an idle host, asserted under 4 s). `script`, `style`, `title`, `noscript`, `svg`, `template`, `iframe` and comments go with their content (an element that never closes swallows the rest, as in a browser). **Every other tag is dropped and its content kept, `form`, `nav` and `button` included**: ASP.NET wraps a whole page in one `<form>`, and a menu kept costs a few lines where a page dropped costs the answer. The text inside `<main>` wins when there is any, then `<article>`, else the whole body.

**SSRF guard and connection pinning** (`ssrf.ts`, `pinned.ts`). On the first URL and on every redirect hop, before anything is sent: only `http`/`https`; no credentials in the URL; no `localhost`, `*.local`, `*.internal`, `*.localhost`, `*.localdomain`, `*.lan`, `*.home.arpa`, `*.ts.net`; then every address the name resolves to must be public: IPv4 `0/8 10/8 100.64/10 (the tailnet) 127/8 169.254/16 (cloud metadata) 172.16/12 192.0.0/24 192.0.2/24 192.88.99/24 192.168/16 198.18/15 198.51.100/24 203.0.113/24 224/4+`, IPv6 outside `2000::/3`, `2001:db8::/32`, and IPv4 embedded in mapped, compatible, translated, NAT64 and 6to4 forms. Unparseable fails closed. A refusal is `URL_REFUSED` (422). **The vetted addresses are the ones connected to.** `fetch` resolves the name again at connect time, so a resolver that answers public to the guard and private to the connect (DNS rebinding) would walk past a check-then-fetch. The guard returns its addresses, and the request goes through `node:http(s)` with a `lookup` that returns only those, so DNS is asked once per hop and never again; the URL keeps the page's host name, so the Host header and the TLS server name (SNI and the certificate check) are the page's own. Redirects are followed by hand, each hop vetted and pinned to its own addresses. `agent: false`, `Accept-Encoding: identity` (gzip, deflate and br are still decoded if a server sends them). Page text is returned as data; nothing in it is interpreted. The search, docs, registry and Tavily calls go to fixed hosts and use the plain `fetch`.

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
| Direct fetch | none | no external service |

`$0.008` is Tavily's pay-as-you-go list price per credit (docs.tavily.com/documentation/api-credits and tavily.com/pricing, read 2026-10-28). The plan price is lower, so the figure never under-prices; research-gateway carried no USD rate for Tavily at all. It is `TAVILY_USD_PER_CREDIT`.

**Testing.** `fakeWeb(script?)` from `@agent-workflows/capabilities/testing` returns the four capabilities with the real ids, schemas and CLI shapes and canned results (`{ capabilities, calls }`); a per-capability reply (value, `Error`, or function of the input) scripts it, and each call reports a priced zero-cost usage unless `usage: null`.

## Tests

`bun test packages/capabilities` (Bun's `--isolate` runs it under `make check`):

- `registry.test.ts`: in-process and HTTP (`Bun.serve`, port 0) agree on results and on typed errors; the OpenAPI document; definition rules.
- `capabilities.test.ts`: each capability against a fake IU server through the production adapters: request wire, usage and cost via `ctx.addUsage`, `rate` when the provider omits cost (cache tokens priced per bucket), `unknown` when a cache rate is missing, schema-failure re-ask.
- `transports.test.ts`: retries, fail-fast statuses, cancel, idle watchdog.
- `fallback.test.ts`: 402 and the 503 balance body each make one fallback call (priced, its model recorded); a 503 without the text is retried on the primary only; a failing fallback answers the primary's error; a re-ask stays on the fallback; an `iu-anthropic` route falls back over chat; `AGW_ROUTES` patches or removes the fallback; `review.adversary` (402 and 503 balance, the fallback at its own effort, its re-ask too, no fallback on a plain 503) and `review.route`.
- `web/web.test.ts`: the web capabilities against a fake network: Sonar mapping, cost and the fallback rule, Tavily credit pricing, the SSRF refusals (schemes, loopback, private, tailnet, metadata, IPv6 forms, a name that resolves privately, a redirect to a private IP, a second hop), DNS rebinding (a resolver that turns private after the guard is never asked again and the request is pinned per hop), the pinned transport against a local server, hostile 2 MB bodies, charsets, empty and binary reads, truncation, the Extract chain, the typed errors, registry and OpenAPI shape, `fakeWeb`.
- `live.test.ts`: one real call per capability, **skipped unless `AGW_LIVE=1`** (the skipped names say so). It costs well under $0.001:

  ```sh
  AGW_LIVE=1 secrets-run run --env-file=.env.tpl -- bun test packages/capabilities
  ```
