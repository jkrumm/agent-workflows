import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createCapabilities } from './capabilities/index.ts'
import { createTitle } from './capabilities/title.ts'
import type { Usage } from './context.ts'
import { CapabilityCallError, fail } from './errors.ts'
import { defineCapability } from './procedure.ts'
import { createRegistry } from './registry.ts'
import { fakeTransports } from './testing/index.ts'

const usage = { input: 12, output: 4, cacheRead: 0, reasoning: 0 }

function build(script: Parameters<typeof fakeTransports>[0]) {
  const transports = fakeTransports(script)
  const seen: { capability: string; usage: Usage }[] = []
  const registry = createRegistry(createCapabilities({ transports, env: {} }), {
    onUsage: (capability, u) => seen.push({ capability, usage: u }),
  })
  return { registry, transports, seen }
}

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

const errorJson = (e: unknown) => {
  expect(e).toBeInstanceOf(CapabilityCallError)
  return (e as CapabilityCallError).toJSON()
}

describe('one definition, two doors', () => {
  const a = build({ openai: [{ text: 'A short summary.', tokens: usage }] })
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: a.registry.fetch })
  const base = `http://127.0.0.1:${server.port}`
  afterAll(() => void server.stop(true))

  test('import call and HTTP call return the same result, defaults applied by both', async () => {
    const viaImport = await a.registry.call('llm.summarize', { text: 'Some long text.' })
    const viaHttp = await post(base, '/llm/summarize', { text: 'Some long text.' })
    expect(viaHttp.status).toBe(200)
    expect(viaHttp.body).toEqual(viaImport)
    expect(viaImport).toEqual({ summary: 'A short summary.' })
    // defaults (maxWords 100, paragraph) reached the handler on both doors
    const prompts = a.transports.chatCalls.map((c) => c.request.prompt)
    expect(prompts[0]).toBe(prompts[1])
    expect(prompts[0]).toContain('at most 100 words')
  })

  test('an unknown input key is a 400 on both doors, never silently dropped', async () => {
    const bad = { text: 'x', format: 'bullets' } // `format` was renamed `style`
    const viaImport = await a.registry.call('llm.summarize', bad as never).catch(errorJson)
    const viaHttp = await post(base, '/llm/summarize', bad)
    expect(viaHttp.status).toBe(400)
    expect(viaHttp.body).toEqual(viaImport)
    expect(viaImport).toMatchObject({ code: 'BAD_REQUEST', status: 400, defined: false })
  })

  test('invalid input fails identically', async () => {
    const bad = { text: '', maxWords: 3 }
    const viaImport = await a.registry.call('llm.summarize', bad).catch(errorJson)
    const viaHttp = await post(base, '/llm/summarize', bad)
    expect(viaHttp.status).toBe(400)
    expect(viaHttp.body).toEqual(viaImport)
    expect(viaImport).toMatchObject({ code: 'BAD_REQUEST', status: 400, defined: false })
  })

  test('a typed handler error fails identically, defined, with its data', async () => {
    const b = build({ openai: [fail('UPSTREAM_ERROR', 'iu-openai request failed (503): down', { status: 503 })] })
    const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: b.registry.fetch })
    try {
      const viaImport = await b.registry.call('llm.title', { text: 'x' }).catch(errorJson)
      const viaHttp = await post(`http://127.0.0.1:${s.port}`, '/llm/title', { text: 'x' })
      expect(viaHttp.status).toBe(502)
      expect(viaHttp.body).toEqual(viaImport)
      expect(viaImport).toEqual({
        defined: true,
        code: 'UPSTREAM_ERROR',
        status: 502,
        message: 'iu-openai request failed (503): down',
        data: { status: 503 },
      })
    } finally {
      void s.stop(true)
    }
  })

  test('an untyped throw is an opaque INTERNAL_SERVER_ERROR on both doors', async () => {
    const b = build({ openai: [new Error('secret detail')] })
    const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: b.registry.fetch })
    try {
      const viaImport = await b.registry.call('llm.title', { text: 'x' }).catch(errorJson)
      const viaHttp = await post(`http://127.0.0.1:${s.port}`, '/llm/title', { text: 'x' })
      expect(viaHttp.status).toBe(500)
      expect(viaHttp.body).toEqual(viaImport)
      expect(JSON.stringify(viaImport)).not.toContain('secret detail')
    } finally {
      void s.stop(true)
    }
  })

  test('the same model failure after the re-ask is INVALID_OUTPUT on both doors', async () => {
    const b = build({ openai: [{ text: 'not json' }] })
    const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: b.registry.fetch })
    const input = { text: 'x', labels: { a: 'first', b: 'second' } }
    try {
      const viaImport = await b.registry.call('llm.classify', input).catch(errorJson)
      const viaHttp = await post(`http://127.0.0.1:${s.port}`, '/llm/classify', input)
      expect(viaHttp.status).toBe(502)
      expect(viaHttp.body).toEqual(viaImport)
      expect(viaImport).toMatchObject({ code: 'INVALID_OUTPUT', data: { attempts: 2 } })
    } finally {
      void s.stop(true)
    }
  })

  test('usage reaches the registry sink from both doors, tagged with the capability', async () => {
    const b = build({ openai: [{ text: 'T', tokens: usage }] })
    const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: b.registry.fetch })
    try {
      const own: Usage[] = []
      await b.registry.call('llm.title', { text: 'x' }, { addUsage: (u) => own.push(u) })
      await post(`http://127.0.0.1:${s.port}`, '/llm/title', { text: 'x' })
      expect(own).toHaveLength(1)
      expect(b.seen.map((x) => x.capability)).toEqual(['llm.title', 'llm.title'])
      expect(b.seen[1]?.usage.tokens).toEqual(usage)
    } finally {
      void s.stop(true)
    }
  })

  test('fetch answers with the typed error body for a request the router cannot serve', async () => {
    const res = await a.registry.fetch(new Request(`${base}/nowhere`))
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' })
  })

  test('a capability can be called on its own, through the same pipeline', async () => {
    const title = createTitle({ transports: fakeTransports({ openai: [{ text: '"A Title."' }] }), env: {} })
    expect(await title.call({ text: 'x' })).toEqual({ title: 'A Title' })
    expect(await title.call({ text: '' }).catch(errorJson)).toMatchObject({ code: 'BAD_REQUEST' })
  })

  test('an aborted signal is CANCELLED', async () => {
    const controller = new AbortController()
    const echo = defineCapability({
      id: 'test.wait',
      summary: 'waits for its signal',
      input: z.object({}),
      output: z.object({}),
      handler: (_, ctx) =>
        new Promise((_resolve, reject) =>
          ctx.signal.addEventListener('abort', () => reject(fail('CANCELLED', 'cancelled'))),
        ),
    })
    const pending = echo.call({}, { signal: controller.signal }).catch(errorJson)
    await Bun.sleep(10)
    controller.abort()
    expect(await pending).toMatchObject({ code: 'CANCELLED', status: 499, defined: true })
  })
})

