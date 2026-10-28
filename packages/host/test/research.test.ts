import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Json, ScoreJudge } from '@agent-workflows/runtime'
import { FakeAgentHost, type FakeSession } from '@agent-workflows/runtime/testing'
import type { HostRegistry } from '../src/workflows/index.ts'
import { createEngineClient } from '../src/workflows/research/engine.ts'
import { ToolGate } from '../src/workflows/research/gate.ts'
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

/** research-gateway's REST surface, in memory: every job finishes on its second poll. */
function fakeEngine() {
  const jobs = new Map<string, { body: Record<string, unknown>; polls: number }>()
  const auth: (string | null)[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      auth.push(req.headers.get('authorization'))
      const url = new URL(req.url)
      if (req.method === 'POST' && url.pathname === '/research') {
        const body = (await req.json()) as Record<string, unknown>
        const known = [...jobs].find(([, j]) => j.body.idempotencyKey === body.idempotencyKey)
        if (known) return Response.json({ jobId: known[0], status: 'running' })
        const jobId = `job-${jobs.size + 1}`
        jobs.set(jobId, { body, polls: 0 })
        return Response.json({ jobId, status: 'queued' })
      }
      const job = jobs.get(url.pathname.split('/').pop() ?? '')
      if (!job) return Response.json({ error: 'not found' }, { status: 404 })
      job.polls++
      if (job.polls < 2) return Response.json({ status: 'running', depth: 'quick' })
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

const gate = new ToolGate({
  stateDir,
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
  { stateDir, gate, enginePollMs: 5, env: {}, engine: createEngineClient({ url: engine.url, token: 'engine-token' }) },
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
  gate.close()
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
    const evidence = await sql.step(runId, 'evidence')
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
    expect(Number((await sql.step(runId, 'evidence'))?.cost)).toBeCloseTo(0.04)
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
      if (i.url?.includes('dead')) throw new Error('404')
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

  test('grounded from the code-counted ledger; supported on up to 3 distinct cited pages, a dead page unsupported', async () => {
    judgeCalls.length = 0
    const v = await researchScorer.score({} as never, report(), { ...ctx, judge })
    expect(v.scores.grounded).toBe(0.75)
    expect(v.scores.supported).toBe(0.5) // two distinct URLs: the RFC supports, the dead page does not
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

  test('an invalid or failed output scores 0', async () => {
    const v = await researchScorer.score({} as never, null, { ...ctx, judge, reference: { expect: { any: ['x'] } } })
    expect(v).toEqual({
      scores: { valid: 0, complete: 0, golden: 0, supported: 0 },
      pass: false,
      feedback: 'the run failed',
    })
  })
})
