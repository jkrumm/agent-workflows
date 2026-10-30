import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCapabilities, createRegistry } from '@agent-workflows/capabilities'
import { fakeTransports } from '@agent-workflows/capabilities/testing'
import { casesPath } from '@agent-workflows/eval'
import { defineWorkflow, type Json, type ScoreJudge } from '@agent-workflows/runtime'
import { FakeAgentHost, type FakeSession } from '@agent-workflows/runtime/testing'
import { fallbackRoute, resolveRoute } from '@agent-workflows/routes'
import { z } from 'zod'
import { loadAgentDefinitions } from '../src/agents.ts'
import { type CapabilityCall, ToolGate } from '../src/tool-gate/index.ts'
import { assemble, BRAIN_VERSION, createBrainWorkflows } from '../src/workflows/brain/index.ts'
import { BrainInput, BrainOutput, type BrainResult } from '../src/workflows/brain/schema.ts'
import { brainScorer } from '../src/workflows/brain/scorer.ts'
import { BRAIN_TOOLS, brainGrant, evidence } from '../src/workflows/brain/tools.ts'
import { readSuite } from '../src/workflows/eval/suites.ts'
import { type HostRegistry, hostModules, suitesOf } from '../src/workflows/index.ts'
import { freshSchema, inspector, testRuntime } from '../../runtime/test/support/pg.ts'
import { memoryToolLedger, pgToolLedger } from '../src/workflows/research/ledger.ts'

const HOST_SUITES = suitesOf(await hostModules())

const db = freshSchema('brain')
const sql = inspector(db.schema)
const root = mkdtempSync(join(tmpdir(), 'agw-brain-wf-'))
const vault = join(root, 'vault')
const stateDir = join(root, 'state')

const ROUTING = 'wiki/engineering/model-routing.md'
const PINNING = 'wiki/engineering/pinning.md'
const INVENTED = 'wiki/engineering/never-read.md'

const note = (path: string, text: string) => {
  mkdirSync(join(vault, path, '..'), { recursive: true })
  writeFileSync(join(vault, path), text)
}

// The real brain capabilities on a temp vault, behind the real registry: the gate runs what production runs.
const registry = createRegistry(
  createCapabilities({ transports: fakeTransports({}), env: {} }, {}, {}, { env: { AGW_BRAIN_DIR: vault } }),
)
const gate = new ToolGate({
  stateDir,
  call: (id, input, scope) => (registry as unknown as { call: CapabilityCall }).call(id, input, scope),
  // The fake host's session ids are not OpenCode's: the fake agent sends its step key as the session id.
  belongsTo: (sessionId, stepKey) => sessionId === stepKey,
})

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

const answer = (citations: { path: string; claim: string }[], extra: Record<string, Json> = {}) =>
  JSON.stringify({ found: true, answer: 'Two billing lanes.', citations, ...extra })

const ledger = pgToolLedger(sql.pool, db.schema)
const deps = { registry: {} as HostRegistry, toolGate: gate }
const [brainEntry] = createBrainWorkflows(deps, { ledger, agentBackoffMs: 10 })
const brain = brainEntry?.workflow as NonNullable<typeof brainEntry>['workflow']

async function run(input: Record<string, Json>, host: FakeAgentHost) {
  const rt = testRuntime({ schema: db.schema, workflows: [brain], host })
  await rt.open()
  try {
    const { runId } = await rt.start(brain, input, { purpose: 'build' })
    return { runId, result: await rt.wait(runId) }
  } finally {
    await rt.close()
  }
}

beforeAll(async () => {
  note('index.md', '# Home\n')
  note(ROUTING, '---\ntype: Concept\ntitle: Model routing\n---\n# Model routing\n\nTwo billing lanes.\n')
  note(PINNING, '---\ntype: Concept\n---\nPin versions with a lockfile.\n')
  note('Inbox/raw.md', 'inbox secret\n')
  mkdirSync(join(root, 'outside'))
  writeFileSync(join(root, 'outside', 'secret.md'), 'outside secret\n')
  symlinkSync(join(root, 'outside', 'secret.md'), join(vault, 'wiki', 'escape.md'))
  const rt = testRuntime({ schema: db.schema, workflows: [] })
  await rt.open()
  await rt.close()
})
afterAll(async () => {
  await gate.close()
  await sql.close()
  await db.drop()
  rmSync(root, { recursive: true, force: true })
})

