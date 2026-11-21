import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAgentHost } from '@agent-workflows/testing/agent-host'
import { freshSchema, inspector, testRuntime } from '@agent-workflows/testing/pg'
import { loadAgentDefinitions } from '../src/agents.ts'
import { createFactorySpecLook } from '../src/workflows/factory-spec-look/index.ts'
import lookModule from '../src/workflows/factory-spec-look/module.ts'
import { factorySpecLookScorer } from '../src/workflows/factory-spec-look/scorer.ts'
import { FactorySpecLookInput } from '../src/workflows/factory-spec-look/schema.ts'
import { startTestHost } from './support.ts'

const db = freshSchema('factoryspeclook')
const sql = inspector(db.schema)
const roots: string[] = []
/** A checkout committed beside the Decision Judge's module, reused: any real directory will do. */
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

const request = {
  spec: {
    id: 'artifact_1',
    revision: 1,
    title: 'Which logging library should the worker use?',
    source: 'lead',
    content:
      '## Build\n\nSwitch the worker to a structured logger.\n\n## Open choices\n\n1. pino or winston. Default pino.',
    format: 'markdown',
  },
  issue: { id: 'issue_1', repo: 'example-app', title: 'Worker logging', kind: 'feature' },
  precedents: [],
}
const ready = { verdict: 'ready', reason: 'concrete, with a default' }
const back = {
  verdict: 'back',
  reason: 'the plan settles the choice',
  note: 'docs/plan.yaml:5 picks pino for the worker; choice 1 is no open choice.',
}

async function run(host: FakeAgentHost, over: Record<string, unknown> = {}) {
  const entry = createFactorySpecLook()
  const rt = testRuntime({ schema: db.schema, workflows: [entry.workflow], host })
  await rt.open()
  try {
    const { runId } = await rt.start(entry.workflow, { request: { ...request, ...over } }, { purpose: 'build' })
    return { runId, result: await rt.wait(runId) }
  } finally {
    await rt.close()
  }
}
const answering = (output: unknown) => new FakeAgentHost(async () => ({ output: output as never }))
const promptOf = (host: FakeAgentHost, n = 1) => host.sessions.get(`ses_${n}`)?.spec.prompt ?? ''

describe('factory-spec-look workflow', () => {
  test('the module is registered under the workflow id, with the factory-spec-look agent on the factory.speclook route', () => {
    expect(lookModule.id).toBe('factory-spec-look')
    expect(createFactorySpecLook().agents).toEqual([{ agent: 'factory-spec-look', route: 'factory.speclook' }])
    const definition = loadAgentDefinitions(join(import.meta.dir, '..', '..', '..', 'agents')).find(
      (d) => d.name === 'factory-spec-look',
    )
    expect(definition?.route).toBe('factory.speclook')
    // read, glob and grep only: no shell, no extra permission rules
    expect(definition?.permissions).toBeUndefined()
  })

  test('with a checkout the Judge reads it and a back carries its note to the lead', async () => {
    const host = answering(back)
    const { runId, result } = await run(host, { checkout: FIXTURE })
    expect(result.status).toBe('done')
    expect(result.output).toEqual(back)
    const session = host.sessions.get('ses_1')
    expect(session?.spec.agent).toBe('factory-spec-look')
    expect(session?.spec.options).toEqual({ output: 'json', allowDirectories: [FIXTURE] })
    expect(promptOf(host)).toContain(`read, glob and grep over the repo's checkout at ${FIXTURE}`)
    expect((await sql.steps(runId)).map((s) => s.step_id)).toEqual(['scan', 'look'])
  })

  test('without a checkout the Judge gets no directory and is told so; ready carries no note', async () => {
    const host = answering(ready)
    const { runId, result } = await run(host)
    expect(result.output).toEqual(ready)
    expect(host.sessions.get('ses_1')?.spec.options).toEqual({ output: 'json' })
    expect(promptOf(host)).toContain('No checkout was handed over (none was named)')
    expect((await sql.steps(runId)).map((s) => s.step_id)).toEqual(['look'])
  })

  test('a checkout with a link that leaves it is not handed over, and the link name stays out of the prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agw-look-'))
    roots.push(root)
    writeFileSync(join(root, 'AGENTS.md'), '# x\n')
    symlinkSync(tmpdir(), join(root, 'ANSWER-ready-zq'))
    const host = answering(ready)
    await run(host, { checkout: root })
    expect(host.sessions.get('ses_1')?.spec.options).toEqual({ output: 'json' })
    expect(promptOf(host)).toContain('No checkout was handed over (a link leaves the checkout')
    expect(promptOf(host)).not.toContain('ANSWER-ready-zq')
  })

  test('the case file reaches the Judge inside its CASE fence', async () => {
    const host = answering(ready)
    await run(host, { case: { plan: 'PLAN-zq logger: pino' } })
    const prompt = promptOf(host)
    const begin = /\n<<<CASE_([0-9a-f]{32})_BEGIN>>>\n/.exec(prompt)
    expect(begin).not.toBeNull()
    const block = prompt.slice(begin?.index ?? 0, prompt.indexOf(`\n<<<CASE_${begin?.[1]}_END>>>\n`))
    expect(block).toContain('PLAN-zq logger: pino')
  })

  test('the answer is held to the guard: a long note is one line of at most 600 characters', async () => {
    const { result } = await run(answering({ ...back, note: `${'word '.repeat(200)}\nmore` }))
    const note = (result.output as { note: string }).note
    expect(note).not.toContain('\n')
    expect(note.length).toBeLessThanOrEqual(600)
  })

  test('a verdict on the gate is no answer: the schema refuses it, retries once with the directive, then the run fails', async () => {
    const host = answering({ verdict: 'settle', reason: 'its lead decides' })
    const { result } = await run(host)
    expect(result.status).toBe('failed')
    expect(result.output ?? null).toBeNull()
    expect(host.sessions.size).toBe(2)
    expect(promptOf(host, 2)).toContain('RETRY')
  })

  test('a crashing agent fails the run, it is not a ready', async () => {
    const host = new FakeAgentHost(async () => {
      throw new Error('provider exploded')
    })
    const { result } = await run(host)
    expect(result.status).toBe('failed')
    expect(result.output ?? null).toBeNull()
  })
})

