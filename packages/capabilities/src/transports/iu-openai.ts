import { z } from 'zod'
import { type Env, iuConfig } from './config.ts'
import { Attempt, DEFAULTS, describe, failedResponse, type HttpOptions, isAbort, withRetries } from './http.ts'
import type { AttemptUsage, ChatPort, ChatRequest, ChatResult, OnUsage, Tokens } from './port.ts'

const chunkSchema = z.object({
  model: z.string().nullish(),
  choices: z
    .array(
      z.object({ delta: z.object({ content: z.string().nullish() }).nullish(), finish_reason: z.string().nullish() }),
    )
    .nullish(),
  usage: z.unknown().nullish(),
})

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

/** `prompt_tokens` includes cached tokens and `completion_tokens` includes reasoning, as the wire reports them. */
function readUsage(raw: unknown): { tokens: Tokens; cost: number | null } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  return {
    tokens: {
      input: count(u.prompt_tokens),
      output: count(u.completion_tokens),
      cacheRead: count(obj(u.prompt_tokens_details).cached_tokens),
      reasoning: count(obj(u.completion_tokens_details).reasoning_tokens),
    },
    cost: typeof u.cost === 'number' && Number.isFinite(u.cost) && u.cost >= 0 ? u.cost : null,
  }
}

/**
 * IU's OpenAI-compatible chat completions, streamed with `include_usage`. Idle watchdog only: the call
 * is aborted after `idleTimeoutMs` without a chunk, never for taking long. `reasoning_effort` is sent
 * only when the route has an effort other than `none`; no `temperature` is ever sent (reasoning models
 * reject it and IU relays that as a retryable 503).
 */
export function iuOpenai(options: HttpOptions & { env?: Env } = {}): ChatPort {
  const doFetch = options.fetch ?? fetch
  return {
    complete: async (request, signal, onUsage) => {
      const { apiKey, openaiBase } = iuConfig(options.env ?? process.env)
      return withRetries(options, signal, async () => {
        const idle = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        const arm = () => {
          clearTimeout(timer)
          timer = setTimeout(() => idle.abort(), options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs)
        }
        try {
          arm()
          const res = await doFetch(`${openaiBase}/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify(body(request)),
            signal: AbortSignal.any([signal, idle.signal]),
          })
          if (!res.ok) throw await failedResponse(res, 'iu-openai')
          return await readStream(res, request.model, arm, onUsage)
        } catch (error) {
          if (idle.signal.aborted && !signal.aborted) {
            throw new Attempt(
              `iu-openai stream idle for ${options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs}ms with no token`,
              false,
            )
          }
          if (error instanceof Attempt) throw error
          throw new Attempt(describe(error), !isAbort(error))
        } finally {
          clearTimeout(timer)
        }
      })
    },
  }
}

function body(request: ChatRequest) {
  return {
    model: request.model,
    messages: [
      ...(request.system ? [{ role: 'system', content: request.system }] : []),
      { role: 'user', content: request.prompt },
    ],
    // Reasoning tokens count against this ceiling.
    max_completion_tokens: request.maxOutputTokens,
    ...(request.effort && request.effort !== 'none' ? { reasoning_effort: request.effort } : {}),
    ...(request.json ? { response_format: { type: 'json_object' } } : {}),
    stream: true,
    stream_options: { include_usage: true },
  }
}

async function readStream(
  res: Response,
  requested: string,
  onChunk: () => void,
  onUsage: OnUsage | undefined,
): Promise<ChatResult> {
  if (!res.body) throw new Attempt('iu-openai response had no body', true)
  let text = ''
  let finish: string | null | undefined
  let model = requested
  let usage: ReturnType<typeof readUsage>
  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  let buffer = ''
  const line = (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice('data:'.length).trim()
    if (!payload || payload === '[DONE]') return
    let json: unknown
    try {
      json = JSON.parse(payload)
    } catch {
      throw new Attempt('iu-openai sent a malformed stream chunk', true)
    }
    const chunk = chunkSchema.safeParse(json)
    if (!chunk.success) throw new Attempt('iu-openai sent an unreadable stream chunk', true)
    if (chunk.data.model) model = chunk.data.model
    const choice = chunk.data.choices?.[0]
    if (choice?.delta?.content) text += choice.delta.content
    if (choice?.finish_reason) finish = choice.finish_reason
    if (chunk.data.usage) usage = readUsage(chunk.data.usage)
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      onChunk()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const l of lines) line(l)
    }
    line(buffer + decoder.decode())
    // Every complete stream ends with a finish chunk; without one the connection was cut mid-answer.
    if (!finish) throw new Attempt('iu-openai stream ended without a finish reason', true)
  } finally {
    // Billed whether the stream finished or not.
    if (usage) onUsage?.({ model, ...usage } satisfies AttemptUsage)
  }
  const stop = finish === 'length' ? 'length' : finish === 'stop' ? 'complete' : 'other'
  return { text: text.trim(), stop, ...(stop === 'other' ? { stopDetail: String(finish) } : {}), model }
}
