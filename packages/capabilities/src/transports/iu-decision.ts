import { z } from 'zod'
import { type Env, iuConfig } from './config.ts'
import {
  Attempt,
  DEFAULTS,
  describe,
  failedResponse,
  type HttpOptions,
  isAbort,
  readJson,
  withRetries,
} from './http.ts'
import type { DecisionAnswer, DecisionPort, DecisionRequest, DecisionResult, OnUsage } from './port.ts'

// The wire is `POST <origin>/decisions/v1/systemone`, as the official TypeSafe SDK sends it (checked
// against `@ai-sdk/typesafe-ai` 3.0.17). A boolean question is `noul` on the wire. One POST and a
// small response, so this calls the API directly instead of taking `ai` and the provider package.
const usageSchema = z.object({ input_tokens: z.number().nullish(), output_tokens: z.number().nullish() })
const responseSchema = z.object({
  model: z.string().nullish(),
  answers: z.record(
    z.string(),
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal('choice'),
        choice: z.string(),
        probabilities: z.record(z.string(), z.number()),
        confidence: z.number().nullish(),
      }),
      z.object({ type: z.literal('noul'), noul: z.number() }),
    ]),
  ),
  usage: usageSchema.nullish(),
})

function reportUsage(usage: z.output<typeof usageSchema>, model: string, onUsage: OnUsage | undefined) {
  onUsage?.({
    model,
    tokens: { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cacheRead: 0, reasoning: 0 },
    cost: null,
  })
}

/** IU's decision API: typed answers with calibrated probabilities. */
export function iuDecision(options: HttpOptions & { env?: Env } = {}): DecisionPort {
  const doFetch = options.fetch ?? fetch
  return {
    decide: async (request, signal, onUsage) => {
      const { apiKey, decisionBase } = iuConfig(options.env ?? process.env)
      return withRetries(options, signal, async () => {
        let res: Response
        try {
          res = await doFetch(`${decisionBase}/systemone`, {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify(body(request)),
            signal: AbortSignal.any([signal, AbortSignal.timeout(options.hangGuardMs ?? DEFAULTS.hangGuardMs)]),
          })
        } catch (error) {
          if (error instanceof Attempt) throw error
          throw new Attempt(describe(error), !isAbort(error))
        }
        if (!res.ok) throw await failedResponse(res, 'iu-decision')
        return readResponse(await readJson(res, 'iu-decision'), request.model, onUsage)
      })
    },
  }
}

function body(request: DecisionRequest) {
  return {
    model: request.model,
    state: request.state,
    questions: Object.fromEntries(
      Object.entries(request.questions).map(([id, q]) => [
        id,
        q.type === 'boolean'
          ? { type: 'noul', instructions: q.instructions }
          : { type: 'choice', instructions: q.instructions, criteria: q.options },
      ]),
    ),
  }
}

function readResponse(json: unknown, requested: string, onUsage: OnUsage | undefined): DecisionResult {
  const parsed = responseSchema.safeParse(json)
  if (!parsed.success) {
    // A 200 whose body does not fit still billed whatever its `usage` says.
    const usage = usageSchema.nullish().safeParse((json as { usage?: unknown } | null)?.usage)
    if (usage.success && usage.data) reportUsage(usage.data, requested, onUsage)
    throw new Attempt('iu-decision returned an unreadable body', false)
  }
  const model = parsed.data.model ?? requested
  if (parsed.data.usage) reportUsage(parsed.data.usage, model, onUsage)
  const answers: Record<string, DecisionAnswer> = {}
  for (const [id, answer] of Object.entries(parsed.data.answers)) {
    answers[id] =
      answer.type === 'choice'
        ? {
            type: 'choice',
            choice: answer.choice,
            probabilities: answer.probabilities,
            confidence: answer.confidence ?? null,
          }
        : { type: 'boolean', probability: answer.noul }
  }
  return { model, answers }
}