describe('brain workflow on a fake host', () => {
  test('the vault tools go through the gate; only notes the run read stay cited; usage lands on the run', async () => {
    const host = new FakeAgentHost(async (s) => {
      if (s.turnOf) throw new Error('no re-ask expected')
      const found = await callTool(s, 'brain_search', { query: 'billing' })
      expect(found.ok).toBe(true)
      const byPath = await callTool(s, 'brain_read', { note: ROUTING })
      const byLink = await callTool(s, 'brain_read', { note: '[[pinning]]' })
      expect([byPath.result, byLink.result]).toMatchObject([
        { found: true, path: ROUTING },
        { found: true, path: PINNING },
      ])
      const refused = await Promise.all([
        callTool(s, 'brain_read', { note: 'Inbox/raw.md' }),
        callTool(s, 'brain_read', { note: 'wiki/escape.md' }),
        callTool(s, 'brain_read', { note: '../outside/secret.md' }),
      ])
      expect(refused.map((r) => (r.result as { found: boolean }).found)).toEqual([false, false, false])
      expect(JSON.stringify(refused)).not.toContain('secret\\n')
      // Tools outside the grant, even a real platform capability, are refused before any capability runs.
      expect(await callTool(s, 'web_search', { query: 'x' })).toMatchObject({ ok: false, code: 'not_granted' })
      return {
        output: answer([
          { path: ROUTING, claim: 'two billing lanes' },
          { path: `./${PINNING}`, claim: 'pin with a lockfile' },
          { path: INVENTED, claim: 'made up' },
          { path: 'Inbox/raw.md', claim: 'refused, never read' },
        ]),
      }
    })
    const { runId, result } = await run({ question: 'How many billing lanes are there?' }, host)
    expect(result.status).toBe('done')
    const out: BrainResult = BrainOutput.parse(result.output)
    expect([...host.sessions.values()][0]?.spec.agent).toBe('brain')
    expect(out.read).toEqual([ROUTING, PINNING])
    expect(out.citations).toEqual([
      { path: ROUTING, claim: 'two billing lanes' },
      { path: PINNING, claim: 'pin with a lockfile' },
    ])
    expect(out.warnings).toEqual(['2 citation(s) dropped: the note was not read this run'])
    expect(out.status).toBe('partial')
    expect(out.grounding).toEqual({ citations: 4, grounded: 2 })
    expect(Object.keys(out).sort()).toEqual(['answer', 'citations', 'grounding', 'read', 'status', 'warnings'])
    const tools = await sql.step(runId, 'tools')
    expect(tools?.status).toBe('done')
    expect(Number(tools?.cost)).toBe(0)
    // The ledger holds one row per call, reads keep the note they opened.
    const rows = await ledger.read(runId, 'brain')
    expect(rows.map((r) => r.tool)).toEqual(
      Array(6).fill('brain_search').slice(0, 1).concat(Array(5).fill('brain_read')),
    )
    expect(evidence(rows)).toEqual({ read: [ROUTING, PINNING], counts: { brain_search: 1, brain_read: 5 } })
  })

  test('every citation read: ok with no warning', async () => {
    const host = new FakeAgentHost(async (s) => {
      await callTool(s, 'brain_read', { note: ROUTING })
      return { output: answer([{ path: ROUTING, claim: 'two billing lanes' }]) }
    })
    const { result } = await run({ question: 'How many billing lanes are there?' }, host)
    const out = BrainOutput.parse(result.output)
    expect(out.status).toBe('ok')
    expect(out.warnings).toEqual([])
    expect(out.citations).toHaveLength(1)
  })

  test('a search hit alone does not ground a citation', async () => {
    const host = new FakeAgentHost(async (s) => {
      await callTool(s, 'brain_search', { query: 'lockfile' })
      return { output: answer([{ path: PINNING, claim: 'pin with a lockfile' }]) }
    })
    const { result } = await run({ question: 'How do I pin versions?' }, host)
    const out = BrainOutput.parse(result.output)
    expect(out).toMatchObject({ status: 'partial', citations: [], read: [], grounding: { citations: 1, grounded: 0 } })
    expect(out.warnings).toEqual(['1 citation(s) dropped: the note was not read this run', 'nothing was read this run'])
  })

  test("the vault does not answer: notfound, with the agent's own words", async () => {
    const host = new FakeAgentHost(async (s) => {
      await callTool(s, 'brain_search', { query: 'unobtainium' })
      return { output: JSON.stringify({ found: false, answer: 'Not in the vault.', citations: [] }) }
    })
    const { result } = await run({ question: 'What is the boiling point of unobtainium?' }, host)
    expect(BrainOutput.parse(result.output)).toEqual({
      answer: 'Not in the vault.',
      citations: [],
      read: [],
      status: 'notfound',
      warnings: [],
      grounding: { citations: 0, grounded: 0 },
    })
  })

  test('a non-JSON answer gets one re-ask in the same session (brain:reask), a second one is invalid_output', async () => {
    const host = new FakeAgentHost(async (s) => {
      if (!s.turnOf) {
        await callTool(s, 'brain_read', { note: ROUTING })
        return { output: 'There are two billing lanes.' }
      }
      return { output: answer([{ path: ROUTING, claim: 'two billing lanes' }]) }
    })
    const { runId, result } = await run({ question: 'How many billing lanes are there?' }, host)
    expect(result.status).toBe('done')
    expect(BrainOutput.parse(result.output).citations).toHaveLength(1)
    expect((await sql.step(runId, 'brain:reask'))?.status).toBe('done')

    const never = await run(
      { question: 'Billing lanes, never JSON?' },
      new FakeAgentHost(async () => ({ output: 'still prose' })),
    )
    expect(never.result.status).toBe('failed')
    expect(never.result.error?.kind).toBe('invalid_output')
  })

  test('grounding is per attempt: a note read by an attempt that died grounds nothing in the retry', async () => {
    const host = new FakeAgentHost(async (s) => {
      if (!s.root.spec.key.endsWith(':retry')) {
        await callTool(s, 'brain_read', { note: ROUTING })
        throw new Error('the first session died')
      }
      return { output: answer([{ path: ROUTING, claim: 'two billing lanes' }]) }
    })
    const { runId, result } = await run({ question: 'How many billing lanes are there?' }, host)
    expect(result.status).toBe('done')
    const out = BrainOutput.parse(result.output)
    expect(out).toMatchObject({ status: 'partial', citations: [], read: [], grounding: { citations: 1, grounded: 0 } })
    expect(out.warnings).toEqual(['1 citation(s) dropped: the note was not read this run', 'nothing was read this run'])
    // Each attempt has its own grant, evidence step and ledger rows: the first one's read is not the retry's.
    expect(evidence(await ledger.read(runId, 'brain'))).toEqual({ read: [ROUTING], counts: { brain_read: 1 } })
    expect(await ledger.read(runId, 'brain:retry')).toEqual([])
    expect([...host.sessions.values()].map((x) => x.root.spec.key.split(':').slice(1).join(':'))).toEqual([
      'brain',
      'brain:retry',
    ])
  })

  test('the retry reads what it cites: only its own notes and calls count, nothing is doubled', async () => {
    const host = new FakeAgentHost(async (s) => {
      if (!s.root.spec.key.endsWith(':retry')) {
        await callTool(s, 'brain_read', { note: ROUTING })
        throw new Error('the first session died')
      }
      await callTool(s, 'brain_read', { note: PINNING })
      return {
        output: answer([
          { path: PINNING, claim: 'pin with a lockfile' },
          { path: ROUTING, claim: 'from attempt 1' },
        ]),
      }
    })
    const { runId, result } = await run({ question: 'How do I pin versions?' }, host)
    const out = BrainOutput.parse(result.output)
    expect(out).toMatchObject({
      status: 'partial',
      read: [PINNING],
      citations: [{ path: PINNING }],
      grounding: { citations: 2, grounded: 1 },
    })
    expect(evidence(await ledger.read(runId, 'brain:retry'))).toEqual({ read: [PINNING], counts: { brain_read: 1 } })
    // The journaled evidence steps agree: one call each.
    const [first, second] = await Promise.all([sql.step(runId, 'tools'), sql.step(runId, 'tools:retry')])
    expect([first?.status, second?.status]).toEqual(['done', 'done'])
  })

  test('both attempts failing fails the run after exactly two sessions', async () => {
    const host = new FakeAgentHost(async () => {
      throw new Error('boom')
    })
    const { result } = await run({ question: 'Fails twice?' }, host)
    // Both attempts fail: the run fails with the second attempt's error, after exactly two sessions.
    expect(result.status).toBe('failed')
    expect(host.sessions.size).toBe(2)
  })

  test('the input is strict', () => {
    expect(BrainInput.parse({ question: 'What is X?' })).toEqual({ question: 'What is X?' })
    expect(BrainInput.safeParse({ question: 'What is X?', depth: 'deep' }).success).toBe(false)
    expect(BrainInput.safeParse({ question: 'x' }).success).toBe(false)
    expect(BRAIN_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/)
  })

  test('a session without a grant is refused', async () => {
    const fake = { root: { spec: { key: 'nobody:brain' } } } as unknown as FakeSession
    expect(await callTool(fake, 'brain_read', { note: ROUTING })).toEqual({
      ok: false,
      error: 'this session holds no tool grant',
      code: 'no_grant',
    })
  })
})

