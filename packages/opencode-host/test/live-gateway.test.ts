import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { BALANCE_MARKER, isBalanceFailure } from '@agent-workflows/routes'
import type { AgentResult, Attribution, Json } from '@agent-workflows/runtime'
import { isClaudeCodeShaped } from '../../gateway/src/pools/request.ts'
import { createClient, type Message, OpenCodeHost, OpenCodeServer } from '../src/index.ts'

// What the pinned OpenCode build really puts on the wire, end to end through this host: the real binary, the real
// config and plugin, a loopback server standing in for the gateway. No LLM is called and the token is a dummy; the
// server's proxy env points at a dead port, so nothing can leave loopback. Prints what it saw. Run with:
//   AGW_LIVE=1 timeout 300 bun test packages/opencode-host/test/live-gateway.test.ts
const live = process.env.AGW_LIVE === '1'

const TOKEN = 'dummy-door-token'
const BIN = join(homedir(), '.local/share/agent-workflows/opencode-bin/current/node_modules/.bin/opencode')
/** The gateway's 402 of `x-agw-fallback: none`, as `errorResponse` in `packages/gateway/src/proxy.ts` writes it. */
const GATEWAY_402 = {
  type: 'error',
  error: { type: 'balance_error', message: `${BALANCE_MARKER}: no credit pool eligible` },
}
const NOISE = new Set(['accept', 'accept-encoding', 'accept-language', 'connection', 'content-length', 'host'])

type Seen = {
  path: string
  headers: Record<string, string>
  body: Record<string, unknown>
  requestHeaders: Headers
}

const sse = (events: [string | null, unknown][]) =>
  events.map(([name, data]) => `${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(data)}\n\n`).join('')

const streamed = (text: string) => new Response(text, { headers: { 'content-type': 'text/event-stream' } })

const anthropicUsage = {
  input_tokens: 10,
  output_tokens: 1,
  cache_creation_input_tokens: 1000,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 },
}

const anthropicStream = (model: string, block: Record<string, unknown>, deltas: unknown[], stop: string) =>
  streamed(
    sse([
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'msg_cap',
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: anthropicUsage,
          },
        },
      ],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: block }],
      ...deltas.map((delta): [string, unknown] => [
        'content_block_delta',
        { type: 'content_block_delta', index: 0, delta },
      ]),
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } },
      ],
      ['message_stop', { type: 'message_stop' }],
    ]),
  )

const anthropicText = (model: string, text: string) =>
  anthropicStream(model, { type: 'text', text: '' }, [{ type: 'text_delta', text }], 'end_turn')

const anthropicToolCall = (model: string, name: string, input: unknown) =>
  anthropicStream(
    model,
    { type: 'tool_use', id: 'toolu_cap', name, input: {} },
    [{ type: 'input_json_delta', partial_json: JSON.stringify(input) }],
    'tool_use',
  )

const chatText = (model: string, text: string) =>
  streamed(
    `${sse([
      [
        null,
        {
          id: 'c',
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
        },
      ],
      [
        null,
        {
          id: 'c',
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ],
    ])}data: [DONE]\n\n`,
  )

