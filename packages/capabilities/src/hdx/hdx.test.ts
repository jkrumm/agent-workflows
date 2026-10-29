import { afterEach, describe, expect, test } from 'bun:test'
import type { Usage } from '../context.ts'
import { CapabilityCallError } from '../errors.ts'
import { createRegistry } from '../registry.ts'
import { MUTATING_TOOLS, READ_ONLY_TOOLS } from './allowlist.ts'
import { parseRpcMessage, restPathStaysUnder } from './client.ts'
import { createHdxCapabilities, type HdxDeps } from './index.ts'

const KEY = 'test-hdx-key'
const sse = (message: unknown) => `event: message\ndata: ${JSON.stringify(message)}\n\n`

const TOOL_LIST = [...READ_ONLY_TOOLS, ...MUTATING_TOOLS].map((name) => ({
  name,
  description: `Does ${name}. More detail follows here.`,
  inputSchema: { type: 'object', properties: { sourceId: { type: 'string' } } },
  annotations: { readOnlyHint: (READ_ONLY_TOOLS as readonly string[]).includes(name) },
}))

interface Seen {
  method: string
  path: string
  auth: string | null
  body: unknown
}

/** A fake HyperDX: the MCP endpoint answers SSE like ClickStack does; REST v2 answers JSON. `override` takes a request first. */
function fakeHyperdx(override?: (seen: Seen, n: number) => Response | undefined) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const text = await req.text()
      const body = text ? JSON.parse(text) : undefined
      const entry = {
        method: req.method,
        path: url.pathname + url.search,
        auth: req.headers.get('authorization'),
        body,
      }
      seen.push(entry)
      const custom = override?.(entry, seen.length)
      if (custom) return custom
      if (entry.auth !== `Bearer ${KEY}`) return new Response('unauthorized', { status: 401 })
      if (url.pathname === '/api/mcp') {
        const { id, method, params } = body
        const ok = (result: unknown) =>
          new Response(`: ping\n\n${sse({ jsonrpc: '2.0', id, result })}`, {
            headers: { 'content-type': 'text/event-stream' },
          })
        if (method === 'tools/list') return ok({ tools: TOOL_LIST })
        if (method === 'initialize') return ok({ instructions: 'Pick the narrowest tool.' })
        if (method === 'prompts/get')
          return params.name === 'query_guide'
            ? ok({ messages: [{ role: 'user', content: { type: 'text', text: 'Use mapValue syntax.' } }] })
            : new Response(sse({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown prompt' } }), {
                headers: { 'content-type': 'text/event-stream' },
              })
        if (method === 'tools/call') {
          if (params.arguments?.sourceId === 'missing')
            return ok({ isError: true, content: [{ type: 'text', text: 'source not found' }] })
          return ok({
            content: [{ type: 'text', text: JSON.stringify({ tool: params.name, args: params.arguments }) }],
          })
        }
      }
      if (url.pathname.startsWith('/api/api/v2/')) {
        if (url.pathname.endsWith('/gone')) return Response.json({ message: 'not found' }, { status: 404 })
        return Response.json({ method: req.method, path: url.pathname.slice('/api/api/v2'.length), body })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return { base: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}

const servers: { stop: () => void }[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop()
})
function setup(
  options: { override?: Parameters<typeof fakeHyperdx>[0]; deps?: HdxDeps; env?: Record<string, string> } = {},
) {
  const hdx = fakeHyperdx(options.override)
  servers.push(hdx)
  const caps = createHdxCapabilities({
    retry: { backoffMs: 0 },
    readLocalEnvFile: () => undefined,
    env: { HYPERDX_LOCAL_URL: hdx.base, HYPERDX_LOCAL_ACCESS_KEY: KEY, ...options.env },
    ...options.deps,
  })
  const by = Object.fromEntries(caps.map((c) => [c.id, c])) as {
    'hdx.tools': (typeof caps)[0]
    'hdx.guide': (typeof caps)[1]
    'hdx.query': (typeof caps)[2]
    'hdx.rest': (typeof caps)[3]
    'hdx.write': (typeof caps)[4]
    'hdx.link': (typeof caps)[5]
  }
  const usage: Usage[] = []
  return { hdx, caps, by, usage, opts: { addUsage: (u: Usage) => usage.push(u) } }
}

const errorOf = async (promise: Promise<unknown>): Promise<CapabilityCallError> => {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityCallError)
    return error as CapabilityCallError
  }
  throw new Error('expected a failure')
}

