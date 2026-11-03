import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONTEXT_LIMITS, claudeRate } from '@agent-workflows/routes'
import type { AgentResult, Attribution } from '@agent-workflows/runtime'
import { OpenCodeHost, OpenCodeServer } from '../src/index.ts'
import { COMPACTION_BUFFER, contextAlias, windowFor } from '../src/config.ts'

const BOUND = Math.max(...CONTEXT_LIMITS)

// What the pinned OpenCode build does with a bounded route (`contextLimit`), end to end through this host: the real
// binary, the real config, a loopback server standing in for the gateway. No LLM is called, nothing leaves loopback.
// Proves (1) the provider is called with the real model id, never the alias key, and (2) the session compacts where
// `windowFor` says (ceiling = window - `COMPACTION_BUFFER`, chars/4 estimate), and not before, and that the summary call
// has the room `COMPACTION_BUFFER` is for. Run with:
//   AGW_LIVE=1 timeout 300 bun test packages/opencode-host/test/live-context-limit.test.ts
const live = process.env.AGW_LIVE === '1'
const BIN = join(homedir(), '.local/share/agent-workflows/opencode-bin/current/node_modules/.bin/opencode')

type Seen = { path: string; body: { model?: string; max_tokens?: number; messages?: unknown[]; system?: unknown } }

const sse = (events: [string, unknown][]) =>
  events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')

type CallUsage = { input: number; output: number; cacheRead: number; cacheWrite: number }
const DEFAULT_USAGE: CallUsage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }

/** One streamed Anthropic reply: `out` as text, or a tool call, with the usage the stand-in reports for the call. */
const reply = (model: string, out: string | { tool: string; input: unknown }, u: CallUsage = DEFAULT_USAGE) => {
  const block =
    typeof out === 'string'
      ? { type: 'text', text: '' }
      : { type: 'tool_use', id: 'toolu_cl', name: out.tool, input: {} }
  const delta =
    typeof out === 'string'
      ? { type: 'text_delta', text: out }
      : { type: 'input_json_delta', partial_json: JSON.stringify(out.input) }
  return new Response(
    sse([
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'msg_cl',
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: u.input,
              output_tokens: u.output,
              cache_creation_input_tokens: u.cacheWrite,
              cache_read_input_tokens: u.cacheRead,
              cache_creation: { ephemeral_5m_input_tokens: u.cacheWrite, ephemeral_1h_input_tokens: 0 },
            },
          },
        },
      ],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: block }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: typeof out === 'string' ? 'end_turn' : 'tool_use', stop_sequence: null },
          usage: { output_tokens: u.output },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ]),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

const SUMMARY = '## Objective\n- probe\n\n## Next Move\n1. (none)\n'
const isSummaryCall = (r: Seen) => JSON.stringify(r.body.messages).includes('structured summary')

/** A prompt of about `tokens` estimated tokens (OpenCode counts characters / 4), words that are not one repeat. */
const prompt = (tokens: number) => {
  const words = Array.from(
    { length: Math.ceil((tokens * 4) / 6) },
    (_, i) => `w${(i % 9973).toString(36).padStart(4, '0')}`,
  )
  return `Reply with the one word PONG. Ignore the filler below.\n${words.join(' ')}`
}

