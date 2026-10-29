import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Json, ScoreJudge } from '@agent-workflows/runtime'
import { FakeAgentHost, type FakeSession } from '@agent-workflows/runtime/testing'
import type { HostRegistry } from '../src/workflows/index.ts'
import { createEngineClient, EngineJobFailed, runEngineJob } from '../src/workflows/research/engine.ts'
import { MAX_BODY_BYTES, ToolGate } from '../src/workflows/research/gate.ts'
import { memoryToolLedger, pgToolLedger } from '../src/workflows/research/ledger.ts'
import { matchExpect } from '../src/workflows/research/golden.ts'
import { createResearchWorkflows } from '../src/workflows/research/index.ts'
import { ResearchOutput, type ResearchResult } from '../src/workflows/research/schema.ts'
import { researchScorer } from '../src/workflows/research/scorer.ts'
import { freshSchema, inspector, testRuntime } from '../../runtime/test/support/pg.ts'

const db = freshSchema('research')
const sql = inspector(db.schema)
const stateDir = mkdtempSync(join(tmpdir(), 'agw-research-'))

const PG_DOCS = 'https://www.postgresql.org/docs/current/runtime-config-connection.html'
const NEVER_READ = 'https://example.com/never-read'

/**
 * research-gateway's REST surface, in memory: a job finishes on its second poll; a query with FAIL ends `error`
 * (no report, no cost), one with FLAKY ends `error` on its first job only, one with SLOW finishes 11 s after it was
 * submitted. A submit with a known key answers that job with its status, as the engine does.
 */
function fakeEngine() {
  const jobs = new Map<
    string,
    { body: Record<string, unknown>; polls: number; at: number; status: 'running' | 'done' | 'error' }
  >()
  const auth: (string | null)[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      auth.push(req.headers.get('authorization'))
      const url = new URL(req.url)
      if (req.method === 'POST' && url.pathname === '/research') {
        const body = (await req.json()) as Record<string, unknown>
        const known = [...jobs].find(([, j]) => j.body.idempotencyKey === body.idempotencyKey)
        if (known) return Response.json({ jobId: known[0], status: known[1].status })
        const jobId = `job-${jobs.size + 1}`
        jobs.set(jobId, { body, polls: 0, at: Date.now(), status: 'running' })
        return Response.json({ jobId, status: 'queued' })
      }
      const job = jobs.get(url.pathname.split('/').pop() ?? '')
      if (!job) return Response.json({ error: 'not found' }, { status: 404 })
      job.polls++
      const query = String(job.body.query)
      const firstOfItsQuery = [...jobs.values()].find((j) => j.body.query === job.body.query) === job
      if (query.includes('FAIL') || (query.includes('FLAKY') && firstOfItsQuery)) {
        job.status = 'error'
        return Response.json({ status: 'error', depth: 'quick', error: 'worker crashed' })
      }
      const slow =
        (query.includes('SLOW') && Date.now() - job.at < 11_000) ||
        (query.includes('LAGGY') && Date.now() - job.at < 300)
      if (job.polls < 2 || slow) return Response.json({ status: 'running', depth: 'quick' })
      job.status = 'done'
      return Response.json({
        status: 'done',
        depth: 'quick',
        result: {
          report: `## Bottom line\nPostgreSQL listens on 5432 (${String(job.body.query)}).`,
          citations: [{ claim: 'The default port is 5432', url: PG_DOCS, confidence: 'high' }],
          sources: [PG_DOCS],
          unverified: [],
          status: 'ok',
          warnings: [],
          grounding: { pagesRetrieved: 2, pagesMissing: 0, pagesFailed: 1, citationsKept: 1, citationsDropped: 1 },
          cost: { wallMs: 900, totalUsd: 0.04, llmUsd: 0.03, searchUsd: 0.01 },
        },
      })
    },
  })
  return { server, jobs, auth, url: `http://127.0.0.1:${server.port}` }
}

const engine = fakeEngine()
const capCalls: { id: string; input: Json }[] = []

