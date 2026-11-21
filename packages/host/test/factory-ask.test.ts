import fixture from './fixtures/software-factory-loops.json'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAgentHost } from '@agent-workflows/testing/agent-host'
import { freshSchema, inspector, testRuntime } from '@agent-workflows/testing/pg'
import { loadAgentDefinitions } from '../src/agents.ts'
import { createFactoryAsk } from '../src/workflows/factory-ask/index.ts'
import askModule from '../src/workflows/factory-ask/module.ts'
import { factoryAskScorer } from '../src/workflows/factory-ask/scorer.ts'
import { startTestHost } from './support.ts'

const db = freshSchema('factoryask')
const sql = inspector(db.schema)
const roots: string[] = []
/** A checkout committed beside the module whose plan settles the logging question. */
const FIXTURE = join(import.meta.dir, '..', 'src', 'workflows', 'factory-ask', 'eval', 'fixture')

beforeAll(async () => {
  const rt = testRuntime({ schema: db.schema, workflows: [] })
  await rt.open()
  await rt.close()
})
afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  await sql.close()
  await db.drop()
})

const decision = fixture.judge.input
const fromPlan = {
  verdict: 'answer',
  answer: 'pino',
  reason: 'the plan decided pino for the worker',
  source: 'file: docs/plan.yaml:5 logger: pino, as in example-app and example-api',
}
const owner = { verdict: 'owner', answer: '', source: '', reason: 'spend' }

async function run(host: FakeAgentHost, over: Record<string, unknown> = {}) {
  const entry = createFactoryAsk()
  const rt = testRuntime({ schema: db.schema, workflows: [entry.workflow], host })
  await rt.open()
  try {
    const { runId } = await rt.start(entry.workflow, { ask: { ...decision, ...over } }, { purpose: 'build' })
    return { runId, result: await rt.wait(runId) }
  } finally {
    await rt.close()
  }
}
const answering = (output: unknown) => new FakeAgentHost(async () => ({ output: output as never }))
const promptOf = (host: FakeAgentHost, n = 1) => host.sessions.get(`ses_${n}`)?.spec.prompt ?? ''