describe('OpenAPI', () => {
  const { registry } = build({})
  let doc: Awaited<ReturnType<typeof registry.openapi>>
  beforeAll(async () => {
    doc = await registry.openapi()
  })

  test('has every capability as one operation, each with x-cli', () => {
    const operations = Object.entries(doc.paths as Record<string, Record<string, Record<string, unknown>>>).flatMap(
      ([path, item]) => Object.entries(item).map(([method, op]) => ({ path, method, op })),
    )
    expect(operations.map((o) => `${o.method} ${o.path}`).sort()).toEqual(
      [
        'post /brain/read',
        'post /brain/search',
        'post /decide',
        'post /hdx/guide',
        'post /hdx/link',
        'post /hdx/query',
        'post /hdx/rest',
        'post /hdx/tools',
        'post /hdx/write',
        'post /image/cutout',
        'post /image/enhance',
        'post /image/generate',
        'post /image/upscale',
        'post /image/vectorize',
        'post /llm/classify',
        'post /llm/summarize',
        'post /llm/title',
        'post /prose/critique',
        'post /review/adversary',
        'post /review/route',
        'post /triage',
        'post /web/docs',
        'post /web/fetch',
        'post /web/package',
        'post /web/read',
        'post /web/search',
        'post /web/youtube',
      ].sort(),
    )
    for (const { op } of operations) {
      const cli = op['x-cli'] as { command: string[]; positional: string[]; mutating: boolean; defaultFormat: string }
      expect(cli.command.length).toBeGreaterThan(0)
      expect(Array.isArray(cli.positional)).toBe(true)
      expect(typeof cli.mutating).toBe('boolean')
      expect(['plain', 'json']).toContain(cli.defaultFormat)
      expect((cli as { kind?: string }).kind).toBe('capability')
    }
    const byId = Object.fromEntries(operations.map((o) => [o.op.operationId as string, o.op['x-cli']]))
    expect(byId.llmSummarize).toEqual({
      command: ['llm', 'summarize'],
      positional: ['text'],
      mutating: false,
      defaultFormat: 'plain',
      kind: 'capability',
      stdin: 'text',
      plainField: 'summary',
    })
    expect(byId.decide).toMatchObject({ command: ['decide'], positional: [], stdin: 'state', defaultFormat: 'json' })
  })

  test('every capability id is an operation id, and the typed error codes are documented', () => {
    const ids = Object.values(doc.paths as Record<string, Record<string, { operationId: string }>>).flatMap((item) =>
      Object.values(item).map((op) => op.operationId),
    )
    expect(ids.sort()).toEqual([
      'brainRead',
      'brainSearch',
      'decide',
      'hdxGuide',
      'hdxLink',
      'hdxQuery',
      'hdxRest',
      'hdxTools',
      'hdxWrite',
      'imageCutout',
      'imageEnhance',
      'imageGenerate',
      'imageUpscale',
      'imageVectorize',
      'llmClassify',
      'llmSummarize',
      'llmTitle',
      'proseCritique',
      'reviewAdversary',
      'reviewRoute',
      'triage',
      'webDocs',
      'webFetch',
      'webPackage',
      'webRead',
      'webSearch',
      'webYoutube',
    ])
    const json = JSON.stringify(doc)
    for (const code of ['NOT_CONFIGURED', 'UPSTREAM_ERROR', 'INVALID_OUTPUT', 'OUTPUT_TRUNCATED', 'CANCELLED']) {
      expect(json).toContain(code)
    }
  })

  test('defaults are not required in the input schema', () => {
    const op = (doc.paths as Record<string, Record<string, unknown>>)['/llm/summarize']?.post as {
      requestBody: { content: { 'application/json': { schema: { required: string[] } } } }
    }
    expect(op.requestBody.content['application/json'].schema.required).toEqual(['text'])
  })
})

