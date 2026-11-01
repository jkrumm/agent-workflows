import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { BALANCE_MARKER, claudeRate, costFromUsage, resolveModelAlias } from '@agent-workflows/routes'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace'
import { Ledger } from '../src/ledger.ts'
import { createTelemetry } from '../src/telemetry.ts'
import {
  API_SECRET,
  BALANCE_REFUSAL,
  DOOR_TOKEN,
  fakeUpstream,
  harness,
  type Harness,
  HERMES_TOKEN,
  IU_KEY,
  jsonBody,
  pool,
  POOL_KEY,
  refusalResponse,
  silentLogger,
  sse,
  sseResponse,
  tempDir,
  type Upstream,
} from './support.ts'

const MESSAGES = '/anthropic/v1/messages'
const USAGE = {
  input_tokens: 1000,
  cache_read_input_tokens: 2000,
  cache_creation_input_tokens: 400,
  cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 300 },
  output_tokens: 50,
}
const haikuId = resolveModelAlias('haiku')
const message = { type: 'message', model: haikuId, usage: USAGE }
const anthropicReply = () => Response.json(message)
const request = (extra: Record<string, unknown> = {}) => ({
  model: haikuId,
  max_tokens: 8,
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
})

let anthropic: Upstream
let iu: Upstream
let gateway: Harness | undefined

beforeEach(() => {
  anthropic = fakeUpstream(anthropicReply)
  iu = fakeUpstream(anthropicReply)
})

afterEach(async () => {
  await gateway?.close()
  gateway = undefined
  anthropic.stop()
  iu.stop()
})

const start = (input: Partial<Parameters<typeof harness>[0]> = {}): Harness => {
  gateway = harness({ anthropic, iu, ...input })
  return gateway
}

