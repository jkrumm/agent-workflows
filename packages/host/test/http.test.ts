import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import crypto from 'node:crypto'
import { z } from 'zod'
import { createRegistry, defineCapability } from '@agent-workflows/capabilities'
import { defineWorkflow } from '@agent-workflows/runtime'
import { assertSecret, bearerMatches } from '../src/auth.ts'
import { createHost } from '../src/app.ts'
import { canonicalJson, contractSha } from '../src/canonical.ts'
import { preferWait } from '../src/operations.ts'
import { fingerprintWorkflows } from '../src/workflows/index.ts'
import { type Body, rejection, SECRET, startTestHost, type TestHost } from './support.ts'

let t: TestHost
beforeAll(async () => {
  t = await startTestHost({ prefix: 'http' })
})
afterAll(async () => {
  await t.close()
})

describe('auth', () => {
  test('missing and wrong bearer are 401 UNAUTHORIZED with the common error body', async () => {
    for (const auth of [null, 'wrong', `${SECRET}x`, SECRET.slice(0, -1)]) {
      const response = await t.call('/openapi.json', { auth })
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe('Bearer')
      expect(await response.json()).toEqual({
        defined: false,
        code: 'UNAUTHORIZED',
        status: 401,
        message: 'Missing or wrong bearer token',
      })
    }
    const basic = await t.host.fetch(
      new Request('http://x/openapi.json', { headers: { authorization: `Basic ${SECRET}` } }),
    )
    expect(basic.status).toBe(401)
  })

  test('the right bearer passes, on every route kind', async () => {
    expect((await t.call('/openapi.json')).status).toBe(200)
    expect((await t.call('/runs/none')).status).toBe(404) // past auth, into the handler
    expect((await t.call('/nope')).status).toBe(404)
  })

  test('auth runs before any handler: an unauthenticated request starts nothing', async () => {
    const before = (await t.pool.query(`select count(*)::int as n from "${t.schema}".runs`)).rows[0].n
    const response = await t.call('/workflows/echo/say', { body: { text: 'x' }, auth: 'wrong' })
    expect(response.status).toBe(401)
    expect((await t.pool.query(`select count(*)::int as n from "${t.schema}".runs`)).rows[0].n).toBe(before)
  })

  test('/health is the only unauthenticated route', async () => {
    expect((await t.call('/health', { auth: null })).status).toBe(200)
    expect((await t.call('/health', { auth: 'wrong' })).status).toBe(200)
    expect((await t.call('/health', { auth: null, method: 'POST', body: {} })).status).toBe(401)
  })

  test('the comparison is timingSafeEqual over two sha256 digests, on every outcome', () => {
    const spy = spyOn(crypto, 'timingSafeEqual')
    try {
      for (const header of [
        null,
        'Bearer nope',
        'Bearer a-much-longer-wrong-token-than-the-secret-itself-0000000000',
        `Bearer ${SECRET}`,
      ]) {
        spy.mockClear()
        bearerMatches(header, SECRET)
        expect(spy).toHaveBeenCalledTimes(1)
        const [a, b] = spy.mock.calls[0] as [Buffer, Buffer]
        expect([a.length, b.length]).toEqual([32, 32])
      }
    } finally {
      spy.mockRestore()
    }
    expect(bearerMatches(`bearer ${SECRET}`, SECRET)).toBe(true)
    expect(bearerMatches(`Bearer ${SECRET} extra`, SECRET)).toBe(false)
    expect(bearerMatches(SECRET, SECRET)).toBe(false)
  })

  test('start is refused without a secret or with a short one', () => {
    for (const secret of [undefined, '', 'short', 'x'.repeat(31)]) {
      expect(() => assertSecret(secret)).toThrow('AGW_API_SECRET')
      expect(() => createHost({ secret } as never)).toThrow('AGW_API_SECRET')
    }
    expect(() => assertSecret('x'.repeat(32))).not.toThrow()
  })
})

