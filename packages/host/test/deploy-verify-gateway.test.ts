// The gateway part of scripts/verify.sh (section 8), run by the real zsh against a stand-in gateway (Bun.serve) with psql
// and secrets-run replaced. The script's header (constants, fail/ok) and section 8 are cut out of the file, so the rest of
// verify.sh (which needs the journal and the installed CLI) is not involved.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../../..')
const ZSH = Bun.which('zsh')
const VERIFY = readFileSync(join(ROOT, 'scripts', 'verify.sh'), 'utf8')
const HEADER = VERIFY.slice(0, VERIFY.indexOf('for tool in'))
const SECTION = VERIFY.slice(VERIFY.indexOf('# 8. the gateway'), VERIFY.indexOf('\nprint "verify: PASS'))

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

type Request = { headers: Record<string, string>; body: unknown }
type Options = {
  pools?: string[] // x-agw-pool per call
  cacheRead?: number[] // usage.cache_read_input_tokens per call
  status?: number[]
  build?: string
  rows?: string[] // psql rows for usage.records (pipe separated)
  picks?: number
}

async function verify(options: Options = {}) {
  if (!ZSH) throw new Error('zsh is not on PATH: scripts/verify.sh needs it (CI installs it in ci.yml)')
  const { pools = ['iu', 'iu', 'iu-api'], cacheRead = [0, 120, 0], status = [200, 200, 200], build = 'b1' } = options
  const requests: Request[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/health') return Response.json({ status: 'ok', version: 'x', build })
      const n = requests.length
      requests.push({ headers: Object.fromEntries(request.headers), body: await request.json() })
      return Response.json(
        { usage: { cache_read_input_tokens: cacheRead[n] ?? 0 } },
        {
          status: status[n] ?? 200,
          headers: { 'x-agw-request-id': `req-${n + 1}`, 'x-agw-pool': pools[n] ?? 'iu' },
        },
      )
    },
  })
  const home = mkdtempSync(join(tmpdir(), 'agw-verify-gateway-'))
  cleanups.push(() => {
    void server.stop(true)
    rmSync(home, { recursive: true, force: true })
  })
  const root = join(home, '.agent-workflows')
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(join(root, 'data', 'gateway-build'), 'b1\n')
  mkdirSync(join(home, '.config', 'agw'), { recursive: true })
  writeFileSync(join(home, '.config', 'agw', 'env'), 'AGW_URL=http://127.0.0.1:7791\nAGW_API_SECRET=the-secret\n')
  const rows =
    options.rows ??
    ['req-1|api_credit|iu|0.0001', 'req-2|api_credit|iu|0.00002', 'req-3|api_key|personal|0.0001'].map((row) => {
      const [id, billing, who, cost] = row.split('|')
      return billing === 'api_credit' ? `${id}|${billing}|${who}||${cost}` : `${id}|${billing}||${who}|${cost}`
    })
  const bin = join(home, '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(join(home, 'rows'), rows.join('\n') + (rows.length > 0 ? '\n' : ''))
  stub('secrets-run', '#!/bin/sh\necho usage-password\n')
  // psql: the picks query (it names gateway_picks) answers a count, the records query the rows; ids arrive as -v ids=...
  stub(
    'psql',
    `#!/bin/sh\nsql=$(cat)\ncase "$sql" in *gateway_picks*) echo ${options.picks ?? 3} ;; *) cat "$HOME/rows" ;; esac\n`,
  )
  const script = `${HEADER}\npsql_err=$(mktemp); agw_err=$(mktemp); door_body=$(mktemp)\n${SECTION}\nprint "verify: gateway part done"\n`
  const proc = Bun.spawn([ZSH, '-c', script], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      AGW_ROOT: root,
      AGW_GATEWAY_URL: `http://127.0.0.1:${server.port}`,
      GATEWAY_POLL_SECS: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err, requests }
}