describe('definition rules', () => {
  const noop = { summary: 's', input: z.object({ a: z.string() }), output: z.object({}), handler: () => ({}) }

  test('ids are dotted lowercase', () => {
    expect(() => defineCapability({ ...noop, id: 'LLM.Summarize' })).toThrow(/dotted lowercase/)
  })

  test('cli names must be input properties', () => {
    expect(() => defineCapability({ ...noop, id: 'a.b', cli: { positional: ['nope'] } })).toThrow(/not a property/)
    expect(() => defineCapability({ ...noop, id: 'a.b', cli: { stdin: 'nope' } })).toThrow(/not a property/)
  })

  test('duplicate ids, taken routes and nested ids are refused', () => {
    const a = defineCapability({ ...noop, id: 'a.b' })
    expect(() => createRegistry([a, a])).toThrow(/registered twice/)
    const b = defineCapability({ ...noop, id: 'a.c', route: { path: '/a/b' } })
    expect(() => createRegistry([a, b])).toThrow(/is taken/)
    const parent = defineCapability({ ...noop, id: 'a' })
    expect(() => createRegistry([parent, a])).toThrow(/nests under/)
    expect(() => createRegistry([a, parent])).toThrow(/collides/)
  })

  test('an unknown id fails with the known ones listed', () => {
    const registry = createRegistry([defineCapability({ ...noop, id: 'a.b' })])
    expect(() => registry.get('x' as never)).toThrow(/known: a\.b/)
  })
})