describe('health', () => {
  test('ok with the version when the runtime is open and Postgres answers', async () => {
    const response = await t.call('/health', { auth: null })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', version: '1.2.3' })
  })

  test('degraded when the runtime is closed', async () => {
    const closed = await startTestHost({ prefix: 'hclosed', isOpen: () => false })
    try {
      const response = await closed.call('/health', { auth: null })
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ status: 'degraded', reason: 'runtime is not open' })
    } finally {
      await closed.close()
    }
  })

  test('every route but /health is a 503 SERVICE_UNAVAILABLE (defined false) until the runtime is open', async () => {
    const closed = await startTestHost({ prefix: 'hclosed2', isOpen: () => false })
    try {
      const { status, body } = await closed.json(await closed.call('/openapi.json'))
      expect(status).toBe(503)
      expect(body).toEqual({
        defined: false,
        code: 'SERVICE_UNAVAILABLE',
        status: 503,
        message: 'The runtime is not open',
      })
      expect((await closed.call('/openapi.json', { auth: 'wrong' })).status).toBe(401) // auth first
    } finally {
      await closed.close()
    }
  })

  test('the probe is handed the health bound, so the store can end its own query', async () => {
    const seen: (number | undefined)[] = []
    const bounded = await startTestHost({
      prefix: 'hbound',
      healthTimeoutMs: 1234,
      wrapStore: (store) => ({
        get: (id) => store.get(id),
        ping: (timeoutMs) => {
          seen.push(timeoutMs)
          return store.ping(timeoutMs)
        },
      }),
    })
    try {
      expect((await bounded.call('/health', { auth: null })).status).toBe(200)
      expect(seen).toEqual([1234])
    } finally {
      await bounded.close()
    }
  })

  test('degraded when Postgres fails or hangs', async () => {
    const failing = await startTestHost({
      prefix: 'hfail',
      ping: () => Promise.reject(new Error('connection refused')),
    })
    const hanging = await startTestHost({ prefix: 'hhang', ping: () => new Promise(() => {}), healthTimeoutMs: 50 })
    try {
      for (const host of [failing, hanging]) {
        const response = await host.call('/health', { auth: null })
        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({ status: 'degraded', reason: 'postgres does not answer' })
      }
    } finally {
      await failing.close()
      await hanging.close()
    }
  })
})