/** The platform's `web.*` capabilities, canned (the contract of `w6/web-capabilities`). */
async function fakeCapability(id: string, input: Json, scope: { addUsage: (u: never) => void }): Promise<Json> {
  capCalls.push({ id, input })
  scope.addUsage({
    model: id,
    tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
    cost: 0.001,
    costSource: 'rate',
  } as never)
  if (id === 'web.search')
    return {
      results: [{ url: PG_DOCS, title: 'Connections', snippet: 'port (integer) default 5432' }],
      provider: 'sonar',
    }
  if (id === 'web.fetch') {
    const url = (input as { url: string }).url
    if (url.includes('broken')) throw new Error('fetch refused: private address')
    return { url, finalUrl: url, title: 'Connections', text: 'The default is 5432.', truncated: false, via: 'direct' }
  }
  throw new Error(`unexpected capability ${id}`)
}

const ledger = pgToolLedger(sql.pool, db.schema)
const gate = new ToolGate({
  stateDir,
  ledger,
  engine: () => createEngineClient({ url: engine.url, token: 'engine-token' }),
  call: fakeCapability,
  enginePollMs: 5,
  // The fake host's session ids are not OpenCode's: the fake agent sends its step key as the session id.
  belongsTo: (sessionId, stepKey) => sessionId === stepKey,
})