describe('hdx.tools', () => {
  test('lists names, first sentences and the read-only flag', async () => {
    const { by, hdx, opts } = setup()
    const out = await by['hdx.tools'].call({ env: 'local' }, opts)
    expect(out.tools).toHaveLength(TOOL_LIST.length)
    expect(out.tools.find((t) => t.name === 'clickstack_sql')).toEqual({
      name: 'clickstack_sql',
      summary: 'Does clickstack_sql.',
      readOnly: true,
      readOnlyHint: true,
    })
    expect(out.tools.find((t) => t.name === 'clickstack_save_dashboard')?.readOnly).toBe(false)
    expect(hdx.seen[0]).toMatchObject({ method: 'POST', path: '/api/mcp', auth: `Bearer ${KEY}` })
    expect(hdx.seen[0]!.body).toMatchObject({ jsonrpc: '2.0', method: 'tools/list' })
  })

  test('a name gives the full description and input schema', async () => {
    const { by, opts } = setup()
    const out = await by['hdx.tools'].call({ env: 'local', name: 'clickstack_table' }, opts)
    expect(out.tools).toHaveLength(1)
    expect(out.tools[0]!.description).toContain('More detail follows here.')
    expect(out.tools[0]!.inputSchema).toMatchObject({ type: 'object' })
  })
})

describe('hdx.guide', () => {
  test('instructions from initialize, a prompt by name, an unknown prompt as a JSON-RPC error', async () => {
    const { by, hdx, opts } = setup()
    expect((await by['hdx.guide'].call({ env: 'local' }, opts)).text).toBe('Pick the narrowest tool.')
    expect(hdx.seen[0]!.body).toMatchObject({ method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    expect((await by['hdx.guide'].call({ env: 'local', prompt: 'query_guide' }, opts)).text).toBe(
      'Use mapValue syntax.',
    )
    const error = await errorOf(by['hdx.guide'].call({ env: 'local', prompt: 'nope' }, opts))
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR' })
    expect(error.message).toContain('JSON-RPC -32602')
    expect(error.message).toContain('Unknown prompt')
  })
})

describe('hdx.query', () => {
  test('runs a read-only tool and returns its text', async () => {
    const { by, hdx, opts } = setup()
    const out = await by['hdx.query'].call(
      { env: 'local', tool: 'clickstack_list_sources', args: { sourceId: 's1' } },
      opts,
    )
    expect(out).toMatchObject({ env: 'local', tool: 'clickstack_list_sources', isError: false, truncated: false })
    expect(JSON.parse(out.text)).toEqual({ tool: 'clickstack_list_sources', args: { sourceId: 's1' } })
    expect(hdx.seen[0]!.body).toMatchObject({
      method: 'tools/call',
      params: { name: 'clickstack_list_sources', arguments: { sourceId: 's1' } },
    })
  })

  test('a tool-level failure is data the agent can read, not an exception', async () => {
    const { by, opts } = setup()
    const out = await by['hdx.query'].call(
      { env: 'local', tool: 'clickstack_describe_source', args: { sourceId: 'missing' } },
      opts,
    )
    expect(out).toMatchObject({ isError: true, text: 'source not found' })
  })

  test('the allowlist: no mutating or unknown tool reaches the server', async () => {
    const { by, hdx, opts } = setup()
    for (const tool of [
      ...MUTATING_TOOLS,
      'clickstack_delete_alert',
      'clickstack_delete_saved_search',
      'clickstack_new_thing',
      '',
      'CLICKSTACK_SQL',
    ]) {
      const error = await errorOf(by['hdx.query'].call({ env: 'local', tool }, opts))
      expect(error).toMatchObject({ code: 'BAD_REQUEST', status: 400 })
    }
    expect(hdx.seen).toHaveLength(0)
  })

  test('every allowlisted tool is accepted, and none is a known mutating tool', async () => {
    const { by, hdx, opts } = setup()
    for (const tool of READ_ONLY_TOOLS) await by['hdx.query'].call({ env: 'local', tool }, opts)
    expect(hdx.seen).toHaveLength(READ_ONLY_TOOLS.length)
    for (const tool of MUTATING_TOOLS) expect(READ_ONLY_TOOLS as readonly string[]).not.toContain(tool)
  })

  test('the answer is cut at maxChars with a marker', async () => {
    const { by, opts } = setup({
      override: (seen) =>
        seen.path === '/api/mcp'
          ? new Response(
              sse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'x'.repeat(1000) }] } }),
            )
          : undefined,
    })
    const out = await by['hdx.query'].call({ env: 'local', tool: 'clickstack_sql', maxChars: 100 }, opts)
    expect(out.truncated).toBe(true)
    expect(out.totalChars).toBe(1000)
    expect(out.text.startsWith('x'.repeat(100))).toBe(true)
    expect(out.text).toContain('[truncated: showing 100 of 1000 characters')
    expect(out.text.length).toBeLessThan(300)
  })

  test('non-text content is named, not dumped', async () => {
    const { by, opts } = setup({
      override: (seen) =>
        seen.path === '/api/mcp'
          ? new Response(
              sse({
                jsonrpc: '2.0',
                id: 1,
                result: {
                  content: [
                    { type: 'text', text: 'a' },
                    { type: 'image', data: 'AAAA' },
                  ],
                },
              }),
            )
          : undefined,
    })
    expect((await by['hdx.query'].call({ env: 'local', tool: 'clickstack_sql' }, opts)).text).toBe(
      'a\n[image content omitted]',
    )
  })

  test('records a call that costs nothing, priced (rate, 0), never unknown', async () => {
    const { by, usage, opts } = setup()
    await by['hdx.query'].call({ env: 'local', tool: 'clickstack_sql' }, opts)
    expect(usage).toEqual([
      { model: 'hyperdx', tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0 }, cost: 0, costSource: 'rate' },
    ])
  })
})

