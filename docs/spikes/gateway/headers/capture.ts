// Capture server: logs every request (method, path, headers, the body's `metadata`) and answers with a minimal valid
// streaming response, so no upstream LLM is ever called. Anthropic Messages, OpenAI chat completions and OpenAI
// Responses are served; anything else is logged and answered 404.

export type Captured = {
  seq: number
  kind: 'anthropic' | 'openai-chat' | 'openai-responses' | 'other'
  method: string
  path: string
  headers: Record<string, string>
  /** The JSON body's `metadata` (Anthropic `metadata.user_id`, OpenAI `metadata`), or null when absent. */
  metadata: unknown
  /** OpenAI's top-level `user` / `safety_identifier` / `prompt_cache_key`, when present. */
  openaiIdentity: Record<string, unknown>
  bodyKeys: string[]
  model: string | null
}

const REDACT = new Set(['authorization', 'x-api-key', 'api-key'])
const sse = (events: [string | null, unknown][]) =>
  events.map(([name, data]) => `${name ? `event: ${name}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`).join('')

const anthropicStream = (model: string) =>
  sse([
    ['message_start', { type: 'message_start', message: { id: 'msg_cap', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ])

const chatStream = (model: string) =>
  sse([
    [null, { id: 'chatcmpl-cap', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] }],
    [null, { id: 'chatcmpl-cap', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }],
    [null, '[DONE]'],
  ])

const responsesStream = (model: string) => {
  const item = { id: 'msg_cap', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }
  const response = (status: string, output: unknown[]) => ({ id: 'resp_cap', object: 'response', created_at: 1, status, model, output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } })
  return sse([
    ['response.created', { type: 'response.created', sequence_number: 0, response: response('in_progress', []) }],
    ['response.output_item.added', { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
    ['response.content_part.added', { type: 'response.content_part.added', sequence_number: 2, item_id: 'msg_cap', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', sequence_number: 3, item_id: 'msg_cap', output_index: 0, content_index: 0, delta: 'OK' }],
    ['response.output_text.done', { type: 'response.output_text.done', sequence_number: 4, item_id: 'msg_cap', output_index: 0, content_index: 0, text: 'OK' }],
    ['response.content_part.done', { type: 'response.content_part.done', sequence_number: 5, item_id: 'msg_cap', output_index: 0, content_index: 0, part: item.content[0] }],
    ['response.output_item.done', { type: 'response.output_item.done', sequence_number: 6, output_index: 0, item }],
    ['response.completed', { type: 'response.completed', sequence_number: 7, response: response('completed', [item]) }],
  ])
}

export function startCapture() {
  const log: Captured[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const headers: Record<string, string> = {}
      for (const [k, v] of req.headers) headers[k] = REDACT.has(k) ? '<redacted>' : v
      let body: Record<string, unknown> = {}
      if (req.method === 'POST') body = await req.json().catch(() => ({}))
      const p = url.pathname
      const kind: Captured['kind'] = p.endsWith('/messages')
        ? 'anthropic'
        : p.endsWith('/chat/completions')
          ? 'openai-chat'
          : p.endsWith('/responses')
            ? 'openai-responses'
            : 'other'
      const model = typeof body.model === 'string' ? body.model : 'capture-model'
      // The reachability probe of `opencode-safe` (GET on the base) is not an inference request: not logged.
      if (req.method === 'GET') return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
      log.push({
        seq: log.length + 1,
        kind,
        method: req.method,
        path: p,
        headers,
        metadata: body.metadata ?? null,
        openaiIdentity: Object.fromEntries(
          ['user', 'safety_identifier', 'prompt_cache_key'].filter((k) => k in body).map((k) => [k, body[k]]),
        ),
        bodyKeys: Object.keys(body).sort(),
        model: typeof body.model === 'string' ? body.model : null,
      })
      const stream = (text: string) =>
        new Response(text, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
      if (kind === 'anthropic') return stream(anthropicStream(model))
      if (kind === 'openai-chat') return stream(chatStream(model))
      if (kind === 'openai-responses') return stream(responsesStream(model))
      return new Response('{"error":"not served by the capture server"}', { status: 404, headers: { 'content-type': 'application/json' } })
    },
  })
  return { log, port: server.port, stop: () => server.stop(true) }
}
