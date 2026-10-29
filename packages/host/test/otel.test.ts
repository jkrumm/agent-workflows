import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_SAFE_HDX, createCapabilities, createRegistry } from '@agent-workflows/capabilities'
import { fakeTransports } from '@agent-workflows/capabilities/testing'
import type { Json } from '@agent-workflows/runtime'
import { FakeAgentHost, type FakeSession } from '@agent-workflows/runtime/testing'
import { ToolGate } from '../src/tool-gate/index.ts'
import type { HostRegistry } from '../src/workflows/index.ts'
import { assemble, createOtelWorkflows, OTEL_VERSION } from '../src/workflows/otel/index.ts'
import { windowLine } from '../src/workflows/otel/prompts.ts'
import { Draft, OtelInput, OtelOutput, type OtelResult } from '../src/workflows/otel/schema.ts'
import { isGrounded, OTEL_TOOLS, type Recorded, rowsOf } from '../src/workflows/otel/tools.ts'
import { freshSchema, inspector, testRuntime } from '../../runtime/test/support/pg.ts'

const db = freshSchema('otel')
const sql = inspector(db.schema)
const stateDir = mkdtempSync(join(tmpdir(), 'agw-otel-'))

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const ERROR_LOG = 'connection refused: payments-db:5432'

/** What the fake ClickStack was asked, per call: the capability, and the env it was told to use. */
const capCalls: { id: string; input: Record<string, Json> }[] = []

/** The platform's `hdx.*` capabilities, canned (the contract of `packages/capabilities/src/hdx`). */
async function fakeHdx(id: string, input: Json, scope: { addUsage: (u: never) => void }): Promise<Json> {
  const args = input as Record<string, Json>
  capCalls.push({ id, input: args })
  scope.addUsage({
    model: 'hyperdx',
    tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
    cost: 0,
    costSource: 'rate',
  } as never)
  const env = args.env as string
  if (id === 'hdx.tools')
    return { env, tools: [{ name: 'clickstack_table', summary: 'x', queryable: true }], truncated: false }
  if (id === 'hdx.guide') return { env, text: 'use the builder tools', truncated: false, totalChars: 21 }
  if (id !== 'hdx.query') throw new Error(`unexpected capability ${id}`)
  const tool = args.tool as string
  const answer = (text: string, isError = false) => ({
    env,
    tool,
    isError,
    text,
    truncated: false,
    totalChars: text.length,
  })
  if (tool === 'clickstack_list_sources') return answer('[{"id":"s1","name":"Traces","kind":"trace"}]')
  if (tool === 'clickstack_describe_source') return answer('{"columns":["ServiceName","StatusCode","Duration"]}')
  if (tool === 'clickstack_table') {
    return answer(
      JSON.stringify({
        rows: [
          { ServiceName: 'checkout', errors: 142, sample: TRACE },
          { ServiceName: 'payments', errors: 12, message: ERROR_LOG },
        ],
      }),
    )
  }
  if (tool === 'clickstack_search') return answer('unknown column "Foo"', true)
  throw new Error('hdx prod unreachable')
}

const gate = new ToolGate({
  stateDir,
  call: fakeHdx,
  // The fake host's session ids are not OpenCode's: the fake agent sends its step key as the session id.
  belongsTo: (sessionId, stepKey) => sessionId === stepKey,
})
gate.useCapabilities((id) => (id.startsWith('hdx.') ? { mutating: false } : undefined))