describe('passthrough', () => {
  test('a concrete id goes upstream byte for byte, whatever its formatting', async () => {
    const gw = start({ registry: [pool('iu')] })
    const bytes = `{  "model" : "${haikuId}",\n "max_tokens":8, "é":"\\u00e9", "messages":[{"role":"user","content":"hi"}] }`
    const response = await gw.call(MESSAGES, {
      method: 'POST',
      body: bytes,
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(new TextDecoder().decode(anthropic.seen[0]?.body)).toBe(bytes)
  })

  test('an alias is the one body edit', async () => {
    const gw = start({ registry: [pool('iu')] })
    await (await gw.call(MESSAGES, jsonBody(request({ model: 'sonnet' })))).text()
    const sent = JSON.parse(new TextDecoder().decode(anthropic.seen[0]?.body)) as Record<string, unknown>
    expect(sent.model).toBe(resolveModelAlias('sonnet'))
    expect(sent.messages).toEqual(request().messages)
  })

  test('the query string survives on both Anthropic upstreams', async () => {
    const gw = start({ registry: [pool('iu')] })
    await (await gw.call(`${MESSAGES}?beta=true`, jsonBody(request()))).text()
    expect(anthropic.seen[0]?.path).toBe('/v1/messages?beta=true')
    const init = jsonBody(request())
    await (await gw.call(`${MESSAGES}?beta=true`, { ...init, headers: { ...init.headers, 'x-app': 'cli' } })).text()
    expect(iu.seen[0]?.path).toBe('/prefix/anthropic/v1/messages?beta=true')
  })

  test('an alias on an IU passthrough path keeps its bytes', async () => {
    iu.reply(() => Response.json({ ok: true }))
    const gw = start()
    const bytes = '{  "model" : "sonnet", "input": [] }'
    const init = { method: 'POST', body: bytes, headers: { 'content-type': 'application/json' } }
    await (await gw.call('/openai/v1/chat/completions', init)).text()
    expect(new TextDecoder().decode(iu.seen[0]?.body)).toBe(bytes)
    expect(gw.rows().records[0]?.row.model).toBe('sonnet')
  })

  test('headers: credentials swapped, x-agw-* and hop-by-hop dropped, end-to-end kept', async () => {
    const gw = start({ registry: [pool('iu')] })
    const init = jsonBody(request())
    await (
      await gw.call(MESSAGES, {
        ...init,
        headers: {
          ...init.headers,
          'anthropic-beta': 'interleaved-thinking-2025-05-14',
          'anthropic-version': '2023-06-01',
          'x-agw-run-id': 'run-1',
          'x-agw-session': 's',
          'x-agw-fallback': 'iu',
          'x-custom': 'kept',
          connection: 'x-listed',
          'x-listed': 'dropped',
        },
      })
    ).text()
    const seen = anthropic.seen[0]
    expect(seen?.headers.get('x-api-key')).toBe(POOL_KEY)
    expect(seen?.headers.get('authorization')).toBeNull()
    expect(seen?.headers.get('anthropic-beta')).toBe('interleaved-thinking-2025-05-14')
    expect(seen?.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(seen?.headers.get('x-custom')).toBe('kept')
    expect(seen?.headers.get('x-listed')).toBeNull()
    expect([...(seen?.headers.keys() ?? [])].filter((name) => name.startsWith('x-agw-'))).toEqual([])
    expect(seen?.headers.get('content-length')).toBe(String(seen?.body.byteLength))
  })

  test('a gzip response reaches the caller with its bytes and header; the tee reads a decoded copy', async () => {
    const gzipped = gzipSync(JSON.stringify(message))
    anthropic.reply(
      () => new Response(gzipped, { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }),
    )
    const gw = start({ registry: [pool('iu')] })
    const init = jsonBody(request())
    const response = await fetch(`${gw.url}${MESSAGES}`, {
      ...init,
      headers: { ...init.headers, 'x-api-key': DOOR_TOKEN, 'accept-encoding': 'gzip' },
      decompress: false,
    } as RequestInit)
    expect(response.headers.get('content-encoding')).toBe('gzip')
    const received = new Uint8Array(await response.arrayBuffer())
    expect(Buffer.compare(received, gzipped)).toBe(0)
    expect(gw.rows().records[0]?.row.input_tokens).toBe(1000)
  })

  test('errors, rate-limit headers and request-id pass through unchanged', async () => {
    const body = '{"type":"error","error":{"type":"invalid_request_error","message":"messages: Field required"}}'
    anthropic.reply(
      () =>
        new Response(body, {
          status: 400,
          headers: {
            'content-type': 'application/json',
            'anthropic-ratelimit-requests-limit': '50',
            'request-id': 'r1',
          },
        }),
    )
    const gw = start({ registry: [pool('iu')] })
    const response = await gw.call(MESSAGES, jsonBody(request()))
    expect(response.status).toBe(400)
    expect(await response.text()).toBe(body)
    expect(response.headers.get('anthropic-ratelimit-requests-limit')).toBe('50')
    expect(response.headers.get('request-id')).toBe('r1')
    expect(gw.rows().records[0]?.row.outcome).toBe('error')
  })

  test('a stream is not buffered: the first event arrives before the upstream ends', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    anthropic.reply(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                new TextEncoder().encode(sse([{ type: 'message_start', message: { model: haikuId, usage: USAGE } }])),
              )
              await gate
              controller.enqueue(
                new TextEncoder().encode(sse([{ type: 'message_delta', usage: { output_tokens: 7 } }])),
              )
              controller.close()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    )
    const gw = start({ registry: [pool('iu')] })
    const response = await gw.call(MESSAGES, jsonBody(request({ stream: true })))
    const reader = response.body?.getReader()
    const first = await reader?.read()
    expect(new TextDecoder().decode(first?.value)).toContain('message_start')
    expect(gw.rows().records).toHaveLength(0)
    release()
    while (!(await reader?.read())?.done);
    expect(gw.rows().records[0]?.row.output_tokens).toBe(7)
  })

  test('the caller hanging up cancels the upstream and writes the row with what is known', async () => {
    let cancelled = false
    anthropic.reply(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(sse([{ type: 'message_start', message: { model: haikuId, usage: USAGE } }])),
              )
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    )
    const gw = start({ registry: [pool('iu')] })
    const abort = new AbortController()
    const response = await gw.call(MESSAGES, { ...jsonBody(request({ stream: true })), signal: abort.signal })
    await response.body?.getReader().read()
    abort.abort()
    for (let i = 0; i < 100 && !(cancelled && gw.rows().records.length > 0); i++) await Bun.sleep(10)
    expect(cancelled).toBe(true)
    const row = gw.rows().records[0]?.row
    expect(row?.outcome).toBe('error')
    expect(row?.raw.ended).toBe('aborted')
    expect(row?.input_tokens).toBe(1000)
  })

  test('the hang guard cuts a silent upstream: 504, a row, a free in-flight slot', async () => {
    anthropic.reply(async () => {
      await Bun.sleep(1000)
      return anthropicReply()
    })
    const gw = start({ registry: [pool('iu')], hangGuardMs: 50 })
    const response = await gw.call(MESSAGES, jsonBody(request()))
    expect(response.status).toBe(504)
    expect(gw.rows().records[0]?.row.outcome).toBe('error')
  })

  test('an unreachable upstream is a 502 with a row', async () => {
    anthropic.stop()
    const gw = start({ registry: [pool('iu')] })
    const response = await gw.call(MESSAGES, jsonBody(request()))
    expect(response.status).toBe(502)
    expect(response.headers.get('x-agw-request-id')).toBe(gw.rows().records[0]?.row.source_id ?? '')
  })

  test.each([
    ['/openai/v1/chat/completions?x=1', '/prefix/openai/v1/chat/completions?x=1'],
    ['/gemini/v1beta/models/m:generateContent', '/prefix/gemini/v1beta/models/m:generateContent'],
    ['/replicate/v1/predictions', '/prefix/replicate/v1/predictions'],
    ['/decisions/v1/decide', '/decisions/v1/decide'],
  ])('%s goes to IU with the personal key', async (path, upstreamPath) => {
    const gw = start({ registry: [pool('iu')] })
    const response = await gw.call(path, jsonBody({ model: 'gpt-x' }))
    expect(response.headers.get('x-agw-pool')).toBe('iu-api')
    await response.text()
    expect(iu.seen[0]?.path).toBe(upstreamPath)
    expect(iu.seen[0]?.headers.get('authorization')).toBe(`Bearer ${IU_KEY}`)
    expect(iu.seen[0]?.headers.get('x-api-key')).toBeNull()
    expect(anthropic.seen).toHaveLength(0)
    expect(gw.rows().picks).toHaveLength(0)
  })

  test('a binary upload to a path keeps its bytes and is not parsed', async () => {
    const gw = start()
    const bytes = new Uint8Array([0, 255, 1, 254])
    await (
      await gw.call('/openai/v1/audio/transcriptions', {
        method: 'POST',
        body: bytes,
        headers: { 'content-type': 'multipart/form-data; boundary=x' },
      })
    ).text()
    expect(Buffer.compare(iu.seen[0]?.body ?? new Uint8Array(), bytes)).toBe(0)
  })

  test('an unknown path is 404, a GET on messages 405', async () => {
    const gw = start()
    expect((await gw.call('/anthropic/v1/models')).status).toBe(404)
    expect((await gw.call(MESSAGES)).status).toBe(405)
    expect(iu.seen).toHaveLength(0)
  })

  test('a path cannot climb out of its prefix', async () => {
    const gw = start()
    expect((await gw.call('/openai/v1/../../admin')).status).toBe(404)
    expect((await gw.call('/openai/v1/%2e%2e/%2e%2e/admin')).status).toBe(404)
    expect(iu.seen).toHaveLength(0)
  })
})