/** What the plugin does: POST the tool call with the session id and the key from gate.json. */
async function callTool(session: FakeSession, tool: string, args: Record<string, Json>) {
  const { url, key } = (await Bun.file(join(stateDir, 'research', 'gate.json')).json()) as { url: string; key: string }
  const response = await fetch(`${url}/tool/${tool}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionID: session.root.spec.key, args }),
  })
  return (await response.json()) as { ok: boolean; result?: Json; error?: string }
}

const draft = (citations: { claim: string; url: string }[]) =>
  JSON.stringify({
    report: '## Bottom line\nThe default port is 5432.',
    citations: citations.map((c) => ({ ...c, confidence: 'high' })),
    sources: [PG_DOCS],
    unverified: [],
  })

const workflows = createResearchWorkflows(
  { registry: {} as HostRegistry },
  {
    stateDir,
    gate,
    ledger,
    enginePollMs: 5,
    agentBackoffMs: 10,
    env: {},
    engine: createEngineClient({ url: engine.url, token: 'engine-token' }),
  },
)
const research = workflows[0]?.workflow as NonNullable<(typeof workflows)[0]>['workflow']

async function run(input: Record<string, Json>, host: FakeAgentHost) {
  const rt = testRuntime({ schema: db.schema, workflows: [research], host })
  await rt.open()
  try {
    const { runId } = await rt.start(research, input, { purpose: 'build' })
    return { runId, result: await rt.wait(runId) }
  } finally {
    await rt.close()
  }
}

beforeAll(async () => {
  const rt = testRuntime({ schema: db.schema, workflows: [] })
  await rt.open()
  await rt.close()
})
afterAll(async () => {
  await gate.close()
  void engine.server.stop(true)
  await sql.close()
  await db.drop()
  rmSync(stateDir, { recursive: true, force: true })
})

describe('research workflow, every arm on a fake host', () => {
  test('engine: one job over REST, keyed by the step, its report and cost recorded', async () => {
    const { runId, result } = await run(
      { query: 'What is the default port of PostgreSQL?', depth: 'quick', design: 'engine' },
      new FakeAgentHost(),
    )
    expect(result.status).toBe('done')
    const out = ResearchOutput.parse(result.output)
    expect(out.arm).toEqual({ design: 'engine', profile: null })
    expect(out.grounding).toEqual({ source: 'engine', citations: 2, grounded: 1, pagesRetrieved: 2, pagesFailed: 1 })
    expect(out.engine?.costUsd).toBe(0.04)
    const job = [...engine.jobs.values()].find((j) => j.body.idempotencyKey === `${runId}:engine`)
    expect(job?.body).toMatchObject({ query: 'What is the default port of PostgreSQL?', depth: 'quick' })
    expect(engine.auth.every((a) => a === 'Bearer engine-token')).toBe(true)
    const step = await sql.step(runId, 'engine')
    expect(step?.status).toBe('done')
    expect(Number(step?.cost)).toBeCloseTo(0.04)
  })

  test('agent focused: tools go through the gate, an unread citation is dropped, the cost lands on the run', async () => {
    const host = new FakeAgentHost(async (s) => {
      if (s.turnOf) throw new Error('no re-ask expected')
      const search = await callTool(s, 'web_search', { query: 'postgres default port' })
      const fetched = await callTool(s, 'web_fetch', { url: PG_DOCS })
      const docs = await callTool(s, 'web_docs', { library: 'postgres' })
      expect([search.ok, fetched.ok, docs.ok]).toEqual([true, true, false])
      expect(docs.error).toBe('web_docs is not granted to this agent')
      return {
        output: draft([
          { claim: 'default 5432', url: `${PG_DOCS}#port` },
          { claim: 'made up', url: NEVER_READ },
        ]),
      }
    })
    const { runId, result } = await run(
      { query: 'What is the default port of PostgreSQL?', depth: 'quick', design: 'agent', profile: 'focused' },
      host,
    )
    expect(result.status).toBe('done')
    const out: ResearchResult = ResearchOutput.parse(result.output)
    expect([...host.sessions.values()][0]?.spec.agent).toBe('research-agent-focused')
    expect(out.citations.map((c) => c.url)).toEqual([`${PG_DOCS}#port`])
    expect(out.unverified).toEqual([
      { topic: 'made up', url: NEVER_READ, reason: 'cited, but the page was never retrieved this run' },
    ])
    expect(out.status).toBe('partial')
    expect(out.grounding).toEqual({ source: 'tools', citations: 2, grounded: 1, pagesRetrieved: 1, pagesFailed: 0 })
    expect(out.tools).toEqual({ web_search: 1, web_fetch: 1 })
    expect(out.sources).toEqual([PG_DOCS])
    const evidence = await sql.step(runId, 'tools')
    expect(Number(evidence?.cost)).toBeCloseTo(0.002)
  })

  test('pilot yolo: engine quick jobs as a tool; their sources count as retrieved, their cost on the run', async () => {
    const host = new FakeAgentHost(async (s) => {
      const answer = await callTool(s, 'engine_research', { question: 'Default TCP port of PostgreSQL?' })
      expect(answer.ok).toBe(true)
      expect((answer.result as { citations: unknown[] }).citations).toHaveLength(1)
      return { output: draft([{ claim: 'default 5432', url: PG_DOCS }]) }
    })
    const { runId, result } = await run(
      { query: 'What is the default port of PostgreSQL?', depth: 'standard', design: 'pilot', profile: 'yolo' },
      host,
    )
    expect(result.status).toBe('done')
    const out = ResearchOutput.parse(result.output)
    expect(out.status).toBe('ok')
    expect(out.grounding.grounded).toBe(1)
    expect(out.engine?.jobs).toHaveLength(1)
    expect(out.engine?.costUsd).toBe(0.04)
    expect(Number((await sql.step(runId, 'tools'))?.cost)).toBeCloseTo(0.04)
    const job = [...engine.jobs.values()].find((j) =>
      String(j.body.idempotencyKey).startsWith(`${runId}:research:engine:`),
    )
    expect(job?.body.depth).toBe('quick')
  })

  test('a non-JSON answer gets one re-ask in the same session', async () => {
    const host = new FakeAgentHost(async (s) => {
      if (!s.turnOf) {
        await callTool(s, 'web_search', { query: 'postgres port' })
        return { output: 'The port is 5432.' }
      }
      return { output: draft([{ claim: 'default 5432', url: PG_DOCS }]) }
    })
    const { runId, result } = await run(
      { query: 'What is the default port of PostgreSQL?', depth: 'quick', design: 'agent', profile: 'yolo' },
      host,
    )
    expect(result.status).toBe('done')
    expect(ResearchOutput.parse(result.output).citations).toHaveLength(1)
    expect((await sql.step(runId, 'research:reask'))?.status).toBe('done')
  })

  test('a session without a grant is refused, and so is a wrong key', async () => {
    const { url } = (await Bun.file(join(stateDir, 'research', 'gate.json')).json()) as { url: string }
    const noKey = await fetch(`${url}/tool/web_search`, { method: 'POST', body: '{}' })
    expect(noKey.status).toBe(401)
    const fake = { root: { spec: { key: 'nobody:research' } } } as unknown as FakeSession
    expect(await callTool(fake, 'web_search', { query: 'x' })).toEqual({
      ok: false,
      error: 'this session holds no research grant',
    })
  })
})

