import { describe, expect, test } from 'bun:test'
import { Cancelled, InfraError, Shutdown } from '../../../../runtime/src/index.ts'
import { researchKey, researchKeyPrefix } from './ports.ts'
import { researchClient, researchClientFromEnv } from './research-client.ts'

// The `research` tool's client of the host's HTTP API, against a scripted host.

type Call = { url: string; init: RequestInit }
type Reply = { status?: number; body: unknown } | 'network'

function scriptedHost(replies: Reply[]) {
  const calls: Call[] = []
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const reply = replies.shift()
    if (!reply) throw new Error('no scripted reply left')
    if (reply === 'network') throw new Error('connection reset')
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 })
  }
  return { calls, fetch }
}

const OPTIONS = { url: 'http://127.0.0.1:1', secret: 's'.repeat(32), purpose: 'eval', backoffMs: 1 }
const KEY = researchKey('run-1', 'research', 'quick', 'what is x?')
const call = (signal = new AbortController().signal, progress: () => void = () => {}) => ({
  key: KEY,
  signal,
  progress,
})
const done = { runId: 'r1', workflowId: 'research', status: 'done', output: { report: 'R', sources: ['u'] } }

describe('researchKey', () => {
  test('this run, the step and the hashed query: stable, distinct per step and query, under the run prefix', () => {
    expect(KEY.startsWith(`${researchKeyPrefix('run-1')}research:`)).toBe(true)
    expect(researchKey('run-1', 'research', 'quick', 'what is x?')).toBe(KEY)
    expect(researchKey('run-1', 'research:fact:0', 'quick', 'what is x?')).not.toBe(KEY)
    expect(researchKey('run-1', 'research', 'standard', 'what is x?')).not.toBe(KEY)
    expect(researchKey('run-2', 'research', 'quick', 'what is x?')).not.toBe(KEY)
    expect(KEY.length).toBeLessThanOrEqual(255)
  })
})

describe('researchClient', () => {
  test('starts the run under the idempotency key, waits until it ended, returns report and sources', async () => {
    const host = scriptedHost([
      { status: 202, body: { runId: 'r1', workflowId: 'research', status: 'running' } },
      { body: done },
    ])
    let progress = 0
    const answer = await researchClient({ ...OPTIONS, fetch: host.fetch }).run(
      'What is X?',
      'quick',
      call(undefined, () => progress++),
    )
    expect(answer).toEqual({ ok: true, report: 'R', sources: ['u'], runId: 'r1' })
    expect(host.calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:1/workflows/research',
      'http://127.0.0.1:1/runs/r1/wait',
    ])
    expect(JSON.parse(String(host.calls[0]?.init.body))).toEqual({ query: 'What is X?', depth: 'quick' })
    const headers = host.calls[0]?.init.headers as Record<string, string>
    expect(headers['idempotency-key']).toBe(KEY)
    expect(headers.authorization).toBe(`Bearer ${OPTIONS.secret}`)
    expect(headers['x-agw-purpose']).toBe('eval')
    expect(headers.prefer).toBe('wait=240')
    expect(progress).toBe(2)
  })

  test('a transient failure retries the same request: the start under its key, the wait on its run id', async () => {
    const host = scriptedHost([
      'network',
      { status: 202, body: { runId: 'r1', status: 'running' } },
      { status: 503, body: { message: 'busy' } },
      'network',
      { body: done },
    ])
    const answer = await researchClient({ ...OPTIONS, fetch: host.fetch }).run('q?', 'quick', call())
    expect(answer.ok).toBe(true)
    expect(host.calls.map((c) => c.url.replace(OPTIONS.url, ''))).toEqual([
      '/workflows/research',
      '/workflows/research',
      '/runs/r1/wait',
      '/runs/r1/wait',
      '/runs/r1/wait',
    ])
    const retriedStart = host.calls[1]?.init.headers as Record<string, string> | undefined
    expect(retriedStart?.['idempotency-key']).toBe(KEY)
  })

  /** A host that answers the start, then aborts the step with `reason` on the first wait. */
  function abortingHost(reason: unknown) {
    const abort = new AbortController()
    const calls: string[] = []
    const fetch = async (url: string, init: RequestInit) => {
      calls.push(url.replace(OPTIONS.url, ''))
      if (url.endsWith('/workflows/research')) return Response.json({ runId: 'r9', status: 'running' }, { status: 202 })
      if (url.endsWith('/cancel')) return Response.json({ runId: 'r9', status: 'cancelled' })
      abort.abort(reason)
      throw (init.signal as AbortSignal).reason
    }
    return { abort, calls, fetch }
  }

  test('a cancel of the podcast run cancels the host run and rethrows', async () => {
    const host = abortingHost(new Cancelled('podcast-run'))
    const error = await researchClient({ ...OPTIONS, fetch: host.fetch })
      .run('q?', 'quick', call(host.abort.signal))
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Cancelled)
    expect(host.calls).toEqual(['/workflows/research', '/runs/r9/wait', '/runs/r9/cancel'])
  })

  test('a shutdown, lease loss or step timeout leaves the host run going: the resume re-attaches by key', async () => {
    for (const reason of [new Shutdown('runtime closing'), new InfraError('lease lost'), new Error('idle timeout')]) {
      const host = abortingHost(reason)
      const error = await researchClient({ ...OPTIONS, fetch: host.fetch })
        .run('q?', 'quick', call(host.abort.signal))
        .catch((e: unknown) => e)
      expect(error).toBe(reason)
      expect(host.calls).toEqual(['/workflows/research', '/runs/r9/wait'])
    }
  })

  test('an unknown run status fails the call instead of polling forever', async () => {
    const host = scriptedHost([{ status: 202, body: { runId: 'r1', status: 'paused' } }])
    const answer = await researchClient({ ...OPTIONS, fetch: host.fetch }).run('q?', 'quick', call())
    expect(answer).toEqual({ ok: false, error: 'error: research run r1 answered an unknown status "paused"' })
    expect(host.calls).toHaveLength(1)
  })

  test('a failed run and a refused start are tool errors, never throws', async () => {
    const failed = scriptedHost([
      { body: { runId: 'r2', status: 'failed', error: { kind: 'step_failed', message: 'no sources' } } },
    ])
    expect(await researchClient({ ...OPTIONS, fetch: failed.fetch }).run('q?', 'standard', call())).toEqual({
      ok: false,
      error: 'error: research failed: no sources',
    })
    const refused = scriptedHost([{ status: 401, body: { message: 'Unauthorized' } }])
    const answer = await researchClient({ ...OPTIONS, fetch: refused.fetch }).run('q?', 'quick', call())
    expect(answer.ok).toBe(false)
    expect(refused.calls).toHaveLength(1)
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