describe('door auth', () => {
  test('Bearer and x-api-key both work; the caller comes from the credential', async () => {
    const gw = start()
    await (await gw.call(MESSAGES, jsonBody(request()))).text()
    const bearerInit = jsonBody(request())
    await (
      await gw.call(MESSAGES, {
        ...bearerInit,
        headers: { ...bearerInit.headers, authorization: `Bearer ${HERMES_TOKEN}`, 'x-agw-caller': 'agw' },
      })
    ).text()
    await (await gw.call(MESSAGES, { ...jsonBody(request()), token: API_SECRET })).text()
    const records = gw.rows().records
    expect(records.map(({ row }) => row.lane_detail.caller)).toEqual(['oc', 'hermes', 'agw'])
    expect(records.map(({ row }) => row.lane)).toEqual(['other', 'hermes', 'agw_workflow'])
  })

  test.each([
    ['x-goog-api-key', { 'x-goog-api-key': DOOR_TOKEN }, '/gemini/v1beta/models/m:generateContent?alt=sse'],
    ['api-key', { 'api-key': DOOR_TOKEN }, '/openai/v1/chat/completions?alt=sse'],
    ['x-api-key', { 'x-api-key': DOOR_TOKEN }, '/openai/v1/chat/completions?alt=sse'],
    ['authorization', { authorization: `Bearer ${DOOR_TOKEN}` }, '/openai/v1/chat/completions?alt=sse'],
    ['the key parameter', {}, `/gemini/v1beta/models/m:generateContent?alt=sse&key=${DOOR_TOKEN}`],
    ['an encoded key parameter', {}, `/gemini/v1beta/models/m:generateContent?%6Bey=${DOOR_TOKEN}&alt=sse`],
  ])('a door token in %s authenticates and never reaches the upstream', async (_name, headers, path) => {
    const gw = start()
    const response = await fetch(`${gw.url}${path}`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json', ...headers },
    })
    expect(response.status).toBe(200)
    await response.text()
    const seen = iu.seen[0]
    expect(seen?.path).toEndWith('?alt=sse')
    expect(JSON.stringify([seen?.path, [...(seen?.headers ?? [])]])).not.toContain(DOOR_TOKEN)
    expect(seen?.headers.get('authorization')).toBe(`Bearer ${IU_KEY}`)
    expect(gw.rows().records[0]?.row.lane_detail.caller).toBe('oc')
  })

  test('carriers beside the one that authenticated are stripped too; other parameters keep their bytes', async () => {
    const gw = start()
    const init = jsonBody({})
    await (
      await gw.call('/openai/v1/x?key=other&mykey=1&q=a%20b', {
        ...init,
        headers: { ...init.headers, 'x-goog-api-key': 'other', 'api-key': 'other' },
      })
    ).text()
    expect(iu.seen[0]?.path).toBe('/prefix/openai/v1/x?mykey=1&q=a%20b')
    expect(iu.seen[0]?.headers.get('x-goog-api-key')).toBeNull()
    expect(iu.seen[0]?.headers.get('api-key')).toBeNull()
  })

  test('a bad token in a key parameter is 401', async () => {
    const gw = start()
    const response = await fetch(`${gw.url}/gemini/v1beta/models/m:generateContent?key=${'x'.repeat(40)}`, jsonBody({}))
    expect(response.status).toBe(401)
    expect(iu.seen).toHaveLength(0)
  })

  test('a bad token is 401 and nothing goes upstream', async () => {
    const gw = start()
    const response = await gw.call(MESSAGES, { ...jsonBody(request()), token: 'x'.repeat(40) })
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
    const missing = await fetch(`${gw.url}${MESSAGES}`, jsonBody(request()))
    expect(missing.status).toBe(401)
    expect(iu.seen).toHaveLength(0)
  })
})

