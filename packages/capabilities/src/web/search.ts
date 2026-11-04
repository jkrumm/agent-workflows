import { z } from 'zod'
import type { Ctx } from '../context.ts'
import { fail } from '../errors.ts'
import { defineCapability } from '../procedure.ts'
import { gatewayConfig } from '../transports/config.ts'
import { gatewayHeaders } from '../transports/headers.ts'
import { describe, failedResponse, readJson, withRetries } from '../transports/http.ts'
import { keyOf, type ResolvedWebDeps, requireKey, webUsage, within } from './deps.ts'
import { dedupe, type Hit, searchResult, sonarRequest } from './sonar.ts'

export const searchInput = z.object({
  query: z.string().min(1),
  maxResults: z.int().min(1).max(20).default(8).describe('Results returned, at most 20'),
  depth: z
    .enum(['basic', 'advanced'])
    .default('basic')
    .describe('Tavily search depth; for Sonar the snippet size (basic = low, advanced = medium)'),
})

export const searchOutput = z.object({
  results: z.array(searchResult),
  provider: z.enum(['sonar', 'tavily']).describe('The backend that answered'),
})

const SEARCH_TIMEOUT_MS = 30_000
const TAVILY_SNIPPET_CHARS = 1_000
/** Tavily pay-as-you-go list price, USD per credit (docs.tavily.com/documentation/api-credits, checked 2026-10-28). The plan price is lower, so this never under-prices. */
export const TAVILY_USD_PER_CREDIT = 0.008
/** Documented credits per search: 1 for `basic`, 2 for `advanced`. A response's own `usage.credits` wins. */
const TAVILY_SEARCH_CREDITS = { basic: 1, advanced: 2 } as const

/** Perplexity rejects `max_tokens` below 16; the synthesized answer is discarded, only URLs and snippets are used. */
const SONAR_ANSWER_TOKEN_FLOOR = 16

const tavilySearchResponse = z.object({
  results: z.array(z.object({ url: z.string(), title: z.string().nullish(), content: z.string().nullish() })),
  usage: z.object({ credits: z.number().nullish() }).nullish(),
})

type Backend = (input: z.output<typeof searchInput>, deps: ResolvedWebDeps, ctx: Ctx) => Promise<Hit[]>

/**
 * Perplexity Sonar as a pure search backend (`sonarRequest`): the answer is dropped, the `search_results` are the
 * output. A 429 is retried once (two attempts), then the caller falls back to Tavily.
 */
const sonar: Backend = async (input, deps, ctx) => {
  const { hits: all } = await sonarRequest(deps, ctx, {
    query: input.query,
    depth: input.depth,
    maxTokens: SONAR_ANSWER_TOKEN_FLOOR,
  })
  const hits = dedupe(all, input.maxResults)
  // An empty set means the passthrough broke (IU routing Sonar through a normalizing tier drops `search_results`):
  // a failure so the fallback engages, never "the web has nothing".
  if (hits.length === 0) throw fail('UPSTREAM_ERROR', 'sonar returned no search_results', {})
  return hits
}

/** Tavily Search. Billed in credits, priced at the list rate; the response's `usage.credits` wins over the documented count. */
const tavily: Backend = async (input, deps, { signal, addUsage }) => {
  const key = requireKey(deps.env(), 'TAVILY_API_KEY', 'web.search')
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
  addUsage(webUsage('tavily-search', credits * TAVILY_USD_PER_CREDIT))
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
          const results = await backends[provider](input, deps, ctx)
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
