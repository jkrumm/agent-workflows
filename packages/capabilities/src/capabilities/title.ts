import { z } from 'zod'
import { fail } from '../errors.ts'
import { complete, type LlmDeps } from '../llm/model-call.ts'
import { defineCapability } from '../procedure.ts'

export const titleInput = z.object({
  text: z.string().min(1).describe('The text to title'),
  maxWords: z.int().min(2).max(30).default(8).describe('Upper bound for the title length'),
})

export const titleOutput = z.object({ title: z.string().min(1) })

const SYSTEM =
  'You write short, specific titles. Reply with the title only: one line, no quotes, no markdown, no trailing period.'

const QUOTE_PAIRS = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['`', '`'],
] as const

/** Models still add a `#`, a label, wrapping quotes or a final period now and then. A lone apostrophe stays. */
export function cleanTitle(raw: string): string {
  let title = (raw.split('\n').find((line) => line.trim()) ?? '')
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/^title:\s*/i, '')
    .replace(/\.$/, '')
  for (const [open, close] of QUOTE_PAIRS) {
    if (title.length > 1 && title.startsWith(open) && title.endsWith(close)) title = title.slice(1, -1).trim()
  }
  return title.replace(/\.$/, '').trim()
}

export const createTitle = (deps: LlmDeps) =>
  defineCapability({
    id: 'llm.title',
    summary: 'Title a text with the cheap title route',
    input: titleInput,
    output: titleOutput,
    cli: { positional: ['text'], stdin: 'text', plainField: 'title' },
    async handler({ text, maxWords }, ctx) {
      const { text: raw } = await complete(deps, {
        routeId: 'cheap.title',
        system: SYSTEM,
        prompt: `Write a title of at most ${maxWords} words for the text below.\n\n<text>\n${text}\n</text>`,
        ctx,
      })
      const title = cleanTitle(raw)
      if (!title)
        throw fail('INVALID_OUTPUT', 'cheap.title: the model returned no usable title', {
          attempts: 1,
          reason: 'empty after cleanup',
        })
      return { title }
    },
  })