describe('brain as a child of another workflow', () => {
  test('a parent calls it with ctx.workflow and reads the stable output; a failing child is null', async () => {
    const parent = defineWorkflow({
      id: 'brain.parent',
      version: 'v1',
      input: z.object({ questions: z.array(z.string()) }),
      output: z.object({ answers: z.array(BrainOutput.nullable()) }),
      async run(ctx, { questions }) {
        const answers = await ctx.workflow(
          'ask',
          brain,
          questions.map((question) => ({ question })),
        )
        return { answers }
      },
    })
    const host = new FakeAgentHost(async (s) => {
      if (s.spec.prompt.includes('boom')) throw new Error('child fails by design')
      await callTool(s, 'brain_read', { note: '[[model-routing]]' })
      return { output: answer([{ path: ROUTING, claim: 'two billing lanes' }]) }
    })
    const rt = testRuntime({ schema: db.schema, workflows: [parent, brain], host })
    await rt.open()
    try {
      const { runId } = await rt.start(
        parent,
        { questions: ['How many billing lanes?', 'boom?'] },
        { purpose: 'build' },
      )
      const done = await rt.wait(runId)
      expect(done.status).toBe('done')
      const { answers } = done.output as { answers: (BrainResult | null)[] }
      expect(answers[0]).toMatchObject({ status: 'ok', read: [ROUTING], citations: [{ path: ROUTING }] })
      expect(answers[1]).toBeNull()
      expect(await sql.run(`${runId}/ask/0`)).toMatchObject({ parent_id: runId, status: 'done', workflow: 'brain' })
    } finally {
      await rt.close()
    }
  })
})

