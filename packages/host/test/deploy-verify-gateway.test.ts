// The gateway part of scripts/verify.sh (sections 8 and 9) and its smoke review (section 10), run by the real zsh against a stand-in gateway (Bun.serve)
// with psql and secrets-run replaced. The script's header (constants, fail/ok) and the sections are cut out of the file,
// so the rest of verify.sh (which needs the journal and the installed CLI) is not involved.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../../..')
const ZSH = Bun.which('zsh')
const VERIFY = readFileSync(join(ROOT, 'scripts', 'verify.sh'), 'utf8')
const HEADER = VERIFY.slice(0, VERIFY.indexOf('for tool in'))
const SECTION = VERIFY.slice(VERIFY.indexOf('# 8. the gateway'), VERIFY.indexOf('# 9. the runs'))
const RUNS = VERIFY.slice(VERIFY.indexOf('# 9. the runs'), VERIFY.indexOf('\n# 10. a smoke review'))
const SMOKE_REVIEW = VERIFY.slice(VERIFY.indexOf('\n# 10. a smoke review'), VERIFY.indexOf('\nprint "verify: PASS'))
const OC_TOKEN = 'agw-opencode-token-0123456789abcdef-0123'

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
  runRows?: string[] // section 9: psql rows for the runs' usage.records (run_id|source|lane|billing|account|key|workflow|step|cost)
  healthPools?: Array<{ id: string; eligible: boolean }> // /health pools (section 9)
  synced?: Record<string, string> // section 9: the outbox query's answer per run id (steps|unsynced|errored), default 1|0|0
  doorTokens?: string
  only?: 'gateway' | 'runs'
}

const DEFAULT_ROWS = [
  'req-1|api_credit|iu||0.0001|0|120|agw_workflow|agw',
  'req-2|api_credit|iu||0.00002|120|0|agw_workflow|agw',
  'req-3|api_key||personal|0.0001|0|0|agw_workflow|agw',
  'req-4|api_credit|iu||0.0001|0|0|agw_workflow|agw-opencode',
]
const DEFAULT_RUN_ROWS = [
  'run-1|gateway|agw_workflow|api_key||personal|smoke|title|0.00001',
  'run-2|gateway|agw_workflow|api_credit|iu||cap.llm.title|call|0.00002',
]
const lines = (rows: string[]) => rows.map((row) => `${row}\n`).join('')

/** A stand-in gateway: /health, and one answer per call from the per-call options; every call is recorded. */
function standInGateway(options: Options, requests: Request[]) {
  const { pools = ['iu', 'iu', 'iu-api', 'iu'], cacheRead = [0, 120, 0, 0], status = [200, 200, 200, 200] } = options
  const health = {
    status: 'ok',
    version: 'x',
    build: options.build ?? 'b1',
    pools: options.healthPools ?? [{ id: 'iu', eligible: true }],
  }
  return Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === '/health') return Response.json(health)
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
}