describe('verify.sh gateway section', () => {
  test('three calls, the shapes the brief names, and the usage rows: passes and prints ids and pool', async () => {
    const r = await verify()
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toContain('credit pool iu, request req-1')
    expect(r.out).toContain('request req-2')
    expect(r.out).toContain('pool iu-api, request req-3')
    expect(r.out).toContain('gateway part done')
    expect(r.requests).toHaveLength(3)
    for (const request of r.requests) {
      expect(request.headers['x-api-key']).toBe('the-secret')
      expect(request.headers['anthropic-version']).toBe('2023-06-01')
      expect(request.headers['x-agw-purpose']).toBe('verify')
      expect(request.headers['x-agw-session']).toMatch(/^verify-\d+$/)
      const body = request.body as {
        model: string
        max_tokens: number
        system: Array<{ text: string; cache_control: unknown }>
        messages: unknown
      }
      expect(body.model).toBe('haiku')
      expect(body.max_tokens).toBe(8)
      expect(body.system[0]?.cache_control).toEqual({ type: 'ephemeral' })
      expect(body.system[0]?.text.length).toBeGreaterThan(3000) // well past 700 tokens
      expect(body.messages).toEqual([{ role: 'user', content: 'Reply with OK.' }])
    }
    expect(r.requests.map((request) => request.headers['x-app'])).toEqual([undefined, undefined, 'cli'])
    // The same session and the same body on every call (the cache needs the same prefix).
    expect(new Set(r.requests.map((request) => request.headers['x-agw-session'])).size).toBe(1)
    expect(new Set(r.requests.map((request) => JSON.stringify(request.body))).size).toBe(1)
  })

  test('a build that differs from data/gateway-build fails naming both', async () => {
    const r = await verify({ build: 'other' })
    expect(r.code).toBe(1)
    expect(r.err).toContain('reports build other')
    expect(r.err).toContain('gateway-build says b1')
  })

  test('call 1 paid by IU, not a credit pool, fails', async () => {
    const r = await verify({ pools: ['iu-api', 'iu-api', 'iu-api'] })
    expect(r.code).toBe(1)
    expect(r.err).toContain('not paid from a credit pool')
  })

  test('call 2 without a cache read fails', async () => {
    const r = await verify({ cacheRead: [0, 0, 0] })
    expect(r.code).toBe(1)
    expect(r.err).toContain('read no cache')
  })

  test('call 2 on another pool fails', async () => {
    const r = await verify({ pools: ['iu', 'me', 'iu-api'] })
    expect(r.code).toBe(1)
    expect(r.err).toContain('call 1 to iu')
  })

  test('call 3 (Claude-Code-shaped) that does not reach iu-api fails', async () => {
    const r = await verify({ pools: ['iu', 'iu', 'me'] })
    expect(r.code).toBe(1)
    expect(r.err).toContain('not iu-api')
  })

  test('a non-200 names the call', async () => {
    const r = await verify({ status: [200, 502, 200] })
    expect(r.code).toBe(1)
    expect(r.err).toContain('gateway call 2')
    expect(r.err).toContain('502')
  })

  test('a missing usage row names the request id', async () => {
    const r = await verify({ rows: ['req-1|api_credit|iu||0.0001', 'req-3|api_key||personal|0.0001'] })
    expect(r.code).toBe(1)
    expect(r.err).toContain('no usage.records row')
    expect(r.err).toContain('req-2')
  })

  test('wrong billing, account, cost or key are each named', async () => {
    const cases: Array<[string[], string]> = [
      [
        ['req-1|api_key||personal|0.1', 'req-2|api_credit|iu||0.1', 'req-3|api_key||personal|0.1'],
        'expected api_credit',
      ],
      [['req-1|api_credit|me||0.1', 'req-2|api_credit|iu||0.1', 'req-3|api_key||personal|0.1'], 'expected the pool iu'],
      [['req-1|api_credit|iu||0', 'req-2|api_credit|iu||0.1', 'req-3|api_key||personal|0.1'], 'expected > 0'],
      [['req-1|api_credit|iu||0.1', 'req-2|api_credit|iu||0.1', 'req-3|api_credit|iu||0.1'], 'expected api_key'],
      [['req-1|api_credit|iu||0.1', 'req-2|api_credit|iu||0.1', 'req-3|api_key||athena-team|0.1'], 'expected personal'],
    ]
    for (const [rows, message] of cases) {
      const r = await verify({ rows })
      expect(r.code).toBe(1)
      expect(r.err).toContain(message)
    }
  })

  test('a missing gateway_picks row fails', async () => {
    const r = await verify({ picks: 2 })
    expect(r.code).toBe(1)
    expect(r.err).toContain('gateway_picks has 2 of 3')
  })
})
