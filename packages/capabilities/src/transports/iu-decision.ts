import { z } from 'zod'
import { type Env, iuConfig } from './config.ts'
import { Attempt, DEFAULTS, describe, failedResponse, type HttpOptions, isAbort, withRetries } from './http.ts'
import type { DecisionAnswer, DecisionPort, DecisionRequest, DecisionResult } from './port.ts'

const MAX_CHOICE_OPTIONS = 255

// The wire is `POST <origin>/decisions/v1/systemone`, as the official TypeSafe SDK sends it (checked
// against `@ai-sdk/typesafe-ai` 3.0.17). A boolean question is `noul` on the wire. One POST and a
// small response, so this calls the API directly instead of taking `ai` and the provider package.
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
  usage: z.object({ input_tokens: z.number().nullish(), output_tokens: z.number().nullish() }).nullish(),
})

/** IU's decision API: typed answers with calibrated probabilities. */
export function iuDecision(options: HttpOptions & { env?: Env } = {}): DecisionPort {
  const doFetch = options.fetch ?? fetch
  return {
    decide: (request, signal) => {
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
        return readResponse(await res.json().catch(() => null), request.model)
      })
    },
  }
}

function body(request: DecisionRequest) {
  return {
    model: request.model,
    state: request.state,
    questions: Object.fromEntries(
      Object.entries(request.questions).map(([id, q]) => {
        if (q.type === 'boolean') return [id, { type: 'noul', instructions: q.instructions }]
        if (Object.keys(q.options).length > MAX_CHOICE_OPTIONS) {
          throw new Attempt(`question "${id}" has more than ${MAX_CHOICE_OPTIONS} options`, false)
        }
        return [id, { type: 'choice', instructions: q.instructions, criteria: q.options }]
      }),
    ),
  }
}

function readResponse(json: unknown, requested: string): DecisionResult {
  const parsed = responseSchema.safeParse(json)
  if (!parsed.success) throw new Attempt('iu-decision returned an unreadable body', false)
  const answers: Record<string, DecisionAnswer> = {}
  for (const [id, answer] of Object.entries(parsed.data.answers)) {
    if (answer.type === 'choice') {
      answers[id] = {
        type: 'choice',
        choice: answer.choice,
        probabilities: answer.probabilities,
        confidence: answer.confidence ?? null,
      }
    } else {
      answers[id] = { type: 'boolean', probability: answer.noul }
    }
  }
  const { usage } = parsed.data
  return {
    model: parsed.data.model ?? requested,
    answers,
    tokens: usage ? { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 } : undefined,
  }
}