describe('hdx.rest', () => {
  test('GETs under /api/api/v2', async () => {
    const { by, hdx, opts } = setup()
    const out = await by['hdx.rest'].call({ env: 'local', path: '/sources?limit=2' }, opts)
    expect(out.status).toBe(200)
    expect(JSON.parse(out.text)).toMatchObject({ method: 'GET', path: '/sources' })
    expect(hdx.seen[0]).toMatchObject({ method: 'GET', path: '/api/api/v2/sources?limit=2', auth: `Bearer ${KEY}` })
  })

  test('a path that would leave /api/api/v2 is refused before anything is sent', async () => {
    const { by, hdx, opts } = setup()
    for (const path of ['/../mcp', '/%2e%2e/mcp', '//evil.example/x', 'sources', '/a\\..\\b'])
      expect(await errorOf(by['hdx.rest'].call({ env: 'local', path }, opts))).toMatchObject({ code: 'BAD_REQUEST' })
    expect(hdx.seen).toHaveLength(0)
    expect(restPathStaysUnder('/dashboards/abc')).toBe(true)
    expect(restPathStaysUnder('/dashboards/../../mcp')).toBe(false)
  })

  test('a 404 is an UPSTREAM_ERROR with its status and body, not retried', async () => {
    const { by, hdx, opts } = setup()
    const error = await errorOf(by['hdx.rest'].call({ env: 'local', path: '/gone' }, opts))
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', data: { status: 404 } })
    expect(error.message).toContain('not found')
    expect(hdx.seen).toHaveLength(1)
  })
})