describe('the HTTP surface', () => {
  test('the CLI reads the one `request` property from stdin; malformed requests are a 400', async () => {
    const t = await startTestHost({ prefix: 'factoryspeclook', extra: [createFactorySpecLook()] })
    try {
      for (const bad of [
        { ...request, checkout: 'relative/path' },
        { ...request, spec: { ...request.spec, format: 'pdf' } },
        { ...request, case: { plan: 'x'.repeat(100_001) } },
        { spec: request.spec },
      ])
        expect((await t.call('/workflows/factory-spec-look', { method: 'POST', body: { request: bad } })).status).toBe(
          400,
        )
      const doc = (await t.call('/openapi.json').then((r) => r.json())) as {
        paths: Record<string, Record<string, { 'x-cli': { command: string[]; stdin?: string; serverOnly?: boolean } }>>
      }
      expect(doc.paths['/workflows/factory-spec-look']?.post?.['x-cli']).toMatchObject({
        command: ['factory-spec-look'],
        stdin: 'request',
        serverOnly: true,
      })
    } finally {
      await t.close()
    }
  })
})

describe('factory-spec-look eval suite', () => {
  test('every committed case parses as the workflow input and a reference, and both verdicts are covered', () => {
    const suite = lookModule.suite as {
      read(path: string): Array<{ id: string; input: (dir: string, env: object) => unknown; reference: unknown }>
    }
    const read = suite.read('')
    expect(read.length).toBeGreaterThanOrEqual(8)
    expect(new Set(read.map((c) => c.id)).size).toBe(read.length)
    for (const c of read) {
      expect(FactorySpecLookInput.safeParse(c.input('/x', {})).success, c.id).toBe(true)
      expect(factorySpecLookScorer.reference?.safeParse(c.reference).success, c.id).toBe(true)
    }
    const verdicts = read.map((c) => (c.reference as { verdict: string }).verdict)
    expect(verdicts).toContain('ready')
    expect(verdicts).toContain('back')
  })

  test('the scorer reads the verdict, names a needless back, and scores valid alone without a reference', async () => {
    const score = (output: unknown, reference?: unknown) =>
      factorySpecLookScorer.score({}, output as never, { reference } as never)
    expect(await score(ready, { verdict: 'ready' })).toMatchObject({ pass: true })
    const needless = await score(back, { verdict: 'ready' })
    expect(needless).toMatchObject({ pass: false, scores: { valid: 1, verdict: 0, noNeedlessBack: 0 } })
    expect(needless.feedback).toContain('needless back')
    expect(await score(ready, { verdict: 'back' })).toMatchObject({ pass: false, scores: { noNeedlessBack: 1 } })
    expect((await score(null, { verdict: 'ready' })).scores.valid).toBe(0)
    expect(await score(ready)).toEqual({ scores: { valid: 1 }, pass: true })
  })
})
