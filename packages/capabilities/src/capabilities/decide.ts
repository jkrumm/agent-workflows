import { costFromUsage } from '@agent-workflows/routes'
import { z } from 'zod'
import { CapabilityError, fail } from '../errors.ts'
import { type LlmDeps, resolve } from '../llm/model-call.ts'
import { defineCapability } from '../procedure.ts'

/** The decision API takes at most this many options per choice question. */
const MAX_OPTIONS = 255
/**
 * Cap on the state text. The route's model reads 60k characters; the gateway's smaller-context
 * decision models (cut silently by the provider at ~2k tokens) are not routed here.
 */
const MAX_STATE_CHARS = 60_000

const question = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    instructions: z.string().min(1),
    options: z
      .record(z.string(), z.string().nullable())
      .refine((o) => Object.keys(o).length >= 2, { message: 'a choice needs at least two options' })
      .refine((o) => Object.keys(o).length <= MAX_OPTIONS, { message: `a choice takes at most ${MAX_OPTIONS} options` })
      .describe('option id → description'),
  }),
  z.object({ type: z.literal('boolean'), instructions: z.string().min(1) }),
])

export const decideInput = z.object({
  state: z.string().min(1).describe('Everything the model may know: it cannot search or read anything else'),
  questions: z
    .record(z.string(), question)
    .refine((q) => Object.keys(q).length >= 1, { message: 'at least one question' })
    .describe('question id → question'),
})

const answer = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    confidence: z.number().min(0).max(1),
    probabilities: z.record(z.string(), z.number()),
  }),
  z.object({
    type: z.literal('boolean'),
    value: z.boolean(),
    confidence: z.number().min(0.5).max(1),
    probability: z.number().min(0).max(1).describe('Probability that the answer is true'),
  }),
])

export const decideOutput = z.object({
  answers: z.record(z.string(), answer),
  model: z.string(),
  truncatedChars: z.int().nonnegative().describe('State characters cut to fit the cap; 0 when nothing was cut'),
})

/** Where to cut `text` to at most `max` UTF-16 units without splitting a surrogate pair. */
function cutPoint(text: string, max: number): number {
  if (text.length <= max) return text.length
  const high = text.charCodeAt(max - 1)
  return high >= 0xd800 && high <= 0xdbff ? max - 1 : max
}

const invalid = (reason: string) => fail('INVALID_OUTPUT', `decide: ${reason}`, { attempts: 1, reason })

export const createDecide = (deps: LlmDeps) =>
  defineCapability({
    id: 'decide',
    summary: 'Typed answers with calibrated probabilities from IU’s decision models, no text generation',
    input: decideInput,
    output: decideOutput,
    cli: { stdin: 'state', defaultFormat: 'json' },
    async handler({ state, questions }, ctx) {
      const route = resolve(deps, 'decide')
      if (route.wire !== 'iu-decision') {
        throw new CapabilityError('NOT_CONFIGURED', `decide: wire "${route.wire}" is not the decision wire`)
      }
      const kept = cutPoint(state, MAX_STATE_CHARS)
      const truncatedChars = state.length - kept
      const result = await deps.transports.decision.decide(
        {
          model: route.model,
          state: truncatedChars > 0 ? state.slice(0, kept) : state,
          questions,
        },
        ctx.signal,
      )
      // The call is billed whatever the mapping below decides: report it first.
      const cost = costFromUsage(
        route.wire,
        result.tokens ? { input_tokens: result.tokens.input, output_tokens: result.tokens.output } : null,
        route.rate,
      )
      ctx.addUsage({
        model: result.model,
        tokens: { input: result.tokens?.input ?? 0, output: result.tokens?.output ?? 0, cacheRead: 0, reasoning: 0 },
        cost: cost.usd,
        costSource: cost.source,
      })

      const answers: z.output<typeof decideOutput>['answers'] = {}
      for (const [id, asked] of Object.entries(questions)) {
        const given = result.answers[id]
        if (!given) throw invalid(`no answer for question "${id}"`)
        if (given.type === 'boolean') {
          if (asked.type !== 'boolean') throw invalid(`question "${id}" is a choice but came back boolean`)
          answers[id] = {
            type: 'boolean',
            value: given.probability >= 0.5,
            confidence: Math.max(given.probability, 1 - given.probability),
            probability: given.probability,
          }
          continue
        }
        if (asked.type !== 'choice') throw invalid(`question "${id}" is a boolean but came back a choice`)
        if (!Object.hasOwn(asked.options, given.choice))
          throw invalid(`"${id}": "${given.choice}" is not one of the options`)
        const confidence = given.confidence ?? given.probabilities[given.choice]
        if (confidence === undefined) throw invalid(`no confidence for "${id}"`)
        answers[id] = { type: 'choice', choice: given.choice, confidence, probabilities: given.probabilities }
      }
      return { answers, model: result.model, truncatedChars }
    },
  })