describe('hdx.write', () => {
  test('is mutating for the CLI, the others are not', () => {
    const { caps } = setup()
    expect(Object.fromEntries(caps.map((c) => [c.id, c.cli.mutating]))).toEqual({
      'hdx.tools': false,
      'hdx.guide': false,
      'hdx.query': false,
      'hdx.rest': false,
      'hdx.write': true,
      'hdx.link': false,
    })
  })

  test('calls a mutating tool', async () => {
    const { by, hdx, opts } = setup()
    const out = await by['hdx.write'].call(
      { env: 'local', tool: 'clickstack_save_dashboard', args: { name: 'd' } },
      opts,
    )
    expect(out).toMatchObject({ via: 'tool', isError: false })
    expect(hdx.seen[0]!.body).toMatchObject({ params: { name: 'clickstack_save_dashboard', arguments: { name: 'd' } } })
  })

  test('a REST write sends method and body', async () => {
    const { by, hdx, opts } = setup()
    const out = await by['hdx.write'].call({ env: 'local', path: '/dashboards', body: { name: 'd' } }, opts)
    expect(out).toMatchObject({ via: 'rest', status: 200 })
    expect(hdx.seen[0]).toMatchObject({ method: 'POST', path: '/api/api/v2/dashboards', body: { name: 'd' } })
    await by['hdx.write'].call({ env: 'local', method: 'DELETE', path: '/dashboards/abc' }, opts)
    expect(hdx.seen[1]).toMatchObject({ method: 'DELETE', path: '/api/api/v2/dashboards/abc' })
  })

  test('refuses read-only tools (use hdx.query), and an ambiguous call', async () => {
    const { by, hdx, opts } = setup()
    for (const tool of READ_ONLY_TOOLS)
      expect(await errorOf(by['hdx.write'].call({ env: 'local', tool }, opts))).toMatchObject({ code: 'BAD_REQUEST' })
    for (const input of [
      {},
      { tool: 'clickstack_save_alert', path: '/alerts' },
      { tool: 'clickstack_save_alert', method: 'PUT' as const },
      { path: '/alerts', args: {} },
      { path: '/alerts', method: 'GET' as never },
    ])
      expect(await errorOf(by['hdx.write'].call({ env: 'local', ...input }, opts))).toMatchObject({
        code: 'BAD_REQUEST',
      })
    expect(hdx.seen).toHaveLength(0)
  })

  test('is sent once: a 5xx is not resent', async () => {
    const { by, hdx, opts } = setup({
      override: (seen) => (seen.path.startsWith('/api/api/v2') ? new Response('boom', { status: 500 }) : undefined),
    })
    const error = await errorOf(by['hdx.write'].call({ env: 'local', path: '/dashboards', body: {} }, opts))
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', data: { status: 500 } })
    expect(hdx.seen).toHaveLength(1)
  })
})