describe('picking', () => {
  const session = (id: string, init: RequestInit): RequestInit => ({
    ...init,
    headers: { ...init.headers, 'x-agw-session': id },
  })

  test('a Claude-Code-shaped request goes to IU, even with a pool eligible', async () => {
    const gw = start({ registry: [pool('iu')] })
    const init = jsonBody(request())
    const response = await gw.call(MESSAGES, {
      ...init,
      headers: { ...init.headers, 'anthropic-beta': 'claude-code-20250219' },
    })
    await response.text()
    expect(response.headers.get('x-agw-pool')).toBe('iu-api')
    expect(iu.seen[0]?.path).toBe('/prefix/anthropic/v1/messages')
    expect(iu.seen[0]?.headers.get('authorization')).toBe(`Bearer ${IU_KEY}`)
    expect(anthropic.seen).toHaveLength(0)
    expect(gw.rows().picks[0]?.row).toMatchObject({ picked: 'iu-api', reason: 'claude-code' })
    expect(gw.rows().records[0]?.row).toMatchObject({ billing: 'api_key', api_key: 'personal', account: null })
    expect(gw.rows().records[0]?.row.lane_detail).toMatchObject({ pool: 'iu-api', fallback: 'claude-code' })
  })

  test('a session stays on its pool across calls, even against the soonest expiry', async () => {
    const day = new Date().getUTCDate()
    const dayOf = (offset: number) => ((day + offset - 1) % 28) + 1
    const gw = start({ registry: [pool('late', { cycleDay: dayOf(20) }), pool('soon', { cycleDay: dayOf(3) })] })
    const pickedFor = async (id: string) => {
      const response = await gw.call(MESSAGES, session(id, jsonBody(request())))
      await response.text()
      return response.headers.get('x-agw-pool')
    }
    expect(await pickedFor('s1')).toBe('soon')
    expect(await pickedFor('s1')).toBe('soon')
    gw.pools.served('oc', 's2', 'late')
    expect(await pickedFor('s2')).toBe('late')
    expect(gw.rows().picks.map(({ row }) => row.reason)).toEqual(['soonest-expiry', 'bound', 'bound'])
  })

  test('binding is written only after a 2xx, for the pool that served', async () => {
    const gw = start({ registry: [pool('iu')] })
    const served: unknown[] = []
    const original = gw.pools.served.bind(gw.pools)
    gw.pools.served = (caller, id, target) => {
      served.push([caller, id, target])
      original(caller, id, target)
    }
    anthropic.reply(() => Response.json({ type: 'error' }, { status: 500 }))
    await (await gw.call(MESSAGES, session('s1', jsonBody(request())))).text()
    expect(served).toEqual([])
    anthropic.reply(anthropicReply)
    await (await gw.call(MESSAGES, session('s1', jsonBody(request())))).text()
    expect(served).toEqual([['oc', 's1', 'iu']])
    const init = session('s1', jsonBody(request()))
    await (await gw.call(MESSAGES, { ...init, headers: { ...init.headers, 'x-app': 'cli' } })).text()
    expect(served).toEqual([
      ['oc', 's1', 'iu'],
      ['oc', 's1', null],
    ])
  })

  test('a credit pool gets its own key at the Anthropic path; the row is api_credit', async () => {
    const gw = start({ registry: [pool('iu')] })
    const response = await gw.call(MESSAGES, jsonBody(request()))
    await response.text()
    expect(response.headers.get('x-agw-pool')).toBe('iu')
    expect(anthropic.seen[0]?.path).toBe('/v1/messages')
    const row = gw.rows().records[0]?.row
    expect(row).toMatchObject({ billing: 'api_credit', account: 'iu', api_key: null, grain: 'message' })
    expect(row?.lane_detail.pool).toBe('iu')
    expect(row?.lane_detail.fallback).toBeNull()
  })

  test('a balance refusal drains the pool and the retry lands on IU; two picks, one row', async () => {
    anthropic.reply(refusalResponse)
    const gw = start({ registry: [pool('iu')] })
    const response = await gw.call(MESSAGES, session('s1', jsonBody(request())))
    expect(response.status).toBe(200)
    await response.text()
    expect(response.headers.get('x-agw-pool')).toBe('iu-api')
    expect(iu.seen).toHaveLength(1)
    expect(new TextDecoder().decode(iu.seen[0]?.body)).toBe(new TextDecoder().decode(anthropic.seen[0]?.body))
    expect(gw.pools.status()[0]?.drainedUntil).not.toBeNull()
    expect(gw.rows().picks.map(({ row }) => [row.picked, row.reason])).toEqual([
      ['iu', 'soonest-expiry'],
      ['iu-api', 'drained-retry'],
    ])
    expect(gw.rows().records).toHaveLength(1)
    expect(gw.rows().records[0]?.row.lane_detail).toMatchObject({ pool: 'iu-api', fallback: 'drained-retry' })
    // The next request does not touch the drained pool.
    await (await gw.call(MESSAGES, jsonBody(request()))).text()
    expect(anthropic.seen).toHaveLength(1)
  })

  test('a gzipped balance refusal is still recognised', async () => {
    anthropic.reply(
      () =>
        new Response(gzipSync(JSON.stringify(BALANCE_REFUSAL)), {
          status: 400,
          headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        }),
    )
    const gw = start({ registry: [pool('iu')] })
    const response = await gw.call(MESSAGES, jsonBody(request()))
    await response.text()
    expect(response.headers.get('x-agw-pool')).toBe('iu-api')
  })

  test('every refusing pool is drained and skipped until the pick is no pool', async () => {
    anthropic.reply(refusalResponse)
    const gw = start({ registry: [pool('a'), pool('b'), pool('c')] })
    const response = await gw.call(MESSAGES, jsonBody(request()))
    expect(response.status).toBe(200)
    await response.text()
    expect(response.headers.get('x-agw-pool')).toBe('iu-api')
    expect(anthropic.seen).toHaveLength(3)
    expect(iu.seen).toHaveLength(1)
    expect(gw.pools.status().every((status) => status.drainedUntil !== null)).toBe(true)
    expect(gw.rows().picks.map(({ row }) => row.picked)).toEqual(['a', 'b', 'c', 'iu-api'])
    expect(gw.rows().records).toHaveLength(1)
  })

  test('a retry stops on the first pool that serves', async () => {
    let calls = 0
    anthropic.reply(() => (++calls === 1 ? refusalResponse() : anthropicReply()))
    const gw = start({ registry: [pool('a'), pool('b')] })
    const response = await gw.call(MESSAGES, jsonBody(request()))
    await response.text()
    expect(response.headers.get('x-agw-pool')).toBe('b')
    expect(gw.pools.status().map((status) => status.drainedUntil !== null)).toEqual([true, false])
    expect(gw.rows().records[0]?.row.account).toBe('b')
  })

  test('with every pool refusing and x-agw-fallback: none, the end is the 402', async () => {
    anthropic.reply(refusalResponse)
    const gw = start({ registry: [pool('a'), pool('b')] })
    const init = jsonBody(request())
    const response = await gw.call(MESSAGES, { ...init, headers: { ...init.headers, 'x-agw-fallback': 'none' } })
    expect(response.status).toBe(402)
    expect(iu.seen).toHaveLength(0)
    expect(gw.rows().picks.map(({ row }) => row.picked)).toEqual(['a', 'b', 'refused'])
  })

  test('x-agw-fallback: none answers 402 with the marker', async () => {
    anthropic.reply(refusalResponse)
    const gw = start({ registry: [pool('iu')] })
    const init = jsonBody(request())
    const response = await gw.call(MESSAGES, { ...init, headers: { ...init.headers, 'x-agw-fallback': 'none' } })
    expect(response.status).toBe(402)
    expect(await response.json()).toEqual({
      type: 'error',
      error: { type: 'balance_error', message: `${BALANCE_MARKER}: no credit pool eligible` },
    })
    expect(iu.seen).toHaveLength(0)
    expect(gw.rows().picks.map(({ row }) => row.picked)).toEqual(['iu', 'refused'])
    expect(gw.rows().records).toHaveLength(0)
  })

  test('a plain 400 from a pool is forwarded and drains nothing', async () => {
    const body = '{"type":"error","error":{"type":"invalid_request_error","message":"nope"}}'
    anthropic.reply(() => new Response(body, { status: 400, headers: { 'content-type': 'application/json' } }))
    const gw = start({ registry: [pool('iu')] })
    const response = await gw.call(MESSAGES, jsonBody(request()))
    expect(await response.text()).toBe(body)
    expect(gw.pools.status()[0]?.drainedUntil).toBeNull()
    expect(iu.seen).toHaveLength(0)
  })

  test('count_tokens: the same pick, no row, no pick, no binding', async () => {
    anthropic.reply(() => Response.json({ input_tokens: 12 }))
    const gw = start({ registry: [pool('a'), pool('b')] })
    const served: unknown[] = []
    gw.pools.served = (...args) => void served.push(args)
    const response = await gw.call('/anthropic/v1/messages/count_tokens', session('s1', jsonBody(request())))
    expect(await response.json()).toEqual({ input_tokens: 12 })
    expect(response.headers.get('x-agw-pool')).toBe('a')
    expect(anthropic.seen[0]?.path).toBe('/v1/messages/count_tokens')
    expect(gw.rows().records).toHaveLength(0)
    expect(gw.rows().picks).toHaveLength(0)
    expect(served).toEqual([])
  })
})