function responsesText(model: string, text: string) {
  const item = {
    id: 'msg_cap',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  const response = (status: string, output: unknown[]) => ({
    id: 'resp_cap',
    object: 'response',
    created_at: 1,
    status,
    model,
    output,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  })
  return streamed(
    sse([
      ['response.created', { type: 'response.created', sequence_number: 0, response: response('in_progress', []) }],
      [
        'response.output_item.added',
        {
          type: 'response.output_item.added',
          sequence_number: 1,
          output_index: 0,
          item: { ...item, status: 'in_progress', content: [] },
        },
      ],
      [
        'response.output_text.delta',
        {
          type: 'response.output_text.delta',
          sequence_number: 2,
          item_id: 'msg_cap',
          output_index: 0,
          content_index: 0,
          delta: text,
        },
      ],
      ['response.output_item.done', { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item }],
      [
        'response.completed',
        { type: 'response.completed', sequence_number: 4, response: response('completed', [item]) },
      ],
    ]),
  )
}

/** Every `cache_control` a request asks for, by where it sits. */
function cacheControls(body: Record<string, unknown>): string[] {
  const found: string[] = []
  const walk = (value: unknown, at: string) => {
    if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${at}[${i}]`))
    else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'cache_control') found.push(`${at}: ${JSON.stringify(inner)}`)
        else if (key !== 'input_schema') walk(inner, `${at}.${key}`)
      }
    }
  }
  for (const key of ['system', 'tools', 'messages']) walk(body[key], key)
  return found
}

function print(title: string, seen: readonly Seen[]) {
  console.log(`\n--- ${title}: ${seen.length} request(s)`)
  for (const r of seen) {
    console.log(`POST ${r.path} model=${String(r.body.model)}`)
    for (const [name, value] of Object.entries(r.headers).sort(([a], [b]) => (a < b ? -1 : 1)))
      if (!NOISE.has(name)) console.log(`    ${name}: ${value}`)
    if (r.path.includes('/anthropic/')) {
      const system = r.body.system as { text?: string }[] | string | undefined
      const first = typeof system === 'string' ? system : system?.[0]?.text
      console.log(`    system[0] starts: ${JSON.stringify(first?.slice(0, 60))}`)
      for (const line of cacheControls(r.body)) console.log(`    cache_control ${line}`)
    }
  }
}

describe.skipIf(!live)('live: the pinned build on the gateway (a loopback stand-in, no LLM)', () => {
  const seen: Seen[] = []
  let answer: (leg: 'anthropic' | 'chat' | 'responses', r: Seen) => Response = () => new Response(null, { status: 500 })
  const stateDir = mkdtempSync(join(tmpdir(), 'och-live-gw-'))
  const gateway = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method !== 'POST') return new Response('{}', { status: 404 })
      const body = (await req.json()) as Record<string, unknown>
      const headers = Object.fromEntries(
        [...req.headers].map(([k, v]) => [k, k === 'x-api-key' || k === 'authorization' ? '<dummy>' : v]),
      )
      const r: Seen = { path: `${url.pathname}${url.search}`, headers, body, requestHeaders: req.headers }
      seen.push(r)
      if (url.pathname === '/anthropic/v1/messages') return answer('anthropic', r)
      if (url.pathname === '/openai/v1/chat/completions') return answer('chat', r)
      if (url.pathname === '/openai/v1/responses') return answer('responses', r)
      return new Response('{}', { status: 404 })
    },
  })
  const env = {
    PATH: '/usr/bin:/bin',
    AGW_GATEWAY_URL: `http://127.0.0.1:${gateway.port}`,
    AGW_GATEWAY_TOOL_TOKEN: TOKEN,
  }
  // Every step runs under this arm, as a step of an armed run does: the running server serves both moves.
  const arm = {
    routes: {
      'brain.agent': { model: 'claude-haiku-5-5', effort: null },
      'research.agent': { model: 'claude-sonnet-5-5', effort: 'low', fallback: null },
    },
  }
  const server = new OpenCodeServer({
    stateDir,
    env,
    // The server's env is an allow-list, so the dead proxy goes in front of the binary.
    command: [
      '/usr/bin/env',
      'HTTP_PROXY=http://127.0.0.1:9',
      'HTTPS_PROXY=http://127.0.0.1:9',
      'NO_PROXY=127.0.0.1,localhost',
      BIN,
    ],
  })
  const host = new OpenCodeHost({
    server,
    stateDir,
    agents: [
      {
        name: 'probe',
        route: 'brain.agent',
        agentsMd: '# Rules\n\nAnswer in one word.\n',
        permissions: { rules: [{ action: 'subagent', resource: '*', effect: 'allow' }] },
      },
    ],
  })

  beforeAll(async () => {
    await server.start()
  }, 90_000)
  afterAll(async () => {
    host.close()
    await server.close()
    const pid = (JSON.parse(readFileSync(join(server.root, 'server.json'), 'utf8')) as { pid: number }).pid
    process.kill(pid, 'SIGKILL')
    await gateway.stop(true)
    rmSync(stateDir, { recursive: true, force: true })
  })

  const attribution = (runId: string, step: string): Attribution => ({
    runId,
    rootId: 'root-of-the-tree',
    workflow: 'probe-workflow',
    step,
    purpose: 'verify',
    project: 'agent-workflows',
    workspace: 'private',
  })

  const step = async (
    runId: string,
    stepId: string,
    options: Json,
    prompt = 'ping',
  ): Promise<{ handle: Json; result: AgentResult }> => {
    const handle = await host.open({
      runId,
      stepId,
      key: `${runId}:${stepId}`,
      agent: 'probe',
      prompt,
      options,
      attribution: attribution(runId, stepId),
      arm,
    })
    await host.prompt(handle, prompt)
    const result = await host.wait(handle, {
      signal: AbortSignal.timeout(60_000),
      onProgress: () => {},
      onTool: async () => {},
    })
    return { handle, result }
  }

  const attributed = (r: Seen, stepId: string, runId: string) => {
    expect(r.headers['x-agw-session']).toBe('root-of-the-tree')
    expect(r.headers['x-agw-run-id']).toBe(runId)
    expect(r.headers['x-agw-step']).toBe(stepId)
    expect(r.headers['x-agw-workflow']).toBe('probe-workflow')
    expect(r.headers['x-agw-purpose']).toBe('verify')
    expect(r.headers['x-agw-project']).toBe('agent-workflows')
    expect(r.headers['x-agw-workspace']).toBe('private')
  }

  test('the Anthropic leg: attribution, no Claude Code signal, the ask for cache writes, their price', async () => {
    seen.length = 0
    answer = (_, r) => anthropicText(String(r.body.model), 'PONG')
    const plain = await step('run-a', 'step-a', { route: 'brain.agent' })
    const thinking = await step('run-a', 'step-b', { route: 'research.agent' })
    print('anthropic leg', seen)
    expect(plain.result.output).toBe('PONG')
    expect(seen.length).toBe(2)
    for (const r of seen) {
      expect(r.path).toStartWith('/anthropic/v1/messages')
      expect(r.headers['x-api-key']).toBe('<dummy>')
      expect(r.headers['x-agw-fallback']).toBe('none')
      expect(isClaudeCodeShaped(r.requestHeaders, r.body)).toBe(false)
    }
    attributed(seen[0] as Seen, 'step-a', 'run-a')
    attributed(seen[1] as Seen, 'step-b', 'run-a')
    for (const r of seen) {
      const ttls = cacheControls(r.body).filter((line) => line.includes('"ttl"'))
      expect(ttls).toEqual([])
    }
    console.log('usage (1000 tokens written, 5m):', JSON.stringify(plain.result.usage))
    console.log('usage, thinking route:', JSON.stringify(thinking.result.usage))
  }, 120_000)

  test('a follow-up turn carries the continuing step', async () => {
    seen.length = 0
    answer = (_, r) => anthropicText(String(r.body.model), 'PONG')
    const { handle } = await step('run-f', 'first', { route: 'brain.agent' })
    const next = await host.followUp(handle, {
      runId: 'run-f',
      stepId: 'second',
      key: 'run-f:second',
      attempt: 1,
      attribution: attribution('run-f', 'second'),
    })
    await host.prompt(next, 'again')
    await host.wait(next, { signal: AbortSignal.timeout(60_000), onProgress: () => {}, onTool: async () => {} })
    print('follow-up', seen)
    expect(seen.map((r) => r.headers['x-agw-step'])).toEqual(['first', 'second'])
  }, 120_000)

  test('a child session walks to its root', async () => {
    seen.length = 0
    let calls = 0
    answer = (_, r) => {
      calls += 1
      return calls === 1
        ? anthropicToolCall(String(r.body.model), 'subagent', {
            agent: 'general',
            description: 'probe the child',
            prompt: 'ping',
          })
        : anthropicText(String(r.body.model), 'PONG')
    }
    await step('run-c', 'parent', { route: 'brain.agent' })
    print('child session', seen)
    const child = seen.find((r) => r.headers['x-opencode-parent-session-id'])
    expect(child).toBeDefined()
    attributed(child as Seen, 'parent', 'run-c')
  }, 120_000)

  test('the chat and Responses legs: attribution, no x-agw-fallback', async () => {
    seen.length = 0
    answer = (leg, r) =>
      leg === 'chat' ? chatText(String(r.body.model), 'PONG') : responsesText(String(r.body.model), 'PONG')
    await step('run-o', 'chat', { route: 'research.agent' })
    await step('run-o', 'responses', { route: 'check' })
    print('openai legs', seen)
    expect(seen.map((r) => r.path)).toEqual(['/openai/v1/chat/completions', '/openai/v1/responses'])
    attributed(seen[0] as Seen, 'chat', 'run-o')
    attributed(seen[1] as Seen, 'responses', 'run-o')
    for (const r of seen) {
      expect(r.headers.authorization).toBe('<dummy>')
      expect(r.headers['x-agw-fallback']).toBeUndefined()
    }
  }, 120_000)

  test("the gateway's 402 moves the step to the route's fallback", async () => {
    seen.length = 0
    answer = (leg, r) =>
      leg === 'anthropic' ? Response.json(GATEWAY_402, { status: 402 }) : chatText(String(r.body.model), 'FALLBACK')
    const { handle, result } = await step('run-b', 'balance', { route: 'brain.agent' })
    print('402', seen)
    const client = createClient(() => server.endpoint())
    const messages: Message[] = await client.messages((handle as { sessionId: string }).sessionId)
    const failed = messages.filter((m) => m.error !== undefined)
    console.log('session error (verbatim):', JSON.stringify(failed.map((m) => m.error)))
    const error = failed[0]?.error
    const text = typeof error === 'string' ? error : (error?.message ?? JSON.stringify(error))
    expect(isBalanceFailure({ text })).toBe(true)
    expect(result.output).toBe('FALLBACK')
    expect(seen.map((r) => r.path.split('?')[0])).toEqual(['/anthropic/v1/messages', '/openai/v1/chat/completions'])
  }, 120_000)
})