describe('factory-ask workflow', () => {
  test('the module is registered under the workflow id, with the factory-ask agent on the factory.ask route', () => {
    expect(askModule.id).toBe('factory-ask')
    expect(createFactoryAsk().agents).toEqual([{ agent: 'factory-ask', route: 'factory.ask' }])
    const definition = loadAgentDefinitions(join(import.meta.dir, '..', '..', '..', 'agents')).find(
      (d) => d.name === 'factory-ask',
    )
    expect(definition?.route).toBe('factory.ask')
    // read, glob and grep only: no shell, no extra permission rules
    expect(definition?.permissions).toBeUndefined()
  })

  test('on the fixture checkout the Judge reads it and answers what the plan settles, citing the file', async () => {
    const host = answering(fromPlan)
    const { runId, result } = await run(host, { checkout: FIXTURE })
    expect(result.status).toBe('done')
    expect(result.output).toEqual(fromPlan)
    const session = host.sessions.get('ses_1')
    expect(session?.spec.agent).toBe('factory-ask')
    expect(session?.spec.options).toEqual({ output: 'json', allowDirectories: [FIXTURE] })
    const prompt = promptOf(host)
    expect(prompt).toContain(`read, glob and grep over the repo's checkout at ${FIXTURE}`)
    expect(prompt).toContain('Which logging library should the access log use?')
    expect((await sql.steps(runId)).map((s) => s.step_id)).toEqual(['scan', 'look'])
  })

  test('without a checkout the Judge gets no directory and is told so', async () => {
    const host = answering(owner)
    const { runId, result } = await run(host)
    expect(result.output).toEqual(owner)
    expect(host.sessions.get('ses_1')?.spec.options).toEqual({ output: 'json' })
    expect(promptOf(host)).toContain('No checkout was handed over (none was named)')
    expect((await sql.steps(runId)).map((s) => s.step_id)).toEqual(['look'])
  })

  test('a checkout with a link that leaves it is not handed over: the Judge answers from the request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agw-ask-'))
    roots.push(root)
    writeFileSync(join(root, 'AGENTS.md'), '# x\n')
    symlinkSync(tmpdir(), join(root, 'escape'))
    const host = answering(owner)
    await run(host, { checkout: root })
    expect(host.sessions.get('ses_1')?.spec.options).toEqual({ output: 'json' })
    expect(promptOf(host)).toContain('No checkout was handed over (a link leaves the checkout')
  })

  test('the case file reaches the Judge inside its CASE fence', async () => {
    const host = answering(fromPlan)
    await run(host, { case: { plan: 'PLAN-zq logger: pino', ownerNotes: [{ at: 'today', text: 'NOTE-zq' }] } })
    const prompt = promptOf(host)
    const begin = /\n<<<CASE_([0-9a-f]{32})_BEGIN>>>\n/.exec(prompt)
    expect(begin).not.toBeNull()
    const block = prompt.slice(begin?.index ?? 0, prompt.indexOf(`\n<<<CASE_${begin?.[1]}_END>>>\n`))
    expect(block).toContain('PLAN-zq logger: pino')
    expect(block).toContain('NOTE-zq')
  })

  test('back, yours: with sendBack the question returns to the lead with a note citing what the Judge found', async () => {
    const yours = {
      verdict: 'back',
      answer: '',
      reason: 'outside the classes; the plan settles most of it',
      source: 'file: docs/plan.yaml:5',
      note: 'Yours: docs/plan.yaml:5 picks pino for the worker and AGENTS.md:11 says every service logs through pino.',
      back: 'yours',
    }
    const host = answering(yours)
    const { result } = await run(host, { checkout: FIXTURE, sendBack: true })
    expect(result.output).toEqual(yours)
    expect(promptOf(host)).toContain('## Sending it back')
  })

  test("back, not_ready: the owner's question goes back with what is missing, and no option is picked", async () => {
    const notReady = {
      verdict: 'back',
      answer: '',
      reason: "the owner's, but not answerable in ten seconds",
      source: '',
      note: 'His call, but show a sample log line of each library and what the dashboards would lose with winston.',
      back: 'not_ready',
    }
    const { result } = await run(answering(notReady), { sendBack: true })
    expect(result.output).toEqual(notReady)
  })

  test('without sendBack no back is given: the schema refuses it, and the retry that still says back fails the run', async () => {
    const back = {
      verdict: 'back',
      answer: '',
      reason: 'r',
      source: '',
      note: 'n',
      back: 'yours',
    }
    for (const over of [{}, { sendBack: false }]) {
      const host = answering(back)
      const { result } = await run(host, over)
      expect(result.status).toBe('failed')
      expect(result.output ?? null).toBeNull()
      expect(host.sessions.size).toBe(2)
      expect(promptOf(host)).not.toContain('Sending it back')
    }
  })

  test('an answer outside the labels is retried once with the directive, then the run fails', async () => {
    const host = answering({ ...fromPlan, answer: 'bunyan' })
    const { result } = await run(host)
    expect(result.status).toBe('failed')
    expect(result.output ?? null).toBeNull()
    expect(host.sessions.size).toBe(2)
    expect(promptOf(host, 2)).toContain('RETRY')
  })

  test('an option that cannot be taken back is never the answer', async () => {
    const options = [
      { label: 'pino', reversible: false, cost: 'rewrites the log format for good' },
      { label: 'winston', reversible: true, cost: 'one dependency' },
    ]
    const { result } = await run(answering(fromPlan), { options })
    expect(result.output).toMatchObject({ verdict: 'owner', answer: '', source: '' })
    expect((result.output as { reason: string }).reason).toContain('cannot be taken back')
  })

  test('a Decision whose assembled facts pass the cap is refused, not cut: the owner’s, and no session opens', async () => {
    const host = answering(fromPlan)
    const { result } = await run(host, {
      checked: 'c'.repeat(19_000),
      options: [
        { label: 'pino', reversible: true, cost: 'x'.repeat(900) },
        { label: 'winston', reversible: true, cost: 'y'.repeat(900) },
      ],
    })
    expect(result.output).toMatchObject({ verdict: 'owner', answer: '', source: '' })
    expect((result.output as { reason: string }).reason).toStartWith('judge unavailable: ')
    expect(host.sessions.size).toBe(0)
  })

  test('a crashing agent fails the run, it is not an owner verdict', async () => {
    const host = new FakeAgentHost(async () => {
      throw new Error('provider exploded')
    })
    const { result } = await run(host)
    expect(result.status).toBe('failed')
    expect(result.output ?? null).toBeNull()
  })
})