describe('openapi document and contract sha', () => {
  test('canonical JSON sorts keys recursively and has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: null, y: 'é' }], c: true }, u: undefined })).toBe(
      '{"a":{"c":true,"d":[3,{"y":"é","z":null}]},"b":1}',
    )
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
  })

  test('every operation carries x-cli with a kind; capabilities, workflows and run ops are all there', async () => {
    const doc = (await (await t.call('/openapi.json')).json()) as Body
    expect(doc.openapi).toMatch(/^3\.1/)
    const operations = Object.entries(doc.paths as Record<string, Body>).flatMap(([path, item]) =>
      Object.entries(item).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, op })),
    )
    const byKey = Object.fromEntries(operations.map((o) => [o.key, o.op['x-cli']]))
    for (const { op } of operations) {
      expect(['capability', 'workflow', 'run']).toContain(op['x-cli'].kind)
      expect(op['x-cli'].command.length).toBeGreaterThan(0)
    }
    expect(byKey['POST /llm/title']).toMatchObject({ kind: 'capability', command: ['llm', 'title'] })
    expect(byKey['POST /workflows/smoke/ping']).toEqual({
      command: ['smoke', 'ping'],
      positional: ['text'],
      mutating: false,
      defaultFormat: 'json',
      kind: 'workflow',
      resume: { command: ['run', 'wait'], positional: ['runId'] },
    })
    expect(byKey['POST /workflows/boom/fail']).toMatchObject({ mutating: true, kind: 'workflow' })
    expect(byKey['GET /runs/{runId}']).toEqual({
      command: ['run', 'status'],
      positional: ['runId'],
      mutating: false,
      defaultFormat: 'json',
      kind: 'run',
    })
    expect(byKey['POST /runs/{runId}/wait']).toMatchObject({ command: ['run', 'wait'], kind: 'run', mutating: false })
    expect(byKey['POST /runs/{runId}/cancel']).toMatchObject({
      command: ['run', 'cancel'],
      kind: 'run',
      mutating: true,
    })
    expect(doc.paths['/workflows/smoke/ping'].post.responses['202']).toBeDefined()
    const headers = doc.paths['/workflows/smoke/ping'].post.parameters.map((p: { name: string }) => p.name)
    expect(headers).toEqual(['Prefer', 'Idempotency-Key', 'x-agw-purpose'])
  })

  test('the path and header parameters of the run ops are all documented', async () => {
    const doc = (await (await t.call('/openapi.json')).json()) as Body
    const names = (path: string, method: string) =>
      (doc.paths[path][method].parameters as { name: string }[]).map((p) => p.name).sort()
    expect(names('/runs/{runId}', 'get')).toEqual(['runId'])
    expect(names('/runs/{runId}/wait', 'post')).toEqual(['Prefer', 'runId'])
    expect(names('/runs/{runId}/cancel', 'post')).toEqual(['Prefer', 'runId'])
  })

  test('info.x-contract-sha is the sha256 of the canonical document without that field', async () => {
    const doc = (await (await t.call('/openapi.json')).json()) as Body
    const sha = doc.info['x-contract-sha']
    expect(sha).toMatch(/^[0-9a-f]{64}$/)
    const { 'x-contract-sha': _, ...info } = doc.info
    const hash = new Bun.CryptoHasher('sha256').update(canonicalJson({ ...doc, info })).digest('hex')
    expect(sha).toBe(hash)
    expect(contractSha(doc)).toBe(sha)
  })

  test('the sha is stable across two builds and changes when an operation changes', async () => {
    const again = await startTestHost({ prefix: 'doc2' })
    const changed = await startTestHost({
      prefix: 'doc3',
      extra: [
        {
          workflow: defineWorkflow({
            id: 'extra.op',
            version: 'v1',
            input: z.object({ a: z.string().optional() }),
            output: z.object({}),
            run: async () => ({}),
          }),
        },
      ],
    })
    try {
      const sha = async (host: TestHost) =>
        ((await host.host.openapi()).info as Record<string, string>)['x-contract-sha']
      expect(await sha(again)).toBe(await sha(t))
      expect(await sha(changed)).not.toBe(await sha(t))
    } finally {
      await again.close()
      await changed.close()
    }
  })

  test('a differing x-agw-contract is 412 CONTRACT_MISMATCH with both shas; the right one and none pass', async () => {
    const sha = ((await t.host.openapi()).info as Record<string, string>)['x-contract-sha'] as string
    const mismatch = await t.json(await t.call('/runs/none', { headers: { 'x-agw-contract': 'f'.repeat(64) } }))
    expect(mismatch.status).toBe(412)
    expect(mismatch.body).toMatchObject({
      defined: false,
      code: 'CONTRACT_MISMATCH',
      status: 412,
      data: { server: sha, client: 'f'.repeat(64) },
    })
    expect((await t.call('/runs/none', { headers: { 'x-agw-contract': sha } })).status).toBe(404)
    expect((await t.call('/runs/none')).status).toBe(404)
    // the check sits behind auth, and the document itself is always fetchable
    expect((await t.call('/runs/none', { auth: 'wrong', headers: { 'x-agw-contract': 'bad' } })).status).toBe(401)
    expect((await t.call('/openapi.json', { headers: { 'x-agw-contract': 'bad' } })).status).toBe(200)
  })
})