describe("the agent's grant", () => {
  const dir = join(import.meta.dir, '..', '..', '..', 'agents', 'brain')

  test('holds brain_search and brain_read and nothing else, on every layer', () => {
    const tools = ['brain_read', 'brain_search']
    expect(Object.keys(BRAIN_TOOLS).sort()).toEqual(tools)
    expect(Object.values(BRAIN_TOOLS).sort()).toEqual(['brain.read', 'brain.search'])
    const [agent] = loadAgentDefinitions(join(dir, '..')).filter((a) => a.name === 'brain')
    expect(agent?.route).toBe('brain.agent')
    const rules = agent?.permissions?.rules ?? []
    expect(rules.map((r) => r.action).sort()).toEqual(tools)
    expect(rules.every((r) => r.resource === '*' && r.effect === 'allow')).toBe(true)
    expect(agent?.permissions?.shell).toBeUndefined()
    const plugin = readFileSync(join(dir, 'plugins', 'agw-tools.ts'), 'utf8')
    expect([...plugin.matchAll(/^\s+name: '([a-z_]+)',$/gm)].map((m) => m[1]).sort()).toEqual(tools)
    expect(agent?.skills).toBeUndefined()
  })

  test('the workflow names the agent and its route for the run fingerprint', () => {
    expect(brainEntry?.agents).toEqual([{ agent: 'brain', route: 'brain.agent' }])
    expect(brainEntry?.cli).toMatchObject({ positional: ['question'] })
  })
})

