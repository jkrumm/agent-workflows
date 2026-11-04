import { z } from 'zod'
import { fail } from '../errors.ts'
import { defineCapability } from '../procedure.ts'
import type { ResolvedWebDeps } from './deps.ts'
import { dedupe, searchResult, sonarRequest } from './sonar.ts'

export const askInput = z.object({
  query: z.string().min(1),
  depth: z
    .enum(['basic', 'advanced'])
    .default('basic')
    .describe('Snippet size of the search behind the answer (basic = low, advanced = medium)'),
})

export const askOutput = z.object({
  answer: z.string().describe('Synthesized by a model from web results; unverified, a lead and never a source'),
  citations: z.array(searchResult).describe('The pages the answer rests on; read them before citing anything'),
  provider: z.literal('sonar'),
})

/** Room for a sourced answer of a few paragraphs; `sonar` (not `sonar-reasoning*`) spends it all on the answer. */
const ASK_MAX_TOKENS = 1024

export const createAsk = (deps: ResolvedWebDeps) =>
  defineCapability({
    id: 'web.ask',
    summary:
      'Ask Perplexity Sonar a question: a synthesized answer with citations. Unverified: a lead to orient or cross-check, never a source; read the cited pages before relying on it',
    input: askInput,
    output: askOutput,
    cli: { positional: ['query'], defaultFormat: 'json' },
    async handler(input, ctx) {
      const reply = await sonarRequest(deps, ctx, { query: input.query, depth: input.depth, maxTokens: ASK_MAX_TOKENS })
      if (!reply.answer) throw fail('UPSTREAM_ERROR', 'sonar returned no answer', {})
      // The plain `citations` URLs only add what `search_results` lacks (they carry no title or snippet).
      const citations = dedupe(
        [...reply.hits, ...reply.citations.map((url) => ({ url, title: '', snippet: '' }))],
        Number.POSITIVE_INFINITY,
      )
      return { answer: reply.answer, citations, provider: 'sonar' as const }
    },
  })
