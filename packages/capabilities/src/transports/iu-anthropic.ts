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
import type { AttemptUsage, ChatPort, ChatRequest, ChatResult, OnUsage } from './port.ts'

const ANTHROPIC_VERSION = '2023-06-01'

const count = z.number().nullish()
const usageSchema = z.object({
  input_tokens: count,
  output_tokens: count,
  cache_read_input_tokens: count,
  cache_creation_input_tokens: count,
  cost: count,
})
const messageSchema = z.object({
  model: z.string().nullish(),
  stop_reason: z.string().nullish(),
  content: z.array(z.object({ type: z.string(), text: z.string().nullish() })),
  usage: usageSchema.nullish(),
})

/**
 * IU's native Messages route, one non-streamed request under a hang guard (the agent-limits fallback
 * for a client that cannot stream), never a budget. Thinking is `adaptive` with the route's effort,
 * and only when the route has one; models without effort get a plain request.
 */
export function iuAnthropic(options: HttpOptions & { env?: Env } = {}): ChatPort {
  const doFetch = options.fetch ?? fetch
  return {
    complete: async (request, signal, onUsage) => {
      const { apiKey, anthropicBase } = iuConfig(options.env ?? process.env)
      return withRetries(options, signal, async () => {
        let res: Response
        try {
          res = await doFetch(`${anthropicBase}/v1/messages`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${apiKey}`,
              'anthropic-version': ANTHROPIC_VERSION,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body(request)),
            signal: AbortSignal.any([signal, AbortSignal.timeout(options.hangGuardMs ?? DEFAULTS.hangGuardMs)]),
          })
        } catch (error) {
          if (error instanceof Attempt) throw error
          throw new Attempt(describe(error), !isAbort(error))
        }
        if (!res.ok) throw await failedResponse(res, 'iu-anthropic')
        return readMessage(await readJson(res, 'iu-anthropic'), request.model, onUsage)
      })
    },
  }
}

function body(request: ChatRequest) {
  const thinking = request.effort !== undefined && request.effort !== 'none'
  return {
    model: request.model,
    max_tokens: request.maxOutputTokens,
    messages: [{ role: 'user', content: request.prompt }],
    ...(request.system ? { system: request.system } : {}),
    ...(thinking ? { thinking: { type: 'adaptive' }, output_config: { effort: request.effort } } : {}),
  }
}

function toUsage(usage: z.output<typeof usageSchema>, model: string): AttemptUsage {
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  return {
    model,
    // Thinking tokens are inside `output_tokens` on this wire and not reported separately.
    tokens: {
      input: (usage.input_tokens ?? 0) + cacheRead + cacheWrite,
      output: usage.output_tokens ?? 0,
      cacheRead,
      reasoning: 0,
    },
    ...(cacheWrite > 0 ? { cacheWrite } : {}),
    cost: typeof usage.cost === 'number' && usage.cost >= 0 ? usage.cost : null,
  }
}

function readMessage(json: unknown, requested: string, onUsage: OnUsage | undefined): ChatResult {
  const parsed = messageSchema.safeParse(json)
  if (!parsed.success) {
    // A 200 whose body does not fit still billed whatever its `usage` says.
    const usage = usageSchema.safeParse((json as { usage?: unknown } | null)?.usage)
    if (usage.success) onUsage?.(toUsage(usage.data, requested))
    throw new Attempt('iu-anthropic returned an unreadable Messages body', false)
  }
  const { content, usage, stop_reason: stopReason } = parsed.data
  const model = parsed.data.model ?? requested
  if (usage) onUsage?.(toUsage(usage, model))
  const stop =
    stopReason === 'max_tokens'
      ? 'length'
      : stopReason === 'end_turn' || stopReason === 'stop_sequence'
        ? 'complete'
        : 'other'
  return {
    text: content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
      .trim(),
    stop,
    ...(stop === 'other' ? { stopDetail: stopReason ?? 'none' } : {}),
    model,
  }
}
