import { z } from 'zod'
import type { Usage } from '../context.ts'
import { fail } from '../errors.ts'
import { defineCapability } from '../procedure.ts'
import { iuConfig } from '../transports/config.ts'
import { describe, failedResponse, readJson, withRetries } from '../transports/http.ts'
import { keyOf, type ResolvedWebDeps, within } from './deps.ts'

export const searchInput = z.object({
  query: z.string().min(1),
  maxResults: z.int().min(1).max(20).default(8).describe('Results returned, at most 20'),
  depth: z
    .enum(['basic', 'advanced'])
    .default('basic')
    .describe('Tavily search depth; for Sonar the snippet size (basic = low, advanced = medium)'),
})

const result = z.object({
  url: z.string(),
  title: z.string(),
  snippet: z.string(),
  publishedAt: z.string().optional(),
})

export const searchOutput = z.object({
  results: z.array(result),
  provider: z.enum(['sonar', 'tavily']).describe('The backend that answered'),
})

type Hit = z.infer<typeof result>

const SEARCH_TIMEOUT_MS = 30_000
const TAVILY_SNIPPET_CHARS = 1_000
/** Tavily pay-as-you-go list price, USD per credit (docs.tavily.com/documentation/api-credits, checked 2026-10-28). The plan price is lower, so this never under-prices. */
export const TAVILY_USD_PER_CREDIT = 0.008
/** Documented credits per search: 1 for `basic`, 2 for `advanced`. A response's own `usage.credits` wins. */
const TAVILY_SEARCH_CREDITS = { basic: 1, advanced: 2 } as const

/** `sonar-reasoning*` spends the whole answer on reasoning and returns nothing (measured in research-gateway). */
const DEFAULT_SONAR_MODEL = 'sonar'
/** Perplexity rejects `max_tokens` below 16; the synthesized answer is discarded, only URLs and snippets are used. */
const SONAR_ANSWER_TOKEN_FLOOR = 16

const sonarResponse = z.object({
  search_results: z
    .array(
      z.object({
        title: z.string().nullish(),
        url: z.string(),
        snippet: z.string().nullish(),
        date: z.string().nullish(),
        last_updated: z.string().nullish(),
      }),
    )
    .nullish(),
  usage: z
    .object({
      prompt_tokens: z.number().nullish(),
      completion_tokens: z.number().nullish(),
      cost: z.union([z.number(), z.object({ total_cost: z.number().nullish() })]).nullish(),
    })
    .nullish(),
})

const tavilySearchResponse = z.object({
  results: z.array(z.object({ url: z.string(), title: z.string().nullish(), content: z.string().nullish() })),
  usage: z.object({ credits: z.number().nullish() }).nullish(),
})

const dedupe = (hits: Hit[], max: number): Hit[] => {
  const seen = new Set<string>()
  const out: Hit[] = []
  for (const hit of hits) {
    if (out.length >= max) break
    if (seen.has(hit.url)) continue
    seen.add(hit.url)
    out.push(hit)
  }
  return out
}

type Backend = (
  input: z.output<typeof searchInput>,
  deps: ResolvedWebDeps,
  signal: AbortSignal,
  addUsage: (usage: Usage) => void,
) => Promise<Hit[]>

/**
 * Perplexity Sonar over IU's OpenAI-compatible endpoint, as a pure search backend: the answer is dropped, the
 * `search_results` are the output. A 429 is retried once (two attempts), then the caller falls back to Tavily.
 * Billed by IU: `usage.cost.total_cost` is the vendor's own figure (`costSource: 'provider'`).
 */
