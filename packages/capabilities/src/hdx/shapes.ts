import { z } from 'zod'
import { fail } from '../errors.ts'
import type { HdxEnv } from './deps.ts'

/**
 * What the server's answers must look like before anything reads them: a hostile or newer server's shape is an
 * `UPSTREAM_ERROR`, never a TypeError on a null entry. Extra fields pass; the ones read are checked.
 */
const contentItem = z.looseObject({ type: z.string(), text: z.unknown().optional() })

export const toolsList = z.looseObject({
  tools: z
    .array(
      z.looseObject({
        name: z.string(),
        description: z.unknown().optional(),
        inputSchema: z.unknown().optional(),
        annotations: z.looseObject({ readOnlyHint: z.unknown().optional() }).nullish(),
      }),
    )
    .default([]),
})

export const toolCall = z.looseObject({
  content: z.array(contentItem).optional(),
  structuredContent: z.unknown().optional(),
  isError: z.unknown().optional(),
})

export const initialize = z.looseObject({ instructions: z.unknown().optional() })

export const promptGet = z.looseObject({
  messages: z.array(z.looseObject({ content: contentItem })).default([]),
})

type ContentItem = z.output<typeof contentItem>

/** MCP content items as text: text items verbatim, anything else named and left out. */
export function contentToText(content: ContentItem[]): string {
  return content
    .map((item) =>
      item.type === 'text' ? (typeof item.text === 'string' ? item.text : '') : `[${item.type} content omitted]`,
    )
    .join('\n')
}

/** `value` as `schema`, or `UPSTREAM_ERROR` naming the environment and the method (never the value). */
export function shaped<S extends z.ZodType>(schema: S, value: unknown, env: HdxEnv, method: string): z.output<S> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw fail('UPSTREAM_ERROR', `hdx ${env}: ${method} answered with a shape that does not fit`, {})
  return parsed.data
}