describe('command collisions throw at creation', () => {
  test('a capability id under the host-reserved router keys is refused', () => {
    for (const key of ['workflows', 'runs']) {
      const registry = { capabilities: [], router: { [key]: {} }, requestContext: {} }
      const attempt = () =>
        createHost({
          runtime: t.runtime,
          registry,
          workflows: [],
          capabilityWorkflows: new Map(),
          secret: SECRET,
          version: 'x',
        })
      expect(attempt).toThrow(`"${key}."`)
    }
  })

  const op = (id: string) => ({
    workflow: defineWorkflow({
      id,
      version: 'v1',
      input: z.object({}),
      output: z.object({}),
      run: async () => ({}),
    }),
  })

  test.each([
    ['a workflow on a capability command', 'llm.title'],
    ['a workflow on a run op command', 'run.wait'],
    ['a workflow below a capability command', 'decide.more'],
    ['a workflow that is a prefix of a run op', 'run'],
  ])('%s', async (_name, id) => {
    expect(await rejection(startTestHost({ prefix: 'coll', extra: [op(id)] }))).toMatch(/command collision/)
  })

  test('a bad workflow id or non-object input is refused', async () => {
    expect(await rejection(startTestHost({ prefix: 'bad1', extra: [op('Bad.Id')] }))).toContain('dotted lowercase')
    const notObject = defineWorkflow({
      id: 'str.in',
      version: 'v1',
      input: z.string(),
      output: z.object({}),
      run: async () => ({}),
    })
    expect(await rejection(startTestHost({ prefix: 'bad2', extra: [{ workflow: notObject }] }))).toContain('z.object')
  })
})

describe('Prefer: wait', () => {
  const header = (value?: string) => new Headers(value ? { prefer: value } : {})
  test('absent is 0, numbers pass, the ceiling is 240, junk is a 400', () => {
    expect(preferWait(header())).toBe(0)
    expect(preferWait(header(), 10)).toBe(10)
    expect(preferWait(header('wait=0'), 10)).toBe(0)
    expect(preferWait(header('return=minimal'), 10)).toBe(10)
    expect(preferWait(header('wait=30'))).toBe(30)
    expect(preferWait(header('respond-async, wait=2.5'))).toBe(2.5)
    expect(preferWait(header('wait="7"'))).toBe(7)
    expect(preferWait(header('wait=1000'))).toBe(240)
    expect(preferWait(header('return=minimal'))).toBe(0)
    expect(() => preferWait(header('wait=soon'))).toThrow('Prefer')
    expect(() => preferWait(header('wait=-1'))).toThrow('Prefer')
  })
})

describe('document build failure', () => {
  test('a failing build answers with the standard error body and is retried, not cached', async () => {
    const real = (t.registry.router as Record<string, Record<string, object>>).llm?.title as object
    let failures = 0 // armed after creation: the handler walks the router once while it is built
    const flaky = createHost({
      runtime: t.runtime,
      registry: {
        capabilities: [],
        requestContext: {},
        router: {
          llm: {
            get title() {
              if (failures-- > 0) throw new Error('transient generator failure')
              return real
            },
          },
        } as never,
      },
      workflows: [],
      capabilityWorkflows: new Map(),
      secret: SECRET,
      version: 'x',
      logger: { warn: () => {}, error: () => {} },
    })
    failures = 1
    const request = () =>
      flaky.fetch(new Request('http://127.0.0.1:7791/openapi.json', { headers: { authorization: `Bearer ${SECRET}` } }))
    const first = await request()
    expect(first.status).toBe(500)
    expect(await first.json()).toEqual({
      defined: false,
      code: 'INTERNAL_SERVER_ERROR',
      status: 500,
      message: 'Internal server error',
    })
    expect((await request()).status).toBe(200)
  })
})