const sonar: Backend = async (input, deps, signal, addUsage) => {
  const env = deps.env()
  const config = iuConfig(env)
  const model = keyOf(env, 'SONAR_MODEL') ?? DEFAULT_SONAR_MODEL
  const json = await withRetries({ ...deps.retry, attempts: 2 }, signal, async () => {
    const res = await deps.fetch(`${config.openaiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: input.query }],
        max_tokens: SONAR_ANSWER_TOKEN_FLOOR,
        web_search_options: { search_context_size: input.depth === 'advanced' ? 'medium' : 'low' },
      }),
      signal: within(signal, SEARCH_TIMEOUT_MS),
    })
    if (!res.ok) throw await failedResponse(res, 'sonar')
    return readJson(res, 'sonar')
  })
  const parsed = sonarResponse.safeParse(json)
  if (!parsed.success) throw fail('UPSTREAM_ERROR', 'sonar answered with a body that does not fit', {})
  const { search_results, usage } = parsed.data
  // The whole response is billed, not the slice we keep.
  const reported = typeof usage?.cost === 'number' ? usage.cost : usage?.cost?.total_cost
  addUsage({
    model,
    tokens: { input: usage?.prompt_tokens ?? 0, output: usage?.completion_tokens ?? 0, cacheRead: 0, reasoning: 0 },
    cost: typeof reported === 'number' && reported >= 0 ? reported : null,
    costSource: typeof reported === 'number' && reported >= 0 ? 'provider' : 'unknown',
  })
  const hits = dedupe(
    (search_results ?? []).map((r) => {
      const publishedAt = r.date ?? r.last_updated
      return { url: r.url, title: r.title ?? '', snippet: r.snippet ?? '', ...(publishedAt ? { publishedAt } : {}) }
    }),
    input.maxResults,
  )
  // An empty set means the passthrough broke (IU routing Sonar through a normalizing tier drops `search_results`):
  // a failure so the fallback engages, never "the web has nothing".
  if (hits.length === 0) throw fail('UPSTREAM_ERROR', 'sonar returned no search_results', {})
  return hits
}

/** Tavily Search. Billed in credits, priced at the list rate; the response's `usage.credits` wins over the documented count. */
const tavily: Backend = async (input, deps, signal, addUsage) => {
  const key = keyOf(deps.env(), 'TAVILY_API_KEY')
  if (!key) throw fail('NOT_CONFIGURED', 'web.search unavailable: TAVILY_API_KEY is not set')
  const json = await withRetries(deps.retry, signal, async () => {
    const res = await deps.fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query: input.query,
        search_depth: input.depth,
        max_results: input.maxResults,
        include_usage: true,
      }),
      signal: within(signal, SEARCH_TIMEOUT_MS),
    })
    if (!res.ok) throw await failedResponse(res, 'tavily')
    return readJson(res, 'tavily')
  })
  const parsed = tavilySearchResponse.safeParse(json)
  if (!parsed.success) throw fail('UPSTREAM_ERROR', 'tavily answered with a body that does not fit', {})
  const credits = parsed.data.usage?.credits ?? TAVILY_SEARCH_CREDITS[input.depth]
  addUsage({
    model: 'tavily-search',
    tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
    cost: credits * TAVILY_USD_PER_CREDIT,
    costSource: 'rate',
  })
  return dedupe(
    parsed.data.results.map((r) => {
      const content = r.content ?? ''
      return {
        url: r.url,
        title: r.title ?? '',
        snippet: content.length > TAVILY_SNIPPET_CHARS ? `${content.slice(0, TAVILY_SNIPPET_CHARS)}...` : content,
      }
    }),
    input.maxResults,
  )
}

export const createSearch = (deps: ResolvedWebDeps) =>
  defineCapability({
    id: 'web.search',
    summary:
      'Search the web: Sonar by default, Tavily as the per-call fallback. Returns candidates, not verified facts',
    input: searchInput,
    output: searchOutput,
    cli: { positional: ['query'], defaultFormat: 'json' },
    async handler(input, ctx) {
      // `SEARCH_PROVIDER=tavily` takes Perplexity out of the loop; anything else is the default order.
      const order: ('sonar' | 'tavily')[] =
        keyOf(deps.env(), 'SEARCH_PROVIDER') === 'tavily' ? ['tavily'] : ['sonar', 'tavily']
      const backends = { sonar, tavily }
      let first: unknown
      for (const provider of order) {
        try {
          const results = await backends[provider](input, deps, ctx.signal, ctx.addUsage)
          return { results, provider }
        } catch (error) {
          // A cancelled call is not a provider failure: no fallback, no second bill.
          if (ctx.signal.aborted || (error as { code?: string }).code === 'CANCELLED') throw error
          first ??= error
          if (provider === 'sonar') deps.warn(`web.search: sonar failed, falling back to tavily: ${describe(error)}`)
        }
      }
      // Both failed (or the only one did): the primary's error is the one that says what happened first.
      throw first instanceof Error ? first : fail('UPSTREAM_ERROR', 'web.search: no backend answered', {})
    },
  })