describe.skipIf(!live)('live: a bounded route on the pinned build (a loopback stand-in, no LLM)', () => {
  const seen: Seen[] = []
  /** What the stand-in answers request number n with (1-based) and the usage it reports; unset: PONG or a summary. */
  let script: ((r: Seen, n: number) => { out: string | { tool: string; input: unknown }; usage: CallUsage }) | undefined
  // Nothing below starts at collection time: `describe.skipIf` still runs this body, so every resource is made in
  // `beforeAll`, which a skipped block never runs.
  let stateDir: string
  let gateway: ReturnType<typeof Bun.serve>
  let server: OpenCodeServer
  let host: OpenCodeHost

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'och-live-ctx-'))
    gateway = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (req.method !== 'POST' || url.pathname !== '/anthropic/v1/messages')
          return new Response('{}', { status: 404 })
        const r: Seen = { path: url.pathname, body: (await req.json()) as Seen['body'] }
        seen.push(r)
        const scripted = script?.(r, seen.length)
        if (scripted) return reply(String(r.body.model), scripted.out, scripted.usage)
        return reply(String(r.body.model), isSummaryCall(r) ? SUMMARY : 'PONG')
      },
    })
    server = new OpenCodeServer({
      stateDir,
      env: {
        PATH: '/usr/bin:/bin',
        AGW_GATEWAY_URL: `http://127.0.0.1:${gateway.port}`,
        AGW_GATEWAY_TOOL_TOKEN: 'dummy-door-token',
      },
      command: [
        '/usr/bin/env',
        'HTTP_PROXY=http://127.0.0.1:9',
        'HTTPS_PROXY=http://127.0.0.1:9',
        'NO_PROXY=127.0.0.1,localhost',
        BIN,
      ],
    })
    host = new OpenCodeHost({
      server,
      stateDir,
      agents: [{ name: 'probe', route: 'review.angle', agentsMd: '# Rules\n\nAnswer in one word.\n' }],
    })
    await server.start()
  }, 90_000)
  afterAll(async () => {
    host?.close()
    await server?.close()
    if (server) {
      const pid = (JSON.parse(readFileSync(join(server.root, 'server.json'), 'utf8')) as { pid: number }).pid
      process.kill(pid, 'SIGKILL')
    }
    await gateway?.stop(true)
    if (stateDir) rmSync(stateDir, { recursive: true, force: true })
  })

  const attribution = (runId: string): Attribution => ({
    runId,
    rootId: runId,
    workflow: 'probe-workflow',
    step: 'probe',
    purpose: 'verify',
    project: 'agent-workflows',
    workspace: 'private',
  })

  let last: { result: AgentResult; handle: { sessionId: string; route: string }; tools: string[] } | undefined
  const run = async (runId: string, limit: number | null, tokens: number) => {
    seen.length = 0
    // `null` clears the table's bound: the plain row.
    const arm = { routes: { 'review.angle': { contextLimit: limit } } }
    const handle = await host.open({
      runId,
      stepId: 'probe',
      key: `${runId}:probe`,
      agent: 'probe',
      prompt: '',
      options: { route: 'review.angle' },
      attribution: attribution(runId),
      arm,
    })
    const body = prompt(tokens)
    await host.prompt(handle, body)
    const tools: string[] = []
    const result = await host.wait(handle, {
      signal: AbortSignal.timeout(90_000),
      onProgress: () => {},
      onTool: async (event) => {
        tools.push(`${event.phase}:${event.tool}`)
      },
    })
    last = { result, handle: handle as { sessionId: string; route: string }, tools }
    return [...seen]
  }

  test('the gateway gets the real model id, never the alias key', async () => {
    const bounded = await run('run-alias', BOUND, 1_000)
    console.log(
      'bounded:',
      bounded.map((r) => `${r.path} model=${r.body.model} max_tokens=${r.body.max_tokens}`),
    )
    expect(bounded.length).toBe(1)
    expect(bounded[0]?.body.model).toBe('claude-haiku-5-5')
    // OpenCode's system prompt still tells the model its "Model ID" is the alias key (measured): text only, not a wire id.
    const plain = await run('run-plain', null, 1_000)
    console.log(
      'plain:',
      plain.map((r) => `model=${r.body.model} max_tokens=${r.body.max_tokens}`),
    )
    expect(plain[0]?.body.model).toBe('claude-haiku-5-5')
  }, 120_000)

  test('a prompt under the ceiling runs as one call; over it, the session compacts first', async () => {
    const ceiling = windowFor(BOUND) - COMPACTION_BUFFER
    const under = await run('run-under', BOUND, ceiling - 6_000)
    console.log(
      `ceiling ${ceiling}: under ->`,
      under.map((r) => (isSummaryCall(r) ? 'summary' : 'call')),
    )
    expect(under.map(isSummaryCall)).toEqual([false])
    const over = await run('run-over', BOUND, ceiling + 3_000)
    console.log(
      `ceiling ${ceiling}: over ->`,
      over.map((r) => (isSummaryCall(r) ? 'summary' : 'call')),
    )
    expect(over.some(isSummaryCall)).toBe(true)
    // The room for the summary (thinking included): 10,733 tokens with OpenCode's default 16k reserve, 32,000 now.
    const summary = over.find(isSummaryCall)
    console.log('summary max_tokens:', summary?.body.max_tokens)
    expect(summary?.body.max_tokens).toBeGreaterThanOrEqual(30_000)
    expect(summary?.body.max_tokens).toBeLessThanOrEqual(32_000)
    for (const r of over) expect(r.body.model).toBe('claude-haiku-5-5')
    // The same prompt on the plain row is one call: nothing bounds it.
    const plain = await run('run-unbounded', null, ceiling + 3_000)
    expect(plain.map(isSummaryCall)).toEqual([false])
    expect(contextAlias('claude-haiku-5-5', BOUND)).toBe(`claude-haiku-5-5~ctx${BOUND}`)
  }, 180_000)
  test('one compaction after a tool call: the step usage is the sum of every call the gateway got, once', async () => {
    const calls: CallUsage[] = [
      // The call that grows the session past the 80k ceiling (measured prompt 83k), asking for a tool.
      { input: 3_000, output: 40, cacheRead: 50_000, cacheWrite: 30_000 },
      // The summary call, then the call that answers from the summary.
      { input: 2_500, output: 120, cacheRead: 0, cacheWrite: 0 },
      { input: 800, output: 5, cacheRead: 0, cacheWrite: 0 },
    ]
    script = (_r, n) => ({
      out: n === 1 ? { tool: 'glob', input: { pattern: '*.md' } } : n === 2 ? SUMMARY : 'PONG',
      usage: calls[n - 1] as CallUsage,
    })
    const got = await run('run-usage', BOUND, 1_000)
    script = undefined
    console.log(
      'calls:',
      got.map((r) => (isSummaryCall(r) ? 'summary' : 'call')),
      'tools:',
      last?.tools,
    )
    expect(got.map(isSummaryCall)).toEqual([false, true, false])
    const { result, handle, tools } = last as NonNullable<typeof last>
    // One session, no fallback: one usage entry.
    const usage = Array.isArray(result.usage)
      ? (result.usage as unknown[]).length === 1
        ? result.usage[0]
        : undefined
      : result.usage
    expect(usage).toBeDefined()
    const sum = (key: keyof CallUsage) => calls.reduce((total, c) => total + c[key], 0)
    // The runtime's raw counts: input includes the cache, output includes reasoning.
    expect(usage?.tokens).toEqual({
      input: sum('input') + sum('cacheRead') + sum('cacheWrite'),
      output: sum('output'),
      cacheRead: sum('cacheRead'),
      cacheWrite: sum('cacheWrite'),
      reasoning: 0,
    })
    const rate = claudeRate('claude-haiku-5-5')
    if (!rate) throw new Error('test setup: no Haiku rate')
    const usd = calls.reduce(
      (total, c) =>
        total +
        (c.input * rate.inputPerM +
          c.output * rate.outputPerM +
          c.cacheRead * (rate.cacheReadPerM ?? 0) +
          c.cacheWrite * (rate.cacheWritePerM ?? 0)) /
          1e6,
      0,
    )
    expect(usage?.cost).toBeCloseTo(usd, 9)
    // The route, the real model and the tool call stay right after the compaction.
    expect(usage).toMatchObject({ route: 'review.angle', model: 'claude-haiku-5-5', toolCalls: 1 })
    expect(handle.route).toBe('review.angle')
    expect(tools).toEqual(['pre:glob', 'post:glob'])
    expect(result.output).toBe('PONG')
    for (const r of got) expect(r.body.model).toBe('claude-haiku-5-5')
  }, 180_000)
})