/** What the plugin does: POST the tool call with the session id and the key from gate.json. */
async function callTool(session: FakeSession, tool: string, args: Record<string, Json>) {
  const { url, key } = (await Bun.file(join(stateDir, 'gate.json')).json()) as { url: string; key: string }
  const response = await fetch(`${url}/tool/${tool}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionID: session.root.spec.key, args }),
  })
  return (await response.json()) as { ok: boolean; result?: Json; error?: string; code?: string }
}

const query = (session: FakeSession, tool: string, args: Record<string, Json> = {}, extra: Record<string, Json> = {}) =>
  callTool(session, 'hdx_query', { tool, args, ...extra })

const answer = (over: Partial<Draft> = {}) =>
  JSON.stringify({
    status: 'errors',
    timeRange: '2026-10-27T08:00:00Z/2026-10-27T10:00:00Z',
    findings: [{ service: 'checkout', summary: '142 error spans', severity: 'error', evidence: 'q3: errors=142' }],
    recommendations: ['look at checkout'],
    ...over,
  })

const workflows = createOtelWorkflows({ registry: {} as HostRegistry, toolGate: gate }, { agentBackoffMs: 10 })
const otel = workflows[0]?.workflow as NonNullable<(typeof workflows)[0]>['workflow']

async function run(input: Record<string, Json>, host: FakeAgentHost) {
  const rt = testRuntime({ schema: db.schema, workflows: [otel], host })
  await rt.open()
  try {
    const { runId } = await rt.start(otel, input, { purpose: 'build' })
    return { runId, result: await rt.wait(runId) }
  } finally {
    await rt.close()
  }
}

/** A normal investigation: sources, schema, a table; the agent tries to switch the environment on every call. */
async function investigate(s: FakeSession, env = 'local') {
  await callTool(s, 'hdx_tools', { env })
  await query(s, 'clickstack_list_sources', {}, { env })
  await query(s, 'clickstack_describe_source', { source: 's1' }, { env })
  await query(s, 'clickstack_table', { source: 's1' }, { env })
}

beforeAll(async () => {
  const rt = testRuntime({ schema: db.schema, workflows: [] })
  await rt.open()
  await rt.close()
})
afterAll(async () => {
  await gate.close()
  await sql.close()
  await db.drop()
  rmSync(stateDir, { recursive: true, force: true })
})

describe('otel workflow on a fake host', () => {
  test('the tools go through the gate, the environment is the run’s, findings are checked against the run’s queries', async () => {
    capCalls.length = 0
    let prompt = ''
    const host = new FakeAgentHost(async (s) => {
      prompt = s.spec.prompt
      await investigate(s) // asks for `local` on every call
      const refused = await callTool(s, 'hdx_rest', { path: '/dashboards' })
      expect(refused).toEqual({ ok: false, error: 'hdx_rest is not granted to this agent', code: 'not_granted' })
      return {
        output: answer({
          findings: [
            { service: 'checkout', summary: '142 error spans', severity: 'error', evidence: 'q3: errors=142' },
            { service: 'checkout', summary: 'one failing trace', severity: 'warn', evidence: `trace ${TRACE}` },
            { service: 'payments', summary: 'db refused', severity: 'error', evidence: `log "${ERROR_LOG}"` },
            { service: 'search', summary: 'slow', severity: 'warn', evidence: 'q9: p95 4s' },
            { service: 'auth', summary: 'flaky', severity: 'warn' },
          ],
        }),
      }
    })
    const { runId, result } = await run(
      { investigation: 'why do checkouts fail?', since: '2026-10-27T08:00:00Z/2026-10-27T10:00:00Z' },
      host,
    )
    expect(result.status).toBe('done')
    const out: OtelResult = OtelOutput.parse(result.output)
    expect([...host.sessions.values()][0]?.spec.agent).toBe('otel')
    // The default environment is prod; the agent's `local` never reached a capability.
    expect(out.environment).toBe('prod')
    expect(capCalls.map((c) => c.input.env)).toEqual(['prod', 'prod', 'prod', 'prod'])
    expect(prompt).toContain('prod (fixed')
    expect(prompt).toContain('Exactly 2026-10-27T08:00:00Z to 2026-10-27T10:00:00Z (UTC)')
    expect(out.queries.map((q) => [q.id, q.tool, q.target, q.ok])).toEqual([
      ['t1', 'hdx_tools', undefined, true],
      ['q1', 'hdx_query', 'clickstack_list_sources', true],
      ['q2', 'hdx_query', 'clickstack_describe_source', true],
      ['q3', 'hdx_query', 'clickstack_table', true],
    ])
    expect(out.queries[3]).toMatchObject({ rows: 2, argsDigest: expect.stringMatching(/^[0-9a-f]{12}$/) })
    expect(out.hyperdx).toEqual({ connected: true })
    expect(out.findings.map((f) => f.unverified)).toEqual([false, false, false, true, true])
    expect(out.warnings).toEqual(['2 finding(s) cite no query of this run: kept, flagged unverified'])
    expect(out.status).toBe('errors')
    expect(Object.keys(out).sort()).toEqual(
      ['environment', 'findings', 'hyperdx', 'queries', 'recommendations', 'status', 'timeRange', 'warnings'].sort(),
    )
    expect((await sql.step(runId, 'tools'))?.status).toBe('done')
  })

  test('env: local pins every call to local, whatever the agent sends', async () => {
    capCalls.length = 0
    const host = new FakeAgentHost(async (s) => {
      await investigate(s, 'prod')
      return { output: answer() }
    })
    const { result } = await run({ investigation: 'local dev is slow', env: 'local', since: '30m' }, host)
    const out = OtelOutput.parse(result.output)
    expect(out.environment).toBe('local')
    expect(capCalls.map((c) => c.input.env)).toEqual(['local', 'local', 'local', 'local'])
    // The agent's `args` object is its own: only the top-level env is the run's.
    expect(capCalls[3]?.input).toEqual({ env: 'local', tool: 'clickstack_table', args: { source: 's1' } })
  })

  test('healthy without a successful query of telemetry is degraded, with a warning', async () => {
    const none = await run(
      { investigation: 'is everything fine?' },
      new FakeAgentHost(async () => ({ output: answer({ status: 'healthy', findings: [] }) })),
    )
    const a = OtelOutput.parse(none.result.output)
    expect(a.status).toBe('degraded')
    expect(a.hyperdx).toEqual({ connected: false, reason: 'the agent made no call' })
    expect(a.warnings).toEqual([
      'healthy was not supported: no query of telemetry succeeded in this run, so health is unconfirmed',
    ])

    // Reading sources and schemas is not looking at telemetry.
    const metadata = await run(
      { investigation: 'is everything fine?' },
      new FakeAgentHost(async (s) => {
        await query(s, 'clickstack_list_sources')
        await query(s, 'clickstack_search') // answers isError
        return { output: answer({ status: 'healthy', findings: [] }) }
      }),
    )
    const b = OtelOutput.parse(metadata.result.output)
    expect(b.status).toBe('degraded')
    expect(b.hyperdx).toEqual({ connected: true })
    expect(b.queries.map((q) => q.ok)).toEqual([true, false])
    expect(b.queries[1]?.error).toContain('unknown column')

    // A data query that worked supports healthy.
    const data = await run(
      { investigation: 'is everything fine?' },
      new FakeAgentHost(async (s) => {
        await query(s, 'clickstack_table', { source: 's1' })
        return {
          output: answer({
            status: 'healthy',
            findings: [{ service: 'checkout', summary: 'flowing', severity: 'info', evidence: 'q1: 2 services' }],
          }),
        }
      }),
    )
    const c = OtelOutput.parse(data.result.output)
    expect(c.status).toBe('healthy')
    expect(c.warnings).toEqual([])
  })

  test('calls that all fail: not connected, with the first reason; errors is kept but warned', async () => {
    const { result } = await run(
      { investigation: 'checkout errors' },
      new FakeAgentHost(async (s) => {
        const failed = await query(s, 'clickstack_timeseries')
        expect(failed.ok).toBe(false)
        return { output: answer({ findings: [] }) }
      }),
    )
    const out = OtelOutput.parse(result.output)
    expect(out.hyperdx).toEqual({ connected: false, reason: 'hdx prod unreachable' })
    expect(out.status).toBe('errors')
    expect(out.warnings).toEqual(['errors rests on no successful query of telemetry in this run'])
  })

  test('a non-JSON answer gets one re-ask (otel:reask) in the same session, a second one is invalid_output', async () => {
    const host = new FakeAgentHost(async (s) => {
      if (!s.turnOf) {
        await query(s, 'clickstack_table', { source: 's1' })
        return { output: 'checkout has errors.' }
      }
      return { output: answer() }
    })
    const { runId, result } = await run({ investigation: 'checkout errors' }, host)
    expect(result.status).toBe('done')
    expect(OtelOutput.parse(result.output).queries).toHaveLength(1)
    expect((await sql.step(runId, 'otel:reask'))?.status).toBe('done')

    const never = await run(
      { investigation: 'checkout errors, never JSON' },
      new FakeAgentHost(async () => ({ output: 'still prose' })),
    )
    expect(never.result.status).toBe('failed')
    expect(never.result.error?.kind).toBe('invalid_output')
  })

  test('the input is strict; the env defaults to prod; a window is a duration or an ordered absolute range', () => {
    expect(OtelInput.parse({ investigation: 'checkout errors' }).env).toBe('prod')
    expect(OtelInput.safeParse({ investigation: 'checkout errors', extra: 1 }).success).toBe(false)
    expect(OtelInput.safeParse({ investigation: 'checkout errors', env: 'staging' }).success).toBe(false)
    for (const since of ['30m', '2h', '7d', '2026-10-27T08:00:00Z/2026-10-27T10:00:00Z'])
      expect(OtelInput.safeParse({ investigation: 'checkout errors', since }).success).toBe(true)
    for (const since of ['', 'yesterday', '0h', '2w', '2026-10-27T10:00:00Z/2026-10-27T08:00:00Z', 'a/b', '1h/2h'])
      expect(OtelInput.safeParse({ investigation: 'checkout errors', since }).success).toBe(false)
    expect(OTEL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/)
  })

  test('a duration is resolved against the run’s journaled start, so the agent has a clock', () => {
    expect(windowLine('2h', '2026-10-27T10:00:00.000Z')).toBe(
      'The last 2h: 2026-10-27T08:00:00.000Z to 2026-10-27T10:00:00.000Z (UTC).',
    )
    expect(windowLine(undefined, '2026-10-27T10:00:00.000Z')).toContain('Now is 2026-10-27T10:00:00.000Z')
  })
})

describe('the grant', () => {
  test('holds only agent-safe hdx capabilities, none of them mutating, all registered', () => {
    const registry = createRegistry(createCapabilities({ transports: fakeTransports({}), env: {} }))
    for (const id of Object.values(OTEL_TOOLS)) {
      expect(AGENT_SAFE_HDX as readonly string[]).toContain(id)
      expect(registry.capabilities.find((c) => c.id === id)?.cli.mutating).toBe(false)
    }
    expect(Object.keys(OTEL_TOOLS)).toEqual(['hdx_tools', 'hdx_guide', 'hdx_query'])
  })

  test('the otel workflow and its agent are registered on their route', () => {
    expect(workflows[0]?.agents).toEqual([{ agent: 'otel', route: 'otel.agent' }])
  })
})

describe('assemble and grounding', () => {
  const call = (id: string, over: Partial<Recorded['query']> = {}, text = '', data = true): Recorded => ({
    query: {
      id,
      tool: 'hdx_query',
      target: 'clickstack_table',
      argsDigest: 'abc',
      ok: true,
      chars: text.length,
      ...over,
    },
    text,
    data,
  })
  const draft: Draft = { status: 'errors', timeRange: 'last 1h', findings: [], recommendations: [] }

  test('evidence rests on a worked query by id, or on something specific in its answer', () => {
    const calls = [call('q1', {}, `{"trace":"${TRACE}","msg":"${ERROR_LOG}"}`), call('q2', { ok: false })]
    expect(isGrounded('q1: 12 rows', calls)).toBe(true)
    expect(isGrounded('see Q1', calls)).toBe(true)
    expect(isGrounded('q2: failed', calls)).toBe(false) // a failed query supports nothing
    expect(isGrounded('q7', calls)).toBe(false) // no such query
    expect(isGrounded(`trace ${TRACE}`, calls)).toBe(true)
    expect(isGrounded(`log "Connection REFUSED:  payments-db:5432"`, calls)).toBe(true)
    expect(isGrounded('trace 00000000000000000000000000000000', calls)).toBe(false)
    expect(isGrounded('it just looked slow', calls)).toBe(false)
    expect(isGrounded(undefined, calls)).toBe(false)
    expect(isGrounded('  ', calls)).toBe(false)
  })

  test('a discovery call is not a query: t1 grounds nothing', () => {
    const calls = [call('t1', { tool: 'hdx_tools', target: undefined }, 'clickstack_table summary', false)]
    expect(isGrounded('t1: the tool exists', calls)).toBe(false)
    expect(isGrounded('clickstack_table summary here', calls)).toBe(false)
  })

  test('the status is the agent’s unless it is healthy without telemetry', () => {
    const f = [{ service: 's', summary: 'x', severity: 'info' as const, evidence: 'q1' }]
    expect(assemble({ ...draft, status: 'healthy', findings: f }, 'prod', [call('q1')]).status).toBe('healthy')
    expect(assemble({ ...draft, status: 'healthy', findings: f }, 'prod', [call('q1', {}, '', false)]).status).toBe(
      'degraded',
    )
    expect(assemble({ ...draft, status: 'degraded' }, 'prod', []).status).toBe('degraded')
  })

  test('rows are read from a list or from an object holding one', () => {
    expect(rowsOf('[1,2,3]')).toBe(3)
    expect(rowsOf('{"rows":[1]}')).toBe(1)
    expect(rowsOf('{"data":[]}')).toBe(0)
    expect(rowsOf('not json')).toBeUndefined()
    expect(rowsOf('{"a":1}')).toBeUndefined()
  })
})