describe("the ledger hook is research's guarded one", () => {
  test('a ledger write that keeps failing is logged and never fails the call; an unbuildable row is written minimal', async () => {
    const errors: string[] = []
    const failing = brainGrant(
      {
        append: () => Promise.reject(new Error('database down')),
        read: () => Promise.resolve([]),
        run: () => Promise.resolve(null),
        hasJournal: true,
      },
      { warn: () => {}, error: (m) => errors.push(m) },
    )
    await failing.onCall?.({
      runId: 'r-brain-ledger',
      stepId: 'brain',
      tool: 'brain_read',
      args: { note: ROUTING },
      outcome: { ok: true, result: { found: true, path: ROUTING } },
    })
    expect(errors).toEqual(['brain tool gate: the ledger write failed; the call stands without its evidence row'])

    errors.length = 0
    const memory = memoryToolLedger()
    const grant = brainGrant(memory, { warn: () => {}, error: (m) => errors.push(m) })
    const circular: Record<string, Json> = {}
    circular.self = circular
    await grant.onCall?.({
      runId: 'r-brain-row',
      stepId: 'brain',
      tool: 'brain_read',
      args: circular,
      outcome: { ok: true, result: { found: true, path: ROUTING } },
    })
    const [row] = await memory.read('r-brain-row', 'brain')
    expect(row).toMatchObject({ tool: 'brain_read', ok: true, argsDigest: 'unavailable', retrieved: [], seen: [] })
    expect(errors).toEqual(['brain tool gate: the evidence row could not be built; a minimal row is written'])
  })
})

describe('the route', () => {
  test('brain.agent is Terra low on opencode with a DeepSeek fallback, and an override patches the fallback like any route', () => {
    const route = resolveRoute('brain.agent', {})
    expect(route).toMatchObject({ wire: 'opencode', model: 'gpt-6.1-terra', effort: 'low' })
    expect(route.fallback).toMatchObject({ wire: 'opencode', model: 'deepseek-v4.1-flash', maxOutputTokens: 32_000 })
    expect(fallbackRoute(route)).toMatchObject({ model: 'deepseek-v4.1-flash' })
    const patched = { AGW_ROUTES: JSON.stringify({ 'brain.agent': { fallback: { model: 'other-model' } } }) }
    expect(fallbackRoute(resolveRoute('brain.agent', patched))).toMatchObject({
      wire: 'opencode',
      model: 'other-model',
    })
  })
})

describe('the command', () => {
  test('`agw brain` is the workflow and no capability command starts with it (the host refuses a prefix)', () => {
    const commands = createCapabilities({ transports: fakeTransports({}), env: {} }).map((c) => c.cli.command)
    expect(commands.filter((c) => c[0] === 'vault')).toEqual([
      ['vault', 'search'],
      ['vault', 'read'],
    ])
    expect(commands.filter((c) => c[0] === 'brain')).toEqual([])
  })
})

describe('assemble', () => {
  const draft = (found: boolean, paths: string[]) => ({
    found,
    answer: 'a',
    citations: paths.map((path) => ({ path, claim: 'c' })),
  })

  test('grounding compares ./-stripped, NFC and case-folded paths; a kept citation carries the canonical path', () => {
    const umlaut = 'wiki/fr/Übung.md'
    expect(
      assemble(draft(true, ['./a.md', 'A.MD', 'b.md', umlaut.normalize('NFD').toLowerCase()]), {
        read: ['a.md', umlaut.normalize('NFC')],
      }),
    ).toMatchObject({
      status: 'partial',
      citations: [{ path: 'a.md' }, { path: 'a.md' }, { path: umlaut.normalize('NFC') }],
      grounding: { citations: 4, grounded: 3 },
    })
  })

  test('found:false is notfound; an answer citing nothing it read is partial', () => {
    expect(assemble(draft(false, []), { read: ['a.md'] }).status).toBe('notfound')
    expect(assemble(draft(true, []), { read: ['a.md'] })).toMatchObject({
      status: 'partial',
      warnings: ['the answer cites no note it read'],
    })
  })
})