describe('the HTTP surface', () => {
  test('the CLI reads the one `ask` property from stdin; malformed, old-shaped and oversize asks are a 400', async () => {
    const t = await startTestHost({ prefix: 'factoryask', extra: [createFactoryAsk()] })
    try {
      const { recommendation: _missing, ...missing } = decision
      for (const bad of [
        { question: 'Which?', options: ['a'], default: 'a', facts: '', plan: '', repo: 'agent-workflows' },
        { ...decision, options: 'pino' },
        missing,
        { ...decision, class: 'taste' },
        { ...decision, facts: 'x'.repeat(8_001) },
        { ...decision, spec: 'x'.repeat(20_001) },
        { ...decision, checkout: 'relative/path' },
        { ...decision, case: { plan: 'x'.repeat(100_001) } },
      ])
        expect((await t.call('/workflows/factory-ask', { method: 'POST', body: { ask: bad } })).status).toBe(400)
      const doc = (await t.call('/openapi.json').then((r) => r.json())) as {
        paths: Record<string, Record<string, { 'x-cli': { command: string[]; stdin?: string; serverOnly?: boolean } }>>
      }
      expect(doc.paths['/workflows/factory-ask']?.post?.['x-cli']).toMatchObject({
        command: ['factory-ask'],
        stdin: 'ask',
        serverOnly: true,
      })
    } finally {
      await t.close()
    }
  })
})

describe('factory-ask eval suite', () => {
  test('the module serves the committed cases: each input is a Decision the seat takes whole, and the scorer reads a reference', async () => {
    const { askOfJudge, factoryAskInput, factoryJudgeInput } = await import('@agent-workflows/capabilities')
    const { FACTORY_ASK_CASES_PATH, FactoryAskReference, PlainCase, readCases } = await import('@agent-workflows/eval')
    const cases = readCases(FACTORY_ASK_CASES_PATH, PlainCase)
    const suite = askModule.suite as { read(path: string): unknown[] }
    expect(suite.read('').length).toBe(cases.length)
    for (const c of cases) {
      const judge = factoryJudgeInput.parse((c.input as { ask: unknown }).ask)
      expect(factoryAskInput.safeParse(askOfJudge(judge)).success, c.id).toBe(true)
      expect(FactoryAskReference.safeParse(c.reference).success, c.id).toBe(true)
    }
  })

  test('the scorer reads the workflow output against the declared default of the Decision', async () => {
    const reference = {
      verdict: 'answer',
      answer: 'B',
      defaultContradicted: true,
      basis: 'synthetic',
      note: 'n',
    } as const
    const input = { ask: { noAnswer: { default: 'A' } } }
    const verdict = (answer: string) => ({ verdict: 'answer', answer, reason: 'r', source: 'default' })
    expect((await factoryAskScorer.score(input, verdict('A'), { reference } as never)).pass).toBe(false)
    expect((await factoryAskScorer.score(input, verdict('B'), { reference } as never)).pass).toBe(true)
    expect((await factoryAskScorer.score(input, null, { reference } as never)).scores.valid).toBe(0)
    expect(await factoryAskScorer.score(input, verdict('B'), {} as never)).toEqual({ scores: { valid: 1 }, pass: true })
  })
})
