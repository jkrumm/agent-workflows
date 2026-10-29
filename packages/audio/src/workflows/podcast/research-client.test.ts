import { describe, expect, test } from 'bun:test'
import { researchClient, researchClientFromEnv } from './research-client.ts'

// The `research` tool's client of the host's HTTP API, against a scripted host.

type Call = { url: string; init: RequestInit }

function scriptedHost(replies: { status?: number; body: unknown }[]) {
  const calls: Call[] = []
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const reply = replies.shift()
    if (!reply) throw new Error('no scripted reply left')
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 })
  }
  return { calls, fetch }
}

const OPTIONS = { url: 'http://127.0.0.1:1', secret: 's'.repeat(32), purpose: 'eval' }

describe('researchClient', () => {
  test('starts the run, waits until it ended and its cost is known, returns report and sources', async () => {
    const host = scriptedHost([
      { status: 202, body: { runId: 'r1', workflowId: 'research', status: 'running' } },
      {
        body: {
          runId: 'r1',
          workflowId: 'research',
          status: 'done',
          output: { report: 'R', sources: ['u'] },
          costPending: true,
        },
      },
      {
        body: {
          runId: 'r1',
          workflowId: 'research',
          status: 'done',
          output: { report: 'R', sources: ['u'] },
          cost: 0.04,
        },
      },
    ])
    let progress = 0
    const client = researchClient({ ...OPTIONS, fetch: host.fetch })
    const answer = await client.run('What is X?', 'quick', new AbortController().signal, () => progress++)
    expect(answer).toEqual({ ok: true, report: 'R', sources: ['u'], usd: 0.04, runId: 'r1' })
    expect(host.calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:1/workflows/research',
      'http://127.0.0.1:1/runs/r1/wait',
      'http://127.0.0.1:1/runs/r1/wait',
    ])
    expect(JSON.parse(String(host.calls[0]?.init.body))).toEqual({ query: 'What is X?', depth: 'quick' })
    const headers = host.calls[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${OPTIONS.secret}`)
    expect(headers['x-agw-purpose']).toBe('eval')
    expect(headers.prefer).toBe('wait=240')
    expect(progress).toBe(3)
  })

  test('a failed run and a refused start are tool errors, never throws', async () => {
    const failed = scriptedHost([
      { body: { runId: 'r2', status: 'failed', error: { kind: 'step_failed', message: 'no sources' } } },
    ])
    const signal = new AbortController().signal
    expect(await researchClient({ ...OPTIONS, fetch: failed.fetch }).run('q?', 'standard', signal, () => {})).toEqual({
      ok: false,
      error: 'error: research failed: no sources',
    })
    const refused = scriptedHost([{ status: 401, body: { message: 'Unauthorized' } }])
    const answer = await researchClient({ ...OPTIONS, fetch: refused.fetch }).run('q?', 'quick', signal, () => {})
    expect(answer.ok).toBe(false)
  })

  test('a cost that never arrives is reported unpriced after a few polls', async () => {
    const pending = { runId: 'r3', status: 'done', output: { report: 'R', sources: [] }, costPending: true }
    const host = scriptedHost([{ body: pending }, { body: pending }, { body: pending }, { body: pending }])
    const answer = await researchClient({ ...OPTIONS, fetch: host.fetch }).run(
      'q?',
      'quick',
      new AbortController().signal,
      () => {},
    )
    expect(answer).toEqual({ ok: true, report: 'R', sources: [], usd: null, runId: 'r3' })
    expect(host.calls).toHaveLength(4)
  })

  test('from env: needs both the host URL and the secret', () => {
    expect(researchClientFromEnv({ AGW_URL: 'http://h/', AGW_API_SECRET: 'x' }, 'prod')).toEqual({
      url: 'http://h',
      secret: 'x',
      purpose: 'prod',
    })
    expect(researchClientFromEnv({ AGW_URL: 'http://h' }, 'prod')).toBeNull()
  })
})