describe('brain scorer and suite', () => {
  const reference = { notes: [ROUTING], facts: ['There are two billing lanes', 'The lanes are billed separately'] }
  const good: BrainResult = {
    answer: 'Two billing lanes.',
    citations: [{ path: ROUTING, claim: 'c' }],
    read: [ROUTING],
    status: 'ok',
    warnings: [],
    grounding: { citations: 1, grounded: 1 },
  }
  const score = (output: unknown, judge?: ScoreJudge, ref: unknown = reference) =>
    brainScorer.score({ question: 'q' }, output as never, {
      source: 'regression',
      reference: ref as never,
      ...(judge ? { judge } : {}),
      signal: new AbortController().signal,
    })
  const judgeOf =
    (values: unknown[]): ScoreJudge =>
    async (capability, input) => {
      expect(capability).toBe('decide')
      expect(Object.keys((input as { questions: object }).questions)).toEqual(values.map((_, i) => `f${i}`))
      return {
        answers: Object.fromEntries(values.map((value, i) => [`f${i}`, { type: 'boolean', value }])),
      } as Json
    }

  test('reference cited, grounded and facts judged', async () => {
    expect(await score(good, judgeOf([true, false]))).toEqual({
      scores: { valid: 1, grounded: 1, reference: 1, facts: 0.5 },
      pass: true,
    })
  })

  test('a reference note not cited, or a dropped citation, fails the case', async () => {
    const other = { ...good, citations: [{ path: PINNING, claim: 'c' }], read: [PINNING] }
    expect(await score(other, judgeOf([true, true]))).toMatchObject({
      scores: { reference: 0, grounded: 1, facts: 1 },
      pass: false,
      feedback: 'the reference note was not cited',
    })
    const dropped = { ...good, status: 'partial', grounding: { citations: 3, grounded: 1 } }
    const verdict = await score(dropped, judgeOf([true, true]))
    expect(verdict.scores.grounded).toBeCloseTo(1 / 3)
    expect(verdict).toMatchObject({ pass: false, feedback: '2 ungrounded citation(s)' })
  })

  test('facts are left out without a judge or when it gives no usable answer; invalid and failed runs score 0', async () => {
    expect((await score(good)).scores).not.toHaveProperty('facts')
    const unusable = await score(good, async () => ({ error: 'down' }))
    expect(unusable.scores).not.toHaveProperty('facts')
    expect(unusable.feedback).toContain('facts unscored')
    expect(await score({ nope: 1 }, judgeOf([true, true]))).toMatchObject({
      scores: { valid: 0, reference: 0, facts: 0 },
      pass: false,
    })
    expect(await score(null)).toMatchObject({ pass: false, feedback: 'the run failed' })
  })

  test('the reference is validated: one or two notes, one to three facts', () => {
    expect(brainScorer.reference?.safeParse(reference).success).toBe(true)
    expect(brainScorer.reference?.safeParse({ notes: [], facts: ['f'] }).success).toBe(false)
    expect(brainScorer.reference?.safeParse({ notes: ['a.md'], facts: [] }).success).toBe(false)
    expect(brainScorer.reference?.safeParse({ notes: ['a.md'], facts: ['1', '2', '3', '4'] }).success).toBe(false)
  })

  test('the suite reads $AGW_EVAL_DIR/brain/cases.jsonl as plain cases', () => {
    const env = { AGW_EVAL_DIR: join(root, 'eval') }
    const path = casesPath('brain', env)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ id: 'c1', input: { question: 'How many billing lanes?' }, reference })}\n`)
    const [c] = readSuite(HOST_SUITES, 'brain', env)
    expect(c).toMatchObject({ id: 'c1', tree: null, setup: false, reference })
    expect(c?.input('', {})).toEqual({ question: 'How many billing lanes?' })
    expect(brainScorer.reference?.safeParse(c?.reference).success).toBe(true)
  })
})

test('without a database the ledger is in memory and the workflow still builds', () => {
  const [entry] = createBrainWorkflows(deps, { ledger: memoryToolLedger() })
  expect(entry?.workflow.id).toBe('brain')
})
