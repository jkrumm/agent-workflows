import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Attribution } from '@agent-workflows/runtime'
import { OpenCodeHost, OpenCodeServer } from '../src/index.ts'
import { contextAlias, windowFor } from '../src/config.ts'

// What the pinned OpenCode build does with a bounded route (`contextLimit`), end to end through this host: the real
// binary, the real config, a loopback server standing in for the gateway. No LLM is called, nothing leaves loopback.
// Proves (1) the provider is called with the real model id, never the alias key, and (2) the session compacts where
// `windowFor` says (ceiling = window - 16k, chars/4 estimate), and not before. Run with:
//   AGW_LIVE=1 timeout 300 bun test packages/opencode-host/test/live-context-limit.test.ts
const live = process.env.AGW_LIVE === '1'
const BIN = join(homedir(), '.local/share/agent-workflows/opencode-bin/current/node_modules/.bin/opencode')

type Seen = { path: string; body: { model?: string; max_tokens?: number; messages?: unknown[]; system?: unknown } }

const sse = (events: [string, unknown][]) =>
  events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')

const text = (model: string, out: string) =>
  new Response(
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
            usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        },
      ],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: out } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      ],
      ['message_stop', { type: 'message_stop' }],
    ]),
    { headers: { 'content-type': 'text/event-stream' } },
  )

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
  const stateDir = mkdtempSync(join(tmpdir(), 'och-live-ctx-'))
  const gateway = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method !== 'POST' || url.pathname !== '/anthropic/v1/messages') return new Response('{}', { status: 404 })
      const r: Seen = { path: url.pathname, body: (await req.json()) as Seen['body'] }
      seen.push(r)
      return text(String(r.body.model), isSummaryCall(r) ? SUMMARY : 'PONG')
    },
  })
  const server = new OpenCodeServer({
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
  const host = new OpenCodeHost({
    server,
    stateDir,
    agents: [{ name: 'probe', route: 'review.angle', agentsMd: '# Rules\n\nAnswer in one word.\n' }],
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

  const attribution = (runId: string): Attribution => ({
    runId,
    rootId: runId,
    workflow: 'probe-workflow',
    step: 'probe',
    purpose: 'verify',
    project: 'agent-workflows',
    workspace: 'private',
  })

  const run = async (runId: string, limit: number | null, tokens: number) => {
    seen.length = 0
    const arm = limit === null ? undefined : { routes: { 'review.angle': { contextLimit: limit } } }
    const handle = await host.open({
      runId,
      stepId: 'probe',
      key: `${runId}:probe`,
      agent: 'probe',
      prompt: '',
      options: { route: 'review.angle' },
      attribution: attribution(runId),
      ...(arm ? { arm } : {}),
    })
    const body = prompt(tokens)
    await host.prompt(handle, body)
    await host.wait(handle, { signal: AbortSignal.timeout(90_000), onProgress: () => {}, onTool: async () => {} })
    return [...seen]
  }

  test('the gateway gets the real model id, never the alias key', async () => {
    const bounded = await run('run-alias', 80_000, 1_000)
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
    const ceiling = windowFor(80_000) - 16_000
    const under = await run('run-under', 80_000, ceiling - 6_000)
    console.log(
      `ceiling ${ceiling}: under ->`,
      under.map((r) => (isSummaryCall(r) ? 'summary' : 'call')),
    )
    expect(under.map(isSummaryCall)).toEqual([false])
    const over = await run('run-over', 80_000, ceiling + 3_000)
    console.log(
      `ceiling ${ceiling}: over ->`,
      over.map((r) => (isSummaryCall(r) ? 'summary' : 'call')),
    )
    expect(over.some(isSummaryCall)).toBe(true)
    for (const r of over) expect(r.body.model).toBe('claude-haiku-5-5')
    // The same prompt on the plain row is one call: nothing bounds it.
    const plain = await run('run-unbounded', null, ceiling + 3_000)
    expect(plain.map(isSummaryCall)).toEqual([false])
    expect(contextAlias('claude-haiku-5-5', 80_000)).toBe('claude-haiku-5-5~ctx80000')
  }, 180_000)
})
