import { z } from 'zod'
import type { Ctx } from '../context.ts'
import { fail } from '../errors.ts'
import { gatewayConfig } from '../transports/config.ts'
import { gatewayHeaders } from '../transports/headers.ts'
import { failedResponse, readJson, withRetries } from '../transports/http.ts'
import { keyOf, type ResolvedWebDeps, webUsage, within } from './deps.ts'

export const searchResult = z.object({
  url: z.string(),
  title: z.string(),
  snippet: z.string(),
  publishedAt: z.string().optional(),
})

export type Hit = z.infer<typeof searchResult>

const SONAR_TIMEOUT_MS = 30_000

/** `sonar-reasoning*` spends the whole answer on reasoning and returns nothing (measured in research-gateway). */
const DEFAULT_SONAR_MODEL = 'sonar'

const sonarResponse = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullish() }).nullish() }))
    .nullish()
    .catch(undefined),
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
  citations: z.array(z.string()).nullish().catch(undefined),
  usage: z
    .object({
      prompt_tokens: z.number().nullish(),
      completion_tokens: z.number().nullish(),
      cost: z.union([z.number(), z.object({ total_cost: z.number().nullish() })]).nullish(),
    })
    .nullish(),
})

/** First occurrence of each URL wins; at most `max` hits. */
export const dedupe = (hits: Hit[], max: number): Hit[] => {
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

export interface SonarReply {
  /** The synthesized answer; empty when the response carried none. */
  answer: string
  /** `search_results` as hits, not de-duplicated. */
  hits: Hit[]
  /** URLs of the response's `citations` array, in order. */
  citations: string[]
}

/**
 * The one Perplexity Sonar request over IU's OpenAI-compatible endpoint (through the gateway), shared by `web.search`
 * (which drops the answer) and `web.ask` (which keeps it). A 429 is retried once (two attempts). Billed by IU:
 * `usage.cost.total_cost` is the vendor's own figure (`costSource: 'provider'`), recorded for the whole response.
 */
export async function sonarRequest(
  deps: ResolvedWebDeps,
  { signal, addUsage, attribution }: Ctx,
  request: { query: string; depth: 'basic' | 'advanced'; maxTokens: number },
): Promise<SonarReply> {
  const env = deps.env()
  const config = gatewayConfig(env)
  const model = keyOf(env, 'SONAR_MODEL') ?? DEFAULT_SONAR_MODEL
  const json = await withRetries({ ...deps.retry, attempts: 2 }, signal, async () => {
    const res = await deps.fetch(`${config.openaiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        ...gatewayHeaders(attribution),
        'content-type': 'application/json',
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: request.query }],
        max_tokens: request.maxTokens,
        web_search_options: { search_context_size: request.depth === 'advanced' ? 'medium' : 'low' },
      }),
      signal: within(signal, SONAR_TIMEOUT_MS),
    })
    if (!res.ok) throw await failedResponse(res, 'sonar')
    return readJson(res, 'sonar')
  })
  const parsed = sonarResponse.safeParse(json)
  if (!parsed.success) throw fail('UPSTREAM_ERROR', 'sonar answered with a body that does not fit', {})
  const { choices, search_results, citations, usage } = parsed.data
  const reported = typeof usage?.cost === 'number' ? usage.cost : usage?.cost?.total_cost
  addUsage(
    webUsage(model, typeof reported === 'number' && reported >= 0 ? reported : null, {
      source: 'provider',
      tokens: { input: usage?.prompt_tokens ?? 0, output: usage?.completion_tokens ?? 0 },
    }),
  )
  return {
    answer: choices?.[0]?.message?.content?.trim() ?? '',
    hits: (search_results ?? []).map((r) => {
      const publishedAt = r.date ?? r.last_updated
      return { url: r.url, title: r.title ?? '', snippet: r.snippet ?? '', ...(publishedAt ? { publishedAt } : {}) }
    }),
    citations: citations ?? [],
  }
}