describe('usage row', () => {
  const costOf = (usage: unknown, alias: string) => {
    const cost = costFromUsage('iu-anthropic', usage as never, claudeRate(alias))
    return cost.usd as number
  }

  test('a JSON response: tokens split, cost priced, attribution from the headers, meter charged', async () => {
    const gw = start({ registry: [pool('iu')] })
    const init = jsonBody(request())
    const response = await gw.call(MESSAGES, {
      ...init,
      headers: {
        ...init.headers,
        'x-agw-run-id': 'run-1',
        'x-agw-workflow': 'wf',
        'x-agw-step': 'st',
        'x-agw-purpose': 'review',
        'x-agw-session': 'sess',
      },
    })
    await response.text()
    const { records } = gw.rows()
    expect(records).toHaveLength(1)
    const row = records[0]?.row
    expect(response.headers.get('x-agw-request-id')).toBe(row?.source_id ?? '')
    expect(row?.source_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    expect(row).toMatchObject({
      source: 'gateway',
      model: haikuId,
      run_id: 'run-1',
      input_tokens: 1000,
      output_tokens: 50,
      cache_read_tokens: 2000,
      cache_write_5m_tokens: 100,
      cache_write_1h_tokens: 300,
      machine: 'test-machine',
      outcome: 'ok',
    })
    expect(row?.lane_detail).toMatchObject({
      caller: 'oc',
      session: 'sess',
      run_id: 'run-1',
      workflow: 'wf',
      step: 'st',
      purpose: 'review',
    })
    const expected = costOf(USAGE, 'haiku')
    expect(row?.cost_reported_usd).toBeCloseTo(expected, 12)
    expect(gw.pools.status()[0]?.meterUsd).toBeCloseTo(expected, 12)
  })

  test('a streamed response: message_start and message_delta merge', async () => {
    anthropic.reply(() =>
      sseResponse(
        sse([
          { type: 'message_start', message: { model: haikuId, usage: { ...USAGE, output_tokens: 1 } } },
          { type: 'content_block_delta', delta: { text: 'x' } },
          { type: 'message_delta', usage: { output_tokens: 50 } },
          { type: 'message_stop' },
        ]),
      ),
    )
    const gw = start({ registry: [pool('iu')] })
    await (await gw.call(MESSAGES, jsonBody(request({ stream: true })))).text()
    const row = gw.rows().records[0]?.row
    expect(row).toMatchObject({ input_tokens: 1000, output_tokens: 50, cache_write_1h_tokens: 300, outcome: 'ok' })
    expect(row?.cost_reported_usd).toBeCloseTo(costOf(USAGE, 'haiku'), 12)
  })

  test('a CRLF stream split across chunks parses the same', async () => {
    const text = sse([
      { type: 'message_start', message: { model: haikuId, usage: USAGE } },
      { type: 'message_delta', usage: { output_tokens: 9 } },
    ]).replaceAll('\n', '\r\n')
    const bytes = new TextEncoder().encode(text)
    anthropic.reply(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              for (let at = 0; at < bytes.length; at += 11) {
                controller.enqueue(bytes.slice(at, at + 11))
                await Bun.sleep(0)
              }
              controller.close()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    )
    const gw = start({ registry: [pool('iu')] })
    await (await gw.call(MESSAGES, jsonBody(request({ stream: true })))).text()
    expect(gw.rows().records[0]?.row).toMatchObject({ input_tokens: 1000, output_tokens: 9, outcome: 'ok' })
  })

  test('an error event after the 200 is an error row', async () => {
    anthropic.reply(() =>
      sseResponse(
        sse([
          { type: 'message_start', message: { model: haikuId, usage: USAGE } },
          { type: 'error', error: { type: 'overloaded_error', message: 'x' } },
        ]),
      ),
    )
    const gw = start({ registry: [pool('iu')] })
    await (await gw.call(MESSAGES, jsonBody(request({ stream: true })))).text()
    expect(gw.rows().records[0]?.row.outcome).toBe('error')
  })

  test('OpenAI chat: the final chunk carries usage; input and output lose their subsets', async () => {
    iu.reply(() =>
      sseResponse(
        `${sse([
          { model: 'gpt-x', choices: [], usage: null },
          {
            model: 'gpt-x',
            choices: [],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 40,
              prompt_tokens_details: { cached_tokens: 30 },
              completion_tokens_details: { reasoning_tokens: 10 },
            },
          },
        ])}data: [DONE]\n\n`,
      ),
    )
    const gw = start()
    await (await gw.call('/openai/v1/chat/completions', jsonBody({ model: 'gpt-x', stream: true }))).text()
    const row = gw.rows().records[0]?.row
    expect(row).toMatchObject({
      model: 'gpt-x',
      input_tokens: 70,
      cache_read_tokens: 30,
      output_tokens: 30,
      reasoning_tokens: 10,
      billing: 'api_key',
      cost_reported_usd: null,
    })
    expect(row?.lane_detail).toMatchObject({ pool: 'iu-api', fallback: 'passthrough' })
  })

  test('OpenAI Responses JSON, then Gemini, then a wire with no usage', async () => {
    iu.reply(() =>
      Response.json({
        model: 'gpt-y',
        usage: {
          input_tokens: 10,
          output_tokens: 8,
          input_tokens_details: { cached_tokens: 4 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    )
    const gw = start()
    await (await gw.call('/openai/v1/responses', jsonBody({ model: 'gpt-y' }))).text()
    iu.reply(() =>
      Response.json({
        modelVersion: 'gem-1',
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 5,
          cachedContentTokenCount: 6,
          thoughtsTokenCount: 2,
        },
      }),
    )
    await (await gw.call('/gemini/v1beta/models/gem-1:generateContent', jsonBody({}))).text()
    iu.reply(() => new Response('binary', { headers: { 'content-type': 'audio/mpeg' } }))
    await (await gw.call('/replicate/v1/models/o/n/predictions', jsonBody({}))).text()
    const rows = gw.rows().records.map(({ row }) => row)
    expect(rows[0]).toMatchObject({ input_tokens: 6, cache_read_tokens: 4, output_tokens: 5, reasoning_tokens: 3 })
    expect(rows[1]).toMatchObject({
      model: 'gem-1',
      input_tokens: 14,
      cache_read_tokens: 6,
      output_tokens: 5,
      reasoning_tokens: 2,
    })
    expect(rows[2]).toMatchObject({ model: 'o/n', input_tokens: 0, output_tokens: 0, cost_reported_usd: null })
    expect(rows[2]?.raw.usageReported).toBe(false)
  })

  test('a credit-pool response with no rate is charged at the top Claude rate, and says so', async () => {
    anthropic.reply(() => Response.json({ model: 'claude-unknown-9', usage: USAGE }))
    const gw = start({ registry: [pool('iu')] })
    await (await gw.call(MESSAGES, jsonBody(request()))).text()
    const row = gw.rows().records[0]?.row
    const estimate = costOf(USAGE, 'opus')
    expect(row?.lane_detail.costEstimated).toBe(true)
    expect(row?.cost_reported_usd).toBeCloseTo(estimate, 12)
    expect(gw.pools.status()[0]?.meterUsd).toBeCloseTo(estimate, 12)
  })

  test('the same unknown model on IU stays unpriced: IU is not the meter', async () => {
    iu.reply(() => Response.json({ model: 'claude-unknown-9', usage: USAGE }))
    const gw = start()
    await (await gw.call(MESSAGES, jsonBody(request()))).text()
    const row = gw.rows().records[0]?.row
    expect(row?.cost_reported_usd).toBeNull()
    expect(row?.lane_detail.costEstimated).toBeUndefined()
  })

  test('IU spend never reaches the credit pool named iu', async () => {
    const gw = start({ registry: [pool('iu', { enabled: true })] })
    const init = jsonBody(request())
    await (
      await gw.call(MESSAGES, { ...init, headers: { ...init.headers, 'user-agent': 'claude-cli/2.1 (external, cli)' } })
    ).text()
    expect(gw.rows().records[0]?.row.cost_reported_usd).toBeGreaterThan(0)
    expect(gw.ledger.spentSince('iu', new Date(0))).toBe(0)
    expect(gw.ledger.spentSince('iu-api', new Date(0))).toBeGreaterThan(0)
  })
})

describe('span', () => {
  test('one span per request, parented by traceparent, with the attributes', async () => {
    const exporter = new InMemorySpanExporter()
    const telemetry = createTelemetry({ env: {}, logger: silentLogger(), exporter, scheduledDelayMillis: 1 })
    const gw = start({ registry: [pool('iu')], telemetry })
    const init = jsonBody(request())
    const trace = '0af7651916cd43dd8448eb211c80319c'
    const response = await gw.call(MESSAGES, {
      ...init,
      headers: { ...init.headers, traceparent: `00-${trace}-b7ad6b7169203331-01`, 'x-agw-session': 'sess' },
    })
    await response.text()
    for (let i = 0; i < 100 && exporter.getFinishedSpans().length === 0; i++) await Bun.sleep(5)
    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    const span = spans[0]
    expect(span?.spanContext().traceId).toBe(trace)
    expect(span?.resource.attributes['service.name']).toBe('agw-gateway')
    expect(span?.attributes).toMatchObject({
      'gen_ai.system': 'anthropic',
      'gen_ai.request.model': haikuId,
      'gen_ai.response.model': haikuId,
      'gen_ai.usage.input_tokens': 1000,
      'gen_ai.usage.output_tokens': 50,
      'agw.gateway.caller': 'oc',
      'agw.gateway.session': 'sess',
      'agw.gateway.pool': 'iu',
      'agw.gateway.pick_reason': 'soonest-expiry',
      'agw.gateway.cache_read_tokens': 2000,
      'agw.gateway.cache_write_tokens': 400,
      'agw.gateway.status': 200,
    })
    expect(span?.attributes['agw.gateway.request_id']).toBe(response.headers.get('x-agw-request-id') ?? '')
    expect(span?.attributes['agw.cost.usd']).toBeGreaterThan(0)
    expect(span?.attributes['agw.gateway.ttft_ms']).toBeGreaterThanOrEqual(0)
  })
})

describe('health and shutdown', () => {
  test('/health needs no token and reports pools and the ledger', async () => {
    const gw = start({ registry: [pool('iu')] })
    await (await gw.call(MESSAGES, jsonBody(request()))).text()
    const health = (await (await fetch(`${gw.url}/health`)).json()) as { pools: unknown[] }
    expect(health).toMatchObject({
      status: 'ok',
      version: 'test',
      build: 'test-build',
      ledger: { unsynced: 2, quarantined: 0, flush: 'off' },
    })
    expect(health.pools).toHaveLength(1)
    expect(health.pools[0]).toMatchObject({ id: 'iu', eligible: true, reconciledAt: null, reconcileError: null })
  })

  test('shutdown lets a stream finish, then its row is in the ledger', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    anthropic.reply(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode(sse([{ type: 'message_start', message: message }])))
              await gate
              controller.enqueue(
                new TextEncoder().encode(sse([{ type: 'message_delta', usage: { output_tokens: 3 } }])),
              )
              controller.close()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    )
    const gw = start({ registry: [pool('iu')] })
    const response = await gw.call(MESSAGES, jsonBody(request({ stream: true })))
    const reader = response.body?.getReader()
    await reader?.read()
    const stats: unknown[] = []
    const stopping = gw.server.shutdown().then(() => stats.push('stopped'))
    await Bun.sleep(50)
    expect(stats).toEqual([])
    expect(await fetch(`${gw.url}/health`).catch(() => null)).toBeNull()
    release()
    while (!(await reader?.read())?.done);
    await stopping
    expect(stats).toEqual(['stopped'])
  })

  test('shutdown cuts what outlives the drain, and the cut stream is recorded', async () => {
    anthropic.reply(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(sse([{ type: 'message_start', message: message }])))
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    )
    const dir = tempDir()
    const path = join(dir.path, 'ledger.sqlite')
    const gw = start({ registry: [pool('iu')], drainMs: 50, ledgerPath: path })
    const response = await gw.call(MESSAGES, jsonBody(request({ stream: true })))
    await response.body?.getReader().read()
    await gw.close()
    gateway = undefined
    const reopened = new Ledger(path)
    expect(reopened.pending(10).records[0]?.row.raw.ended).toBe('aborted')
    reopened.close()
    dir.remove()
  })
})
