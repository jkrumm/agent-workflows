import { z } from 'zod'
import { completeJson, type LlmDeps } from '../llm/model-call.ts'
import { defineCapability } from '../procedure.ts'

export const classifyInput = z.object({
  text: z.string().min(1).describe('The text to classify'),
  labels: z
    .record(z.string().min(1), z.string())
    .refine((labels) => Object.keys(labels).length >= 2, { message: 'classify needs at least two labels' })
    .describe('Label → what it means. The answer is exactly one of the keys'),
})

export const classifyOutput = z.object({
  label: z.string(),
  reason: z.string().describe('One short sentence'),
})

const SYSTEM =
  'You classify text into exactly one of the given labels. ' +
  'Reply with a single JSON object {"label": "<one of the labels>", "reason": "<one short sentence>"} and nothing else.'

export const createClassify = (deps: LlmDeps) =>
  defineCapability({
    id: 'llm.classify',
    summary: 'Classify a text into one of the given labels, with a short reason',
    input: classifyInput,
    output: classifyOutput,
    cli: { positional: ['text'], stdin: 'text', plainField: 'label' },
    async handler({ text, labels }, ctx) {
      const names = Object.keys(labels) as [string, ...string[]]
      const schema = z.object({
        label: z.enum(names),
        reason: z.string().min(1),
      })
      const described = Object.entries(labels)
        .map(([name, description]) => `- ${name}: ${description}`)
        .join('\n')
      const { data } = await completeJson(deps, {
        routeId: 'cheap.classify',
        system: SYSTEM,
        prompt: `Labels:\n${described}\n\nText to classify:\n<text>\n${text}\n</text>`,
        schema,
        ctx,
      })
      return data
    },
  })