describe('hdx.link', () => {
  test('builds the kiosk link and needs no key', () => {
    const { by } = setup({ env: { HYPERDX_LOCAL_ACCESS_KEY: '' }, deps: { now: () => 1_700_000_000_000 } })
    return expect(by['hdx.link'].call({ env: 'local', dashboardId: 'abc123', last: '1h' })).resolves.toEqual({
      env: 'local',
      url: expect.stringMatching(
        /^http:\/\/127\.0\.0\.1:\d+\/dashboards\/abc123\?from=1699996400000&to=1700000000000&kiosk=true$/,
      ),
    })
  })

  test('prod is https://hyperdx.<domain>; an id with a slash is refused', async () => {
    const { by } = setup({ env: { HYPERDX_DOMAIN: 'example.com' } })
    expect((await by['hdx.link'].call({ dashboardId: 'x' })).url).toStartWith(
      'https://hyperdx.example.com/dashboards/x?from=',
    )
    expect(await errorOf(by['hdx.link'].call({ dashboardId: '../x' }))).toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('configuration', () => {
  test('prod without its domain or key is NOT_CONFIGURED, naming the variable, and nothing was sent', async () => {
    const noDomain = setup({ env: { HYPERDX_PROD_URL: '', HYPERDX_DOMAIN: '   ', HYPERDX_PROD_ACCESS_KEY: 'k' } })
    const domainError = await errorOf(noDomain.by['hdx.query'].call({ tool: 'clickstack_sql' }, noDomain.opts))
    expect(domainError).toMatchObject({ code: 'NOT_CONFIGURED', status: 503 })
    expect(domainError.message).toContain('HYPERDX_DOMAIN')
    const noKey = setup({ env: { HYPERDX_DOMAIN: 'example.com', HYPERDX_PROD_ACCESS_KEY: '' } })
    const keyError = await errorOf(noKey.by['hdx.query'].call({ tool: 'clickstack_sql' }, noKey.opts))
    expect(keyError).toMatchObject({ code: 'NOT_CONFIGURED', status: 503 })
    expect(keyError.message).toContain('HYPERDX_PROD_ACCESS_KEY')
    expect(noDomain.hdx.seen.length + noKey.hdx.seen.length).toBe(0)
  })

  test('a malformed domain or URL is NOT_CONFIGURED, not a request to somewhere else', async () => {
    const bad: Record<string, string>[] = [
      { HYPERDX_PROD_ACCESS_KEY: 'k', HYPERDX_DOMAIN: 'evil.example/x?' },
      { HYPERDX_PROD_ACCESS_KEY: 'k', HYPERDX_PROD_URL: 'ftp://x' },
      { HYPERDX_PROD_ACCESS_KEY: 'k', HYPERDX_PROD_URL: 'https://user:pw@x.example' },
    ]
    for (const env of bad) {
      const { by, opts } = setup({ env })
      expect(await errorOf(by['hdx.tools'].call({}, opts))).toMatchObject({ code: 'NOT_CONFIGURED' })
    }
  })

  test('the local key comes from the environment, else from the dotenv file at call time', async () => {
    let file: string | undefined
    const { by, hdx, opts } = setup({ env: { HYPERDX_LOCAL_ACCESS_KEY: '' }, deps: { readLocalEnvFile: () => file } })
    const missing = await errorOf(by['hdx.tools'].call({ env: 'local' }, opts))
    expect(missing).toMatchObject({ code: 'NOT_CONFIGURED' })
    expect(missing.message).toContain('HYPERDX_LOCAL_ACCESS_KEY')
    file = `# local\nHYPERDX_LOCAL_EMAIL=a@b.c\nHYPERDX_LOCAL_ACCESS_KEY="${KEY}"\n`
    await by['hdx.tools'].call({ env: 'local' }, opts)
    expect(hdx.seen.at(-1)!.auth).toBe(`Bearer ${KEY}`)
  })

  test('the prod key is sent to the prod URL only', async () => {
    const prod = fakeHyperdx()
    servers.push(prod)
    const { by, opts } = setup({
      env: { HYPERDX_PROD_URL: prod.base, HYPERDX_PROD_ACCESS_KEY: KEY, HYPERDX_LOCAL_ACCESS_KEY: 'local-key' },
    })
    await by['hdx.tools'].call({}, opts)
    expect(prod.seen).toHaveLength(1)
    expect(prod.seen[0]!.auth).toBe(`Bearer ${KEY}`)
  })
})

describe('error mapping', () => {
  test('401 is UPSTREAM_ERROR(401), not retried, and the message never carries the key', async () => {
    const { by, hdx, opts } = setup({ env: { HYPERDX_LOCAL_ACCESS_KEY: 'wrong-key-value' } })
    const error = await errorOf(by['hdx.tools'].call({ env: 'local' }, opts))
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', status: 502, data: { status: 401 } })
    expect(error.message).toContain('rejected the access key (401)')
    expect(error.message).not.toContain('wrong-key-value')
    expect(hdx.seen).toHaveLength(1)
  })

  test('5xx is retried and recovers; persistent 5xx fails after three attempts', async () => {
    const flaky = setup({
      override: (seen, n) =>
        seen.path === '/api/mcp' && n < 3 ? new Response('bad gateway', { status: 502 }) : undefined,
    })
    expect((await flaky.by['hdx.tools'].call({ env: 'local' }, flaky.opts)).tools.length).toBeGreaterThan(0)
    expect(flaky.hdx.seen).toHaveLength(3)
    const down = setup({ override: () => new Response('down', { status: 503 }) })
    expect(await errorOf(down.by['hdx.tools'].call({ env: 'local' }, down.opts))).toMatchObject({
      code: 'UPSTREAM_ERROR',
      data: { status: 503 },
    })
    expect(down.hdx.seen).toHaveLength(3)
    expect(down.usage).toHaveLength(0)
  })

  test('an empty 400 (ClickStack connection race) is resent once; a 400 with a body is not', async () => {
    const race = setup({ override: (_seen, n) => (n === 1 ? new Response('', { status: 400 }) : undefined) })
    await race.by['hdx.tools'].call({ env: 'local' }, race.opts)
    expect(race.hdx.seen).toHaveLength(2)
    const bad = setup({ override: () => new Response('bad body', { status: 400 }) })
    const error = await errorOf(bad.by['hdx.tools'].call({ env: 'local' }, bad.opts))
    expect(error).toMatchObject({ data: { status: 400 } })
    expect(error.message).toContain('bad body')
    expect(bad.hdx.seen).toHaveLength(1)
  })

  test('a JSON-RPC error and a body without a message are UPSTREAM_ERROR', async () => {
    const rpcError = setup({
      override: () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }),
    })
    const error = await errorOf(rpcError.by['hdx.tools'].call({ env: 'local' }, rpcError.opts))
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR' })
    expect(error.message).toContain('Method not found')
    const empty = setup({ override: () => new Response('event: message\n\n') })
    expect((await errorOf(empty.by['hdx.tools'].call({ env: 'local' }, empty.opts))).message).toContain(
      'without a JSON-RPC message',
    )
  })

  test('an unreachable server is UPSTREAM_ERROR and the message does not carry the URL', async () => {
    const { by, opts } = setup({ env: { HYPERDX_LOCAL_URL: 'http://127.0.0.1:1' } })
    const error = await errorOf(by['hdx.tools'].call({ env: 'local' }, opts))
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR' })
    expect(error.message).toBe('hdx local unreachable')
  })
})

describe('SSE framing', () => {
  test('picks the message with the request id out of CRLF frames and pings', () => {
    const raw = `: ping\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0","id":7,"result":{}}\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\r\n\r\n`
    expect(parseRpcMessage(raw, 1)).toMatchObject({ result: { ok: true } })
    expect(parseRpcMessage('{"id":1,"result":{"a":1}}', 1)).toMatchObject({ result: { a: 1 } })
    expect(parseRpcMessage('data: not json\n\n', 1)).toBeUndefined()
  })
})

describe('registry', () => {
  test('the document carries x-cli and the strict inputs; hdx.write is the only mutating one', async () => {
    const { caps, hdx } = setup()
    const registry = createRegistry(caps)
    const doc = (await registry.openapi()) as { paths: Record<string, Record<string, Record<string, any>>> }
    const cli = Object.fromEntries(
      Object.entries(doc.paths)
        .filter(([path]) => path.startsWith('/hdx/'))
        .map(([path, ops]) => [path, ops.post!['x-cli'].mutating]),
    )
    expect(cli).toEqual({
      '/hdx/tools': false,
      '/hdx/guide': false,
      '/hdx/query': false,
      '/hdx/rest': false,
      '/hdx/write': true,
      '/hdx/link': false,
    })
    const error = await errorOf(registry.call('hdx.query', { env: 'local', tool: 'clickstack_sql', stray: 1 } as never))
    expect(error).toMatchObject({ code: 'BAD_REQUEST' })
    expect(hdx.seen).toHaveLength(0)
  })

  test('an HTTP call to hdx.query with a mutating tool is a 400', async () => {
    const { caps, hdx } = setup()
    const registry = createRegistry(caps)
    const res = await registry.fetch(
      new Request('http://x/hdx/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ env: 'local', tool: 'clickstack_delete_dashboard', args: { id: 'a' } }),
      }),
    )
    expect(res.status).toBe(400)
    expect(hdx.seen).toHaveLength(0)
  })
})