describe('the tool gate ledger: evidence the decision rests on', () => {
  test("a retried agent step keeps the first attempt's calls and cost; reading the ledger never consumes it", async () => {
    let attempt = 0
    const host = new FakeAgentHost(async (s) => {
      attempt++
      if (attempt === 1) {
        await callTool(s, 'web_fetch', { url: PG_DOCS })
        throw new Error('the session died')
      }
      await callTool(s, 'web_search', { query: 'postgres port' })
      return { output: draft([{ claim: 'default 5432', url: PG_DOCS }]) }
    })
    const { runId, result } = await run(
      { query: 'What is the default port of PostgreSQL?', depth: 'quick', design: 'agent', profile: 'focused' },
      host,
    )
    expect(result.status).toBe('done')
    const out = ResearchOutput.parse(result.output)
    expect(out.tools).toEqual({ web_fetch: 1, web_search: 1 })
    expect(out.grounding.pagesRetrieved).toBe(1)
    expect(Number((await sql.step(runId, 'tools'))?.cost)).toBeCloseTo(0.002)
    const first = await ledger.read(runId, 'research')
    expect(first.map((e) => e.tool)).toEqual(['web_fetch', 'web_search'])
    expect(await ledger.read(runId, 'research')).toEqual(first)
  })

  test("a run's ledger rows go with the run (foreign key, on delete cascade); args digests are canonical", async () => {
    const host = new FakeAgentHost(async (s) => {
      await callTool(s, 'web_search', { query: 'postgres port', maxResults: 3 })
      return { output: draft([]) }
    })
    const { runId } = await run({ query: 'Postgres port?', depth: 'quick', design: 'agent', profile: 'focused' }, host)
    const [row] = await ledger.read(runId, 'research')
    const { createHash } = await import('node:crypto')
    const { canonicalJson } = await import('../src/canonical.ts')
    expect(row?.argsDigest).toBe(
      createHash('sha256')
        .update(canonicalJson({ maxResults: 3, query: 'postgres port' }))
        .digest('hex'),
    )
    await sql.pool.query(`delete from "${db.schema}".runs where id = $1`, [runId])
    expect(await ledger.read(runId, 'research')).toEqual([])
  })

  test('a failed engine job is booked at what the engine reported: unknown, never 0', async () => {
    const { runId, result } = await run(
      { query: 'FAIL this question', depth: 'quick', design: 'engine' },
      new FakeAgentHost(),
    )
    expect(result.status).toBe('failed')
    const step = await sql.step(runId, 'engine')
    expect(step?.cost).toBeNull()
    expect(Number(step?.unpriced_calls)).toBe(1)
  })

  test('pilot: a repeated question adopts its engine job and is booked once; a failed job leaves the cost unknown', async () => {
    const host = new FakeAgentHost(async (s) => {
      await callTool(s, 'engine_research', { question: 'Default TCP port of PostgreSQL?' })
      await callTool(s, 'engine_research', { question: 'Default TCP port of PostgreSQL?' })
      return { output: draft([{ claim: 'default 5432', url: PG_DOCS }]) }
    })
    const { runId, result } = await run(
      { query: 'Postgres port?', depth: 'quick', design: 'pilot', profile: 'focused' },
      host,
    )
    const out = ResearchOutput.parse(result.output)
    expect(out.engine).toEqual({ jobs: [expect.any(String)], costUsd: 0.04 })
    expect(Number((await sql.step(runId, 'tools'))?.cost)).toBeCloseTo(0.04)

    const failing = new FakeAgentHost(async (s) => {
      const answer = await callTool(s, 'engine_research', { question: 'FAIL: what breaks?' })
      expect(answer).toMatchObject({ ok: false })
      return { output: draft([]) }
    })
    const second = await run({ query: 'What breaks?', depth: 'quick', design: 'pilot', profile: 'focused' }, failing)
    expect(ResearchOutput.parse(second.result.output).engine).toEqual({ jobs: [expect.any(String)], costUsd: null })
    const evidence = await sql.step(second.runId, 'tools')
    expect(evidence?.cost).toBeNull()
    expect(Number(evidence?.unpriced_calls)).toBe(1)
  })

  test("engine_research holds its request past Bun's 10 s idle cut", async () => {
    const host = new FakeAgentHost(async (s) => {
      const answer = await callTool(s, 'engine_research', { question: 'SLOW: default port of PostgreSQL?' })
      expect(answer.ok).toBe(true)
      return { output: draft([{ claim: 'default 5432', url: PG_DOCS }]) }
    })
    const { result } = await run({ query: 'Postgres port?', depth: 'quick', design: 'pilot', profile: 'focused' }, host)
    expect(result.status).toBe('done')
  }, 30_000)

  test('a body over the byte cap is refused before it is buffered, by its length or while it streams', async () => {
    const { url, key } = (await Bun.file(join(stateDir, 'research', 'gate.json')).json()) as {
      url: string
      key: string
    }
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
    const big = 'x'.repeat(MAX_BODY_BYTES + 1)
    expect((await fetch(`${url}/tool/web_search`, { method: 'POST', headers, body: big })).status).toBe(413)
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 3; i++) controller.enqueue(new TextEncoder().encode('y'.repeat(MAX_BODY_BYTES / 2)))
        controller.close()
      },
    })
    const streamed = await fetch(`${url}/tool/web_search`, { method: 'POST', headers, body: stream })
    expect(streamed.status).toBe(413)
  })

  test('a cancelled run keeps the spend its tools booked (on the tools step)', async () => {
    let called!: () => void
    const toolCalled = new Promise<void>((resolve) => {
      called = resolve
    })
    const host = new FakeAgentHost(async (s) => {
      await callTool(s, 'web_search', { query: 'postgres port' })
      called()
      await s.sleep(60_000)
      return { output: draft([]) }
    })
    const rt = testRuntime({ schema: db.schema, workflows: [research], host })
    await rt.open()
    try {
      const { runId } = await rt.start(
        research,
        { query: 'Postgres port?', depth: 'quick', design: 'agent', profile: 'focused' },
        { purpose: 'build' },
      )
      await toolCalled
      await rt.cancel(runId)
      expect((await rt.wait(runId)).status).toBe('cancelled')
      const tools = await sql.step(runId, 'tools')
      expect(tools?.status).toBe('cancelled')
      expect(Number(tools?.cost)).toBeCloseTo(0.001)
    } finally {
      await rt.close()
    }
  })

  test('a ledger write that keeps failing is logged and never fails the call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agw-gate-ledger-'))
    const errors: string[] = []
    const own = new ToolGate({
      stateDir: dir,
      ledger: {
        append: () => Promise.reject(new Error('database down')),
        read: () => Promise.resolve([]),
      },
      engine: () => null,
      call: fakeCapability,
      belongsTo: (sessionId, stepKey) => sessionId === stepKey,
      logger: { warn: () => {}, error: (m) => errors.push(m) },
    })
    const close = own.open({ runId: 'r-ledger', stepId: 'research', tools: ['web_search'] })
    try {
      const { url, key } = (await Bun.file(join(dir, 'research', 'gate.json')).json()) as { url: string; key: string }
      const response = await fetch(`${url}/tool/web_search`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        body: JSON.stringify({ sessionID: 'r-ledger:research', args: { query: 'q' } }),
      })
      expect(((await response.json()) as { ok: boolean }).ok).toBe(true)
      expect(errors).toEqual(['research tool gate: the ledger write failed; the call stands without its evidence row'])
    } finally {
      await close()
      await own.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('closing a grant waits for the calls in flight, so their rows are written before evidence is read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agw-gate-drain-'))
    const memory = memoryToolLedger() // no run row for this grant: the Postgres ledger's foreign key would refuse it
    const own = new ToolGate({
      stateDir: dir,
      ledger: memory,
      engine: () => null,
      call: async (id, input, scope) => {
        await Bun.sleep(300)
        return fakeCapability(id, input, scope)
      },
      belongsTo: (sessionId, stepKey) => sessionId === stepKey,
    })
    const close = own.open({ runId: 'r-drain', stepId: 'research', tools: ['web_search'] })
    try {
      const { url, key } = (await Bun.file(join(dir, 'research', 'gate.json')).json()) as { url: string; key: string }
      const pending = fetch(`${url}/tool/web_search`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        body: JSON.stringify({ sessionID: 'r-drain:research', args: { query: 'q' } }),
      })
      await Bun.sleep(50)
      await close()
      expect((await memory.read('r-drain', 'research')).map((e) => e.tool)).toEqual(['web_search'])
      await pending
    } finally {
      await own.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('engine keys: a done job is adopted, a key whose job errored is stepped past and the question runs again', async () => {
    const client = createEngineClient({ url: engine.url, token: 'engine-token' })
    const job = (key: string) =>
      runEngineJob(
        client,
        { query: 'FLAKY: postgres port?', depth: 'quick', idempotencyKey: key },
        {
          signal: new AbortController().signal,
          pollMs: 5,
        },
      )
    const failure = await job('k-flaky').catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(EngineJobFailed)
    const second = await job('k-flaky')
    expect(second.jobId).not.toBe((failure as EngineJobFailed).jobId)
    const third = await job('k-flaky')
    expect(third.jobId).toBe(second.jobId)
  })

  test('an engine job is booked once: a second process on the same ledger adopts the job and books nothing', async () => {
    const memory = memoryToolLedger()
    const booked: (number | null | undefined)[] = []
    const make = (dir: string) =>
      new ToolGate({
        stateDir: dir,
        ledger: memory,
        engine: () => createEngineClient({ url: engine.url, token: 'engine-token' }),
        call: fakeCapability,
        enginePollMs: 5,
        belongsTo: (sessionId, stepKey) => sessionId === stepKey,
      })
    const ask = async (gateOf: ToolGate, dir: string) => {
      const close = gateOf.open({ runId: 'r-once', stepId: 'research', tools: ['engine_research'] })
      const unbind = gateOf.bindUsage('r-once', 'research', (u) => booked.push(u.cost))
      const { url, key } = (await Bun.file(join(dir, 'research', 'gate.json')).json()) as { url: string; key: string }
      const response = await fetch(`${url}/tool/engine_research`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        body: JSON.stringify({ sessionID: 'r-once:research', args: { question: 'Booked once: postgres port?' } }),
      })
      expect(((await response.json()) as { ok: boolean }).ok).toBe(true)
      unbind()
      await close()
      await gateOf.close()
    }
    const first = mkdtempSync(join(tmpdir(), 'agw-gate-a-'))
    const second = mkdtempSync(join(tmpdir(), 'agw-gate-b-'))
    await ask(make(first), first)
    await ask(make(second), second)
    expect(booked).toEqual([0.04])
    const { evidence } = await import('../src/workflows/research/gate.ts')
    const ev = evidence(await memory.read('r-once', 'research'))
    expect(ev).toMatchObject({ engineJobs: [expect.any(String)], engineCostUsd: 0.04 })
    for (const dir of [first, second]) rmSync(dir, { recursive: true, force: true })
  })

  test('an engine job in flight at the agent end is served first; one cut off is recorded and booked as abandoned', async () => {
    const memory = memoryToolLedger()
    const dir = mkdtempSync(join(tmpdir(), 'agw-gate-end-'))
    const own = new ToolGate({
      stateDir: dir,
      ledger: memory,
      engine: () => createEngineClient({ url: engine.url, token: 'engine-token' }),
      call: fakeCapability,
      enginePollMs: 5,
      belongsTo: (sessionId, stepKey) => sessionId === stepKey,
    })
    const ask = async (runId: string, end: (close: () => Promise<void>) => Promise<void>) => {
      const booked: (number | null | undefined)[] = []
      const close = own.open({ runId, stepId: 'research', tools: ['engine_research'] })
      const unbind = own.bindUsage(runId, 'research', (u) => booked.push(u.cost))
      const { url, key } = (await Bun.file(join(dir, 'research', 'gate.json')).json()) as { url: string; key: string }
      const pending = fetch(`${url}/tool/engine_research`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        body: JSON.stringify({ sessionID: `${runId}:research`, args: { question: `LAGGY ${runId}: postgres port?` } }),
      })
      await Bun.sleep(50) // the job is running when the agent ends
      await end(close)
      unbind()
      await pending
      return { booked, rows: await memory.read(runId, 'research') }
    }
    try {
      const served = await ask('r-end', async (close) => {
        await own.settle('r-end', 'research')
        await close()
      })
      expect(served.booked).toEqual([0.04])
      expect(served.rows).toMatchObject([{ ok: true, engineJob: expect.any(String), engineCostUsd: 0.04 }])

      const cut = await ask('r-cut', (close) => close())
      expect(cut.booked).toEqual([null])
      expect(cut.rows).toMatchObject([{ ok: false, engineJob: expect.any(String), engineCostUsd: null }])
      expect(cut.rows[0]?.error).toContain('abandoned')
    } finally {
      await own.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("close removes gate.json only while it holds this instance's key", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agw-gate-own-'))
    const file = join(dir, 'research', 'gate.json')
    const first = new ToolGate({ stateDir: dir, ledger, engine: () => null, call: fakeCapability })
    first.ensureServing()
    const bystander = new ToolGate({ stateDir: dir, ledger, engine: () => null, call: fakeCapability })
    await bystander.close()
    expect(await Bun.file(file).exists()).toBe(true)
    // A later host took the file over: the first one's close leaves it alone.
    const later = new ToolGate({ stateDir: dir, ledger, engine: () => null, call: fakeCapability })
    later.ensureServing()
    await first.close()
    expect(await Bun.file(file).exists()).toBe(true)
    await later.close()
    expect(await Bun.file(file).exists()).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('the Postgres ledger books an engine job once per step; a retried write finds its own claim', async () => {
    const pg = pgToolLedger(sql.pool, db.schema)
    const runId = 'r-claim'
    await sql.pool.query(
      `insert into "${db.schema}".runs (id, workflow, root_id, purpose, input, input_hash, lock_key, version_started)
       values ($1, 'research', $1, 'eval', '{}', 'h', 1, 1)`,
      [runId],
    )
    const entry = {
      runId,
      stepId: 'research',
      tool: 'engine_research',
      argsDigest: 'd',
      ok: true,
      retrieved: [],
      seen: [],
      engineJob: 'job-1',
      engineCostUsd: 0.04,
    }
    expect(await pg.append(entry, 'claim-a')).toBe(true)
    expect(await pg.append(entry, 'claim-b')).toBe(false)
    // claim-a's write landed but its acknowledgement was lost: the retry knows it booked, and writes no second row.
    expect(await pg.append(entry, 'claim-a')).toBe(true)
    expect(await pg.append({ ...entry, engineJob: 'job-2' }, 'claim-b')).toBe(true)
    expect(await pg.append({ ...entry, tool: 'web_search', engineJob: undefined }, 'claim-c')).toBe(false)
    expect((await pg.read(runId, 'research')).map((e) => e.engineJob ?? '-')).toEqual(['job-1', 'job-1', 'job-2', '-'])
  })

  test('close stops the gate and removes gate.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agw-gate-close-'))
    const own = new ToolGate({ stateDir: dir, ledger, engine: () => null, call: fakeCapability })
    own.ensureServing()
    const file = join(dir, 'research', 'gate.json')
    expect(await Bun.file(file).exists()).toBe(true)
    await own.close()
    expect(await Bun.file(file).exists()).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('research scorer', () => {
  const report = (over: Partial<ResearchResult> = {}): Json => ({
    report: '## Bottom line\nRFC 9110 assigns 413 to Content Too Large. hono 4.6.5 is current.',
    citations: [
      { claim: '413 is Content Too Large', url: 'https://www.rfc-editor.org/rfc/rfc9110', confidence: 'high' },
      { claim: 'same page again', url: 'https://www.rfc-editor.org/rfc/rfc9110', confidence: 'high' },
      { claim: 'dead page', url: 'https://example.com/dead', confidence: 'low' },
    ],
    sources: [],
    unverified: [],
    status: 'ok',
    warnings: [],
    grounding: { source: 'tools', citations: 4, grounded: 3, pagesRetrieved: 2, pagesFailed: 0 },
    arm: { design: 'agent', profile: 'yolo' },
    ...over,
  })
  const judgeCalls: string[] = []
  const judge: ScoreJudge = async (capability, input): Promise<Json> => {
    judgeCalls.push(capability)
    const i = input as Record<string, string>
    if (capability === 'web.package') return { name: i.name as string, latest: 'v4.6.5', url: 'https://x' }
    if (capability === 'web.fetch') {
      if (i.url?.includes('dead')) return { error: { code: 'UPSTREAM_ERROR', message: 'gone' } }
      return {
        url: i.url as string,
        finalUrl: i.url as string,
        text: 'Status 413 Content Too Large',
        truncated: false,
        via: 'direct',
      }
    }
    if (capability === 'decide')
      return {
        answers: { supported: { type: 'boolean', value: true, confidence: 0.9, probability: 0.9 } },
        model: 'd',
        truncatedChars: 0,
      }
    throw new Error(capability)
  }
  const ctx = { source: 'regression' as const, signal: new AbortController().signal }

  test('golden any/all and maxChars follow evals/lib.ts', async () => {
    const pass = await researchScorer.score({} as never, report(), {
      ...ctx,
      reference: { expect: { any: ['\\b413\\b'] } },
    })
    expect(pass.scores.golden).toBe(1)
    const all = await researchScorer.score({} as never, report(), {
      ...ctx,
      reference: { expect: { all: ['413', 'nope'] } },
    })
    expect(all.scores.golden).toBe(0)
    expect(all.pass).toBe(false)
    const long = await researchScorer.score({} as never, report(), {
      ...ctx,
      reference: { expect: { any: ['413'] }, maxChars: 10 },
    })
    expect(long.scores.golden).toBe(0)
    expect(matchExpect('Retry-After', { any: ['retry-after'] }, null).pass).toBe(true)
  })

  test('live: the registry value through the judge, a release tag without its v', async () => {
    const v = await researchScorer.score({} as never, report(), {
      ...ctx,
      judge,
      reference: { expect: { live: 'github-release:honojs/hono' } },
    })
    expect(v.scores.golden).toBe(1)
    const noJudge = await researchScorer.score({} as never, report(), {
      ...ctx,
      reference: { expect: { live: 'npm:hono' } },
    })
    expect(noJudge.scores.golden).toBeUndefined()
  })

  test('grounded from the code-counted ledger; supported over the judged citations, a dead page unscored', async () => {
    judgeCalls.length = 0
    const v = await researchScorer.score({} as never, report(), { ...ctx, judge })
    expect(v.scores.grounded).toBe(0.75)
    expect(v.scores.supported).toBe(1) // two distinct URLs: the RFC supports, the dead page is unscored
    expect(v.scores.judgedShare).toBe(0.5)
    expect(judgeCalls.filter((c) => c === 'web.fetch')).toHaveLength(2)
    const none = await researchScorer.score(
      {} as never,
      report({
        citations: [],
        grounding: { source: 'tools', citations: 0, grounded: 0, pagesRetrieved: 0, pagesFailed: 0 },
      }),
      { ...ctx, judge },
    )
    expect(none.scores.supported).toBe(0)
    expect(none.scores.grounded).toBeUndefined()
  })

  test('a typed decide error leaves the citation unscored; with none scored, supported is left out', async () => {
    const failingDecide: ScoreJudge = async (capability, input) =>
      capability === 'decide' ? { error: { code: 'UPSTREAM_ERROR', message: 'down' } } : judge(capability, input)
    const v = await researchScorer.score({} as never, report(), { ...ctx, judge: failingDecide })
    expect(v.scores.supported).toBeUndefined()
    expect(v.scores.judgedShare).toBe(0)
  })

  test('a typed web.package error or an unusable latest leaves golden unscored (no pass), never an infra error', async () => {
    const answers: Json[] = [{ error: { code: 'UPSTREAM_ERROR', message: 'not found' } }, { name: 'hono', latest: '' }]
    for (const answer of answers) {
      const v = await researchScorer.score({} as never, report(), {
        ...ctx,
        judge: async (capability, input) => (capability === 'web.package' ? answer : judge(capability, input)),
        reference: { expect: { live: 'npm:hono' } },
      })
      expect(v.scores.golden).toBeUndefined()
      expect(v.pass).toBe(false)
      expect(v.feedback).toContain('golden unscored')
    }
    const inline = await researchScorer.score({} as never, report(), {
      source: 'inline',
      signal: new AbortController().signal,
      reference: { expect: { live: 'npm:hono' } },
    })
    expect(inline.scores.golden).toBeUndefined()
    expect(inline.pass).toBe(false)
  })

  test('an invalid or failed output scores 0', async () => {
    const v = await researchScorer.score({} as never, null, { ...ctx, judge, reference: { expect: { any: ['x'] } } })
    expect(v).toEqual({
      scores: { valid: 0, complete: 0, golden: 0, supported: 0 },
      pass: false,
      feedback: 'the run failed',
    })
  })
})