/** The fake HOME: data files, the CLI env file, the psql rows and the stand-in secrets-run and psql. */
function writeHome(home: string, root: string, options: Options) {
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(join(root, 'data', 'gateway-build'), 'b1\n')
  writeFileSync(
    join(root, 'data', 'door-tokens'),
    options.doorTokens ?? `hermes=${'h'.repeat(64)}\n agw-opencode = ${OC_TOKEN}\r\n`,
  )
  mkdirSync(join(home, '.config', 'agw'), { recursive: true })
  writeFileSync(join(home, '.config', 'agw', 'env'), 'AGW_URL=http://127.0.0.1:7791\nAGW_API_SECRET=the-secret\n')
  writeFileSync(join(home, 'rows'), lines(options.rows ?? DEFAULT_ROWS))
  writeFileSync(join(home, 'run-rows'), lines(options.runRows ?? DEFAULT_RUN_ROWS))
  for (const run of ['run-1', 'run-2'])
    writeFileSync(join(home, `synced-${run}`), `${options.synced?.[run] ?? '1|0|0'}\n`)
  const bin = join(home, '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  stub('secrets-run', '#!/bin/sh\necho usage-password\n')
  // psql: the picks query (it names gateway_picks) answers a count, the runs query (it binds runs) the run rows, the
  // records query the rows; the -v bindings are logged.
  stub(
    'psql',
    `#!/bin/sh\necho "$*" >> "$HOME/psql-args"\nsql=$(cat)\nid=$(printf '%s\\n' "$@" | sed -n 's/^id=//p')\ncase "$sql" in *gateway_picks*) echo ${options.picks ?? 4} ;; *argo_synced_at*) cat "$HOME/synced-$id" ;; *":'runs'"*) cat "$HOME/run-rows" ;; *) cat "$HOME/rows" ;; esac\n`,
  )
}

// Section 9 alone needs what section 8 leaves behind: the gateway's /health and the usage query.
const RUNS_PRELUDE = `gw_health=$(curl -fsS "$GATEWAY_URL/health"); usage_password=p
usage_q() { local sql=$1; shift; PGPASSWORD=p psql "$@" <<< "$sql" || fail "usage query failed"; }
journal() { local sql=$1; shift; psql "$@" <<< "$sql" || fail "journal query failed"; }
`

async function verify(options: Options = {}) {
  if (!ZSH) throw new Error('zsh is not on PATH: scripts/verify.sh needs it (CI installs it in ci.yml)')
  const requests: Request[] = []
  const server = standInGateway(options, requests)
  const home = mkdtempSync(join(tmpdir(), 'agw-verify-gateway-'))
  cleanups.push(() => {
    void server.stop(true)
    rmSync(home, { recursive: true, force: true })
  })
  const root = join(home, '.agent-workflows')
  writeHome(home, root, options)
  const body = options.only === 'runs' ? `${RUNS_PRELUDE}${RUNS}` : SECTION
  const script = `${HEADER}\npsql_err=$(mktemp); agw_err=$(mktemp); door_body=$(mktemp); run_id=run-1; cap_id=run-2\n${body}\nprint "verify: gateway part done"\n`
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
  return { code, out, err, requests, home }
}

describe('verify.sh gateway section', () => {
  test('three calls, the shapes the brief names, and the usage rows: passes and prints ids and pool', async () => {
    const r = await verify()
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toContain('credit pool iu, request req-1')
    expect(r.out).toContain('request req-2')
    expect(r.out).toContain('pool iu-api, request req-3')
    expect(r.out).toContain('request req-4')
    expect(r.out).toContain('req-4 agw_workflow as agw-opencode')
    expect(r.out).toContain('gateway part done')
    expect(r.requests).toHaveLength(4)
    expect(r.requests.map((request) => request.headers['x-api-key'])).toEqual([
      'the-secret',
      'the-secret',
      'the-secret',
      OC_TOKEN,
    ])
    expect(r.out + r.err).not.toContain(OC_TOKEN)
    for (const request of r.requests) {
      expect(request.headers['anthropic-version']).toBe('2023-06-01')
      expect(request.headers['x-agw-purpose']).toBe('verify')
      expect(request.headers['x-agw-session']).toMatch(/^verify-(oc-)?\d+$/)
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
    expect(r.requests.map((request) => request.headers['x-app'])).toEqual([undefined, undefined, 'cli', undefined])
    // The same session and the same body on the three cache calls (the cache needs the same prefix); agw-opencode its own.
    expect(new Set(r.requests.slice(0, 3).map((request) => request.headers['x-agw-session'])).size).toBe(1)
    expect(r.requests[3]?.headers['x-agw-session']).toMatch(/^verify-oc-\d+$/)
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
    const r = await verify({
      rows: [
        'req-1|api_credit|iu||0.0001|0|120|agw_workflow|agw',
        'req-3|api_key||personal|0.0001|0|0|agw_workflow|agw',
        'req-4|api_credit|iu||0.0001|0|0|agw_workflow|agw-opencode',
      ],
    })
    expect(r.code).toBe(1)
    expect(r.err).toContain('no usage.records row')
    expect(r.err).toContain('req-2')
  })

  test('wrong billing, account, cost or key are each named', async () => {
    const cases: Array<[string[], string]> = [
      [
        [
          'req-1|api_key||personal|0.1|0|120|agw_workflow|agw',
          'req-2|api_credit|iu||0.1|120|0|agw_workflow|agw',
          'req-3|api_key||personal|0.1|0|0|agw_workflow|agw',
          'req-4|api_credit|iu||0.1|0|0|agw_workflow|agw-opencode',
        ],
        'expected api_credit',
      ],
      [
        [
          'req-1|api_credit|me||0.1|0|120|agw_workflow|agw',
          'req-2|api_credit|iu||0.1|120|0|agw_workflow|agw',
          'req-3|api_key||personal|0.1|0|0|agw_workflow|agw',
          'req-4|api_credit|iu||0.1|0|0|agw_workflow|agw-opencode',
        ],
        'expected the pool iu',
      ],
      [
        [
          'req-1|api_credit|iu||0|0|120|agw_workflow|agw',
          'req-2|api_credit|iu||0.1|120|0|agw_workflow|agw',
          'req-3|api_key||personal|0.1|0|0|agw_workflow|agw',
          'req-4|api_credit|iu||0.1|0|0|agw_workflow|agw-opencode',
        ],
        'expected > 0',
      ],
      [
        [
          'req-1|api_credit|iu||0.1|0|120|agw_workflow|agw',
          'req-2|api_credit|iu||0.1|120|0|agw_workflow|agw',
          'req-3|api_credit|iu||0.1|0|0|agw_workflow|agw',
          'req-4|api_credit|iu||0.1|0|0|agw_workflow|agw-opencode',
        ],
        'expected api_key',
      ],
      [
        [
          'req-1|api_credit|iu||0.1|0|120|agw_workflow|agw',
          'req-2|api_credit|iu||0.1|120|0|agw_workflow|agw',
          'req-3|api_key||athena-team|0.1|0|0|agw_workflow|agw',
          'req-4|api_credit|iu||0.1|0|0|agw_workflow|agw-opencode',
        ],
        'expected personal',
      ],
    ]
    for (const [rows, message] of cases) {
      const r = await verify({ rows })
      expect(r.code).toBe(1)
      expect(r.err).toContain(message)
    }
  })

  test('cache columns of 0 fail naming the request id', async () => {
    const cases: Array<[string[], string]> = [
      [
        [
          'req-1|api_credit|iu||0.1|0|0|agw_workflow|agw',
          'req-2|api_credit|iu||0.1|120|0|agw_workflow|agw',
          'req-3|api_key||personal|0.1|0|0|agw_workflow|agw',
          'req-4|api_credit|iu||0.1|0|0|agw_workflow|agw-opencode',
        ],
        'request req-1: cache_write_5m_tokens',
      ],
      [
        [
          'req-1|api_credit|iu||0.1|0|120|agw_workflow|agw',
          'req-2|api_credit|iu||0.1|0|120|agw_workflow|agw',
          'req-3|api_key||personal|0.1|0|0|agw_workflow|agw',
          'req-4|api_credit|iu||0.1|0|0|agw_workflow|agw-opencode',
        ],
        'request req-2: cache_read_tokens',
      ],
    ]
    for (const [rows, message] of cases) {
      const r = await verify({ rows })
      expect(r.code).toBe(1)
      expect(r.err).toContain(message)
    }
  })

  test('call 1 that hit an existing cache passes', async () => {
    const r = await verify({
      rows: [
        'req-1|api_credit|iu||0.1|120|0|agw_workflow|agw',
        'req-2|api_credit|iu||0.1|120|0|agw_workflow|agw',
        'req-3|api_key||personal|0.1|0|0|agw_workflow|agw',
        'req-4|api_credit|iu||0.1|0|0|agw_workflow|agw-opencode',
      ],
    })
    expect(r.code).toBe(0)
  })

  test('a missing gateway_picks row fails', async () => {
    const r = await verify({ picks: 3 })
    expect(r.code).toBe(1)
    expect(r.err).toContain('gateway_picks has 3 of 4')
  })

  test('the agw-opencode call that lands in another lane, or as another caller, fails naming the request', async () => {
    const base = [
      'req-1|api_credit|iu||0.1|0|120|agw_workflow|agw',
      'req-2|api_credit|iu||0.1|120|0|agw_workflow|agw',
      'req-3|api_key||personal|0.1|0|0|agw_workflow|agw',
    ]
    const lane = await verify({ rows: [...base, 'req-4|api_credit|iu||0.1|0|0|other|agw-opencode'] })
    expect(lane.code).toBe(1)
    expect(lane.err).toContain("request req-4 (agw-opencode): lane 'other', expected agw_workflow")
    const caller = await verify({ rows: [...base, 'req-4|api_credit|iu||0.1|0|0|agw_workflow|agw'] })
    expect(caller.code).toBe(1)
    expect(caller.err).toContain('expected agw-opencode')
  })

  test('no agw-opencode line in door-tokens fails before any call', async () => {
    const r = await verify({ doorTokens: `hermes=${'h'.repeat(64)}\n# agw-opencode=${OC_TOKEN}\n` })
    expect(r.code).toBe(1)
    expect(r.err).toContain('no agw-opencode token in')
    expect(r.err).not.toContain(OC_TOKEN)
    expect(r.requests).toHaveLength(0)
  })
})

describe('verify.sh runs section', () => {
  const runs = (options: Options = {}) => verify({ ...options, only: 'runs' })

  test('a gateway row per run (api_key personal, api_credit on a listed pool) passes, bound to both run ids', async () => {
    const r = await runs()
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toContain('run run-1: steps synced, 1 gateway row(s), all qualify (api_key personal, smoke/title')
    expect(r.out).toContain(
      'run run-2: steps synced, 1 gateway row(s), all qualify (api_credit on iu, cap.llm.title/call',
    )
    expect(readFileSync(join(r.home, 'psql-args'), 'utf8')).toContain('runs=run-1,run-2')
  })

  test('an agent-workflows row for a run fails, even beside a good gateway row', async () => {
    const r = await runs({
      runRows: [
        'run-1|gateway|agw_workflow|api_key||personal|smoke|title|0.1',
        'run-1|agent-workflows|agw_workflow|api_key||personal|smoke|title|0.1',
        'run-2|gateway|agw_workflow|api_key||personal|cap.llm.title|call|0.1',
      ],
    })
    expect(r.code).toBe(1)
    expect(r.err).toContain("run run-1 has a source 'agent-workflows' row")
  })

  test('a run without a gateway row fails naming it', async () => {
    const r = await runs({ runRows: ['run-1|gateway|agw_workflow|api_key||personal|smoke|title|0.1'] })
    expect(r.code).toBe(1)
    expect(r.err).toContain("no usage.records row (source 'gateway') for run run-2")
  })

  test('each bad field is named', async () => {
    const good = 'run-2|gateway|agw_workflow|api_key||personal|cap.llm.title|call|0.1'
    const cases: Array<[string, string, Options['healthPools']?]> = [
      ['run-1|gateway|hermes|api_key||personal|smoke|title|0.1', "lane 'hermes', expected agw_workflow"],
      ['run-1|gateway|agw_workflow|api_key||athena-team|smoke|title|0.1', "api_key 'athena-team', expected personal"],
      ['run-1|gateway|agw_workflow|api_credit|me||smoke|title|0.1', "account 'me', not a pool /health lists (iu)"],
      [
        'run-1|gateway|agw_workflow|api_credit|iu||smoke|title|0.1',
        'but /health names no eligible pool',
        [{ id: 'iu', eligible: false }],
      ],
      ['run-1|gateway|agw_workflow|api_key||personal||title|0.1', 'lane_detail.workflow is not set'],
      ['run-1|gateway|agw_workflow|api_key||personal|smoke||0.1', 'lane_detail.step is not set'],
      ['run-1|gateway|agw_workflow|api_key||personal|smoke|title|', "cost_usd 'null', expected > 0"],
      ['run-1|gateway|agw_workflow|api_key||personal|smoke|title|0', "cost_usd '0', expected > 0"],
    ]
    for (const [row, message, healthPools] of cases) {
      const r = await runs({ runRows: [row, good], healthPools })
      expect(r.code).toBe(1)
      expect(r.err).toContain('run run-1: a gateway row does not qualify')
      expect(r.err).toContain(message)
    }
  })

  test('every gateway row must qualify: one good row beside a bad one fails', async () => {
    const r = await runs({
      runRows: [
        'run-1|gateway|agw_workflow|api_key||personal|smoke|title|0.1',
        'run-1|gateway|agw_workflow|api_key||personal|smoke||0.1',
        'run-2|gateway|agw_workflow|api_key||personal|cap.llm.title|call|0.1',
      ],
    })
    expect(r.code).toBe(1)
    expect(r.err).toContain('run run-1: a gateway row does not qualify: lane_detail.step is not set')
  })

  test('"no agent-workflows row" is judged only after the outbox synced the run: unsynced steps fail, never pass', async () => {
    const unsynced = await runs({ synced: { 'run-2': '2|1|0' } })
    expect(unsynced.code).toBe(1)
    expect(unsynced.err).toContain('run run-2: 1 of 2 usage step(s) not synced by the host outbox (within 0s)')
    const errored = await runs({ synced: { 'run-1': '1|0|1' } })
    expect(errored.code).toBe(1)
    expect(errored.err).toContain('run run-1: 1 usage step(s) failed to sync')
    const none = await runs({ synced: { 'run-1': '0|0|0' } })
    expect(none.code).toBe(1)
    expect(none.err).toContain('run run-1 has no ended step with usage')
    expect(readFileSync(join(unsynced.home, 'psql-args'), 'utf8')).toContain('id=run-2')
  })
})

// Section 10 (the smoke review) with `agw` and `psql` replaced: the real fixture is built into a real git repo, the stand-in
// `agw review` answers from files in HOME, and the stand-in psql answers the stage, report and run-row queries.
type ReviewOptions = {
  output?: unknown // what `agw review` prints; default: a done run with one real finding
  rc?: number // its exit code
  waitOutput?: unknown // what `agw run wait` prints (default: output)
  waitRc?: number
  waitSleepSecs?: number
  notDone?: string[] // steps the stage query lists as not done
  doneSteps?: string[]
  report?: string // the react-doctor step's stdout
  runRow?: string // status|cost
  waitSecs?: number
}

const REVIEW_VERDICT = {
  schemaVersion: 2,
  outcome: 'actionable',
  blocking: [],
  improvements: [{ file: 'src/Scores.tsx', line: 10, message: 'raw html from a note', angle: 'security' }],
  discussions: [],
  testGaps: [],
  summary: 'one problem',
}
const REVIEW_DONE = { runId: 'rev-1', status: 'done', output: REVIEW_VERDICT, cost: 0.04 }
const REPORT_WITH_DIAGNOSTIC = JSON.stringify({
  diagnostics: [{ rule: 'jsx-key', message: 'wrong data', filePath: 'src/Scores.tsx' }],
})

async function verifyReview(options: ReviewOptions = {}) {
  if (!ZSH) throw new Error('zsh is not on PATH: scripts/verify.sh needs it (CI installs it in ci.yml)')
  const home = mkdtempSync(join(tmpdir(), 'agw-verify-review-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const write = (name: string, content: string) => writeFileSync(join(home, name), content)
  write('review-out', JSON.stringify(options.output ?? REVIEW_DONE))
  write('review-rc', `${options.rc ?? 0}`)
  write('wait-out', JSON.stringify(options.waitOutput ?? options.output ?? REVIEW_DONE))
  write('wait-rc', `${options.waitRc ?? 0}`)
  write('wait-sleep', `${options.waitSleepSecs ?? 0}`)
  write('not-done', (options.notDone ?? []).map((step) => `${step} failed: boom\n`).join(''))
  write(
    'done-steps',
    (options.doneSteps ?? ['prepare', 'react-doctor', 'route', 'plan', 'angle:senior-dev', 'synthesis'])
      .map((step) => `${step}\n`)
      .join(''),
  )
  write('report', options.report ?? REPORT_WITH_DIAGNOSTIC)
  write('run-row', `${options.runRow ?? 'done|0.0385'}\n`)
  const bin = join(home, '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  // agw: `review` records its arguments and the fixture repo's status, `run wait` and `run cancel` are logged.
  stub(
    'agw',
    `#!/bin/sh
echo "$*" >> "$HOME/agw-calls"
case "$1 $2" in
  "review --cwd")
    git -C "$3" status --porcelain > "$HOME/fixture-status"
    git -C "$3" log --format=%s > "$HOME/fixture-log"
    cat "$HOME/review-out"; exit "$(cat "$HOME/review-rc")" ;;
  "run wait") sleep "$(cat "$HOME/wait-sleep")"; cat "$HOME/wait-out"; exit "$(cat "$HOME/wait-rc")" ;;
  "run cancel") echo '{"status":"cancelled"}'; exit 0 ;;
esac
echo "unexpected agw call: $*" >&2; exit 2
`,
  )
  stub(
    'psql',
    `#!/bin/sh
sql=$(cat)
case "$sql" in
  *"status <> 'done'"*) cat "$HOME/not-done" ;;
  *"status = 'done'"*) cat "$HOME/done-steps" ;;
  *"output->>'stdout'"*) cat "$HOME/report" ;;
  *"from "*".runs where id"*) cat "$HOME/run-row" ;;
  *) echo "unexpected psql: $sql" >&2; exit 2 ;;
esac
`,
  )
  const prelude = `agw_err=$(mktemp); review_dir=""; trap 'rm -rf "$agw_err" "$review_dir"' EXIT
journal() { local sql=$1; shift; psql "$@" <<< "$sql" || fail "journal query failed"; }
`
  const script = `${HEADER}\n${prelude}${SMOKE_REVIEW}\nprint "dir=$review_dir"\n`
  const proc = Bun.spawn([ZSH, '-c', script], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      REVIEW_FIXTURE: join(ROOT, 'scripts', 'fixtures', 'smoke-review'),
      ...(options.waitSecs === undefined ? {} : { REVIEW_WAIT_SECS: `${options.waitSecs}` }),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const read = (name: string) => {
    try {
      return readFileSync(join(home, name), 'utf8')
    } catch {
      return ''
    }
  }
  return { code, out, err, calls: read('agw-calls'), status: read('fixture-status'), log: read('fixture-log') }
}

describe('verify.sh smoke review section', () => {
  test('reviews the fixture as an uncommitted change at depth light and passes, printing run id and cost', async () => {
    const r = await verifyReview()
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toContain('run rev-1 done')
    expect(r.out).toContain('1 react-doctor diagnostic(s)')
    expect(r.out).toContain('cost 0.0385')
    expect(r.calls).toMatch(/^review --cwd \S+ --depth light --format json$/m)
    expect(r.log.trim()).toBe('base')
    expect(r.status).toContain('M src/Scores.tsx')
    expect(r.status).toContain('M src/stats.ts')
  })

  test('a react-doctor report with zero diagnostics fails: the PR #89 path was not exercised', async () => {
    const r = await verifyReview({ report: JSON.stringify({ diagnostics: [] }) })
    expect(r.code).toBe(1)
    expect(r.err).toContain('reported no diagnostic')
  })

  test('a react-doctor step that only recorded a failure line fails the same way', async () => {
    const r = await verifyReview({ report: 'react-doctor failed (exit 1): boom' })
    expect(r.code).toBe(1)
    expect(r.err).toContain('reported no diagnostic')
  })

  test('a missing stage is named: no synthesis, no angle, no react-doctor', async () => {
    const stages = ['prepare', 'react-doctor', 'angle:senior-dev', 'synthesis']
    const synthesis = await verifyReview({ doneSteps: stages.filter((s) => s !== 'synthesis'), notDone: ['synthesis'] })
    expect(synthesis.code).toBe(1)
    expect(synthesis.err).toContain('stage synthesis did not finish (stages not done: synthesis failed: boom)')
    const angle = await verifyReview({ doneSteps: stages.filter((s) => s !== 'angle:senior-dev') })
    expect(angle.err).toContain('no angle stage finished')
    const reactDoctor = await verifyReview({ doneSteps: stages.filter((s) => s !== 'react-doctor') })
    expect(reactDoctor.err).toContain('stage react-doctor did not finish')
  })

  test('a run that failed names its stages that are not done', async () => {
    const r = await verifyReview({
      output: { runId: 'rev-1', status: 'failed', error: { message: 'escapeName is not a function' } },
      rc: 1,
      notDone: ['synthesis'],
    })
    expect(r.code).toBe(1)
    expect(r.err).toContain('agw review exited 1')
    expect(r.err).toContain('stages not done: synthesis failed: boom')
  })

  test('a status that is missing or not done fails', async () => {
    const { status: _status, ...noStatus } = REVIEW_DONE
    expect((await verifyReview({ output: noStatus })).err).toContain('is not done')
    expect((await verifyReview({ output: { ...REVIEW_DONE, status: 'failed' } })).err).toContain('is not done')
  })

  test('a degraded verdict, or findings only from synthesis, pipeline or no angle, fail', async () => {
    const degraded = await verifyReview({
      output: { ...REVIEW_DONE, output: { ...REVIEW_VERDICT, degraded: 'provider_balance' } },
    })
    expect(degraded.err).toContain('the review was degraded')
    const finding = (angle?: string) => ({ file: 'x', message: 'm', ...(angle === undefined ? {} : { angle }) })
    for (const angle of ['synthesis', 'pipeline', '', undefined]) {
      const r = await verifyReview({
        output: { ...REVIEW_DONE, output: { ...REVIEW_VERDICT, improvements: [finding(angle)] } },
      })
      expect(r.code).toBe(1)
      expect(r.err).toContain('no finding from a real reviewer')
    }
  })

  test('a run row without a cost fails', async () => {
    const r = await verifyReview({ runRow: 'done|' })
    expect(r.code).toBe(1)
    expect(r.err).toContain('has no cost')
  })

  test('exit 10 is resumed with agw run wait until the run is done', async () => {
    const r = await verifyReview({ output: { runId: 'rev-1' }, rc: 10, waitOutput: REVIEW_DONE })
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.calls).toContain('run wait rev-1')
    expect(r.out).toContain('run rev-1 done')
  })

  test('a run still pending at the bound is cancelled, and the failure says so', async () => {
    const r = await verifyReview({
      output: { runId: 'rev-1' },
      rc: 10,
      waitOutput: { runId: 'rev-1' },
      waitRc: 10,
      waitSleepSecs: 1,
      waitSecs: 1,
    })
    expect(r.code).toBe(1)
    expect(r.calls).toContain('run cancel rev-1 --commit')
    expect(r.err).toContain('not done after 1s; the run was cancelled')
    expect(r.err).not.toContain('resume')
  })
})