describe('request bodies', () => {
  const post = (body: string | undefined, headers: Record<string, string> = {}) =>
    t.host.fetch(
      new Request('http://127.0.0.1:7791/workflows/echo/say', {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, prefer: 'wait=10', ...headers },
        body,
      }),
    )

  test('a JSON body sent without a content type runs with that body, not the defaults', async () => {
    const response = await post('{"text":"raw"}')
    expect(response.status).toBe(200)
    expect(((await response.json()) as Body).output).toEqual({ text: 'raw' })
  })

  test('a body that is not valid for the input is a 400 whatever the content type says', async () => {
    expect((await post('{"text":7}')).status).toBe(400)
    expect((await post('not json')).status).toBe(400)
    expect((await post('{"text":7}', { 'content-type': 'application/json' })).status).toBe(400)
  })

  test('no body, or an empty one, runs the defaults', async () => {
    for (const response of [
      await post(undefined),
      await post('', { 'content-type': 'application/json' }),
      await post('  '),
    ]) {
      expect(response.status).toBe(200)
      expect(((await response.json()) as Body).output).toEqual({ text: 'hello' })
    }
  })

  test('the client abort signal survives the rebuilt request', async () => {
    const started = await t.json(await t.call('/workflows/hold/open', { body: {}, headers: { prefer: 'wait=0.1' } }))
    const abort = new AbortController()
    const waiting = t.host.fetch(
      new Request('http://127.0.0.1:7791/workflows/hold/open', {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, prefer: 'wait=200', 'idempotency-key': 'abort-key' },
        body: '{}',
        signal: abort.signal,
      }),
    )
    await Bun.sleep(150)
    abort.abort()
    const outcome = await Promise.race([
      waiting.then(
        () => 'returned',
        () => 'returned',
      ),
      Bun.sleep(3000).then(() => 'hung'),
    ])
    expect(outcome).toBe('returned')
    await t.call(`/runs/${started.body.runId}/cancel`, { method: 'POST' })
    const key = await t.pool.query(`select id from "${t.schema}".runs where idempotency_key = 'abort-key'`)
    if (key.rows[0]) await t.call(`/runs/${key.rows[0].id}/cancel`, { method: 'POST' })
  })
})

describe('secret hygiene and reserved flags', () => {
  test('a secret with any whitespace is refused', () => {
    for (const secret of [`${'x'.repeat(40)}\n`, `${'x'.repeat(20)} ${'y'.repeat(20)}`, `\t${'x'.repeat(40)}`]) {
      expect(() => assertSecret(secret)).toThrow('whitespace')
    }
  })

  const input = (name: string) => z.object({ [name]: z.string().optional() })
  test.each(['format', 'commit', 'idempotencyKey', 'idempotency-key', 'help'])(
    'a workflow input property named %s is refused at start',
    async (name) => {
      const entry = {
        workflow: defineWorkflow({
          id: 'flag.test',
          version: 'v1',
          input: input(name),
          output: z.object({}),
          run: async () => ({}),
        }),
      }
      expect(await rejection(startTestHost({ prefix: 'flag', extra: [entry] }))).toContain(`"${name}"`)
    },
  )

  test('a capability input property named like a CLI flag is refused at start', () => {
    const capability = defineCapability({
      id: 'x.y',
      summary: 'x',
      input: z.object({ commit: z.boolean().optional() }),
      output: z.object({}),
      handler: () => ({}),
    })
    const registry = createRegistry([capability])
    expect(() =>
      createHost({
        runtime: t.runtime,
        registry,
        workflows: [],
        capabilityWorkflows: new Map(),
        secret: SECRET,
        version: 'x',
      }),
    ).toThrow('capability x.y: input property "commit"')
  })

  test('llm.summarize takes `style`, not `format`', async () => {
    const doc = (await t.host.openapi()) as Body
    const schema = doc.paths['/llm/summarize'].post.requestBody.content['application/json'].schema
    expect(Object.keys(schema.properties)).toContain('style')
    expect(Object.keys(schema.properties)).not.toContain('format')
  })
})

describe('fingerprint map', () => {
  test('only workflows with agents appear, with their routes', () => {
    const wf = (id: string) =>
      defineWorkflow({ id, version: 'v1', input: z.object({}), output: z.object({}), run: async () => ({}) })
    const agents = [{ agent: 'brain', route: 'cheap.classify' as const }]
    expect(
      fingerprintWorkflows([
        { workflow: wf('a.b') },
        { workflow: wf('c.d'), agents },
        { workflow: wf('e.f'), agents: [] },
      ]),
    ).toEqual({ 'c.d': agents })
  })
})
