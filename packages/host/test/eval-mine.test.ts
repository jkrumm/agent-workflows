import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CapabilityCallError } from '@agent-workflows/capabilities'
import {
  type Exec,
  exec,
  GT_LIMIT,
  type GtCase,
  GtLabelRecord,
  gtPath,
  type LabelInput,
  type LabelOutput,
} from '@agent-workflows/eval'
import { buildCommands } from '../../cli/src/spec.ts'
import { createEvalMine, LABELER_VERSION, seatAnswer } from '../src/workflows/eval-mine/index.ts'
import { type Body, startTestHost, type TestHost } from './support.ts'

const OWNER = 'me@example.com'
const NOW = new Date('2026-11-02T12:00:00Z')

let sandbox: string
let home: string
let isolatedHome: string
/** Mutable: each test points the workflow at its own eval dir. */
const env: Record<string, string | undefined> = {}
let t: TestHost
const warnings: string[] = []
let mineEntry: ReturnType<typeof createEvalMine>

/** The labeller reads message bodies with `show -s`: while set, those reads fail, as the commits being gone or git being locked. */
let gitFailure: 'gone' | 'locked' | null = null
const GIT_FAILURES = {
  gone: 'fatal: bad object 0123456789abcdef',
  locked: 'fatal: Unable to create index.lock: File exists.',
}

const isolated: Exec = (cmd, args, options = {}) =>
  gitFailure && args.includes('-s')
    ? Promise.resolve({ code: 128, stdout: '', stderr: GIT_FAILURES[gitFailure] })
    : exec(cmd, args, {
        ...options,
        env: { ...options.env, HOME: isolatedHome, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      })

function git(repo: string, args: string[], extra: Record<string, string> = {}) {
  const ran = Bun.spawnSync(['git', '-C', repo, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: isolatedHome,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...extra,
    },
  })
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`)
  return ran.stdout.toString().trim()
}

function commit(repo: string, files: Record<string, string>, message: string, date: string) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
  const when = `${date}T10:00:00+0000`
  git(repo, ['add', '-A'])
  git(repo, ['commit', '--quiet', '-m', message], {
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: OWNER,
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: OWNER,
    GIT_COMMITTER_DATE: when,
  })
}

/** Four intro/fix pairs (`add`, `mul`, `neg`, `abs`) and five old logic commits no fix touched. */
function buildRepo(repo: string) {
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '--quiet', '--initial-branch=main'])
  commit(repo, { 'README.md': '# alpha\n' }, 'chore: init', '2026-01-01')
  const pairs = [
    ['add', 'a - b', 'a + b', '2026-09-01', '2026-09-20'],
    ['mul', 'a + b', 'a * b', '2026-09-02', '2026-09-21'],
    ['neg', 'a', '-a', '2026-09-03', '2026-09-22'],
    ['abs', 'a', 'Math.abs(a)', '2026-09-04', '2026-09-23'],
  ] as const
  for (const [name, bad, good, introDate, fixDate] of pairs) {
    const body = (expr: string) => `export function ${name}(a: number, b: number) {\n  return ${expr}\n}\n`
    commit(repo, { [`src/${name}.ts`]: body(bad) }, `feat: ${name}\n\nBody of ${name}.`, introDate)
    commit(repo, { [`src/${name}.ts`]: body(good) }, `fix: ${name} is wrong`, fixDate)
  }
  for (const i of [1, 2, 3, 4, 5]) {
    commit(repo, { [`src/c${i}.ts`]: `export const c${i} = (n: number) => n * ${i}\n` }, `feat: c${i}`, `2026-06-0${i}`)
  }
}

type Answer = (input: LabelInput) => LabelOutput | Promise<LabelOutput>
let answer: Answer
const calls: LabelInput[] = []

const label = (defect: boolean, file: string, start: number, end: number): LabelOutput => ({
  defect,
  location: defect ? { file, startLine: start, endLine: end } : null,
  description: defect ? 'The result is wrong.' : '',
  bugClass: 'logic',
  severity: 'major',
  reason: 'because',
  model: 'fake',
})

/**
 * `add` is a real bug (a+b), `mul` only seat a sees it (b-no), `neg` is placed in different files by a and b
 * (no-overlap), `abs` fails on seat b (labeler-error).
 */
const verdicts: Answer = (input) => {
  const name = input.fixSubject.split(' ')[1] as string
  const file = `src/${name}.ts`
  if (name === 'add') return label(true, file, 2, 2)
  if (name === 'mul') return label(input.seat === 'a', file, 2, 2)
  if (name === 'neg') return label(true, input.seat === 'b' ? 'src/other.ts' : file, 2, 2)
  if (input.seat === 'b') throw new CapabilityCallError('INVALID_OUTPUT', 502, 'Model output rejected', true)
  return label(true, file, 2, 2)
}

const registry = {
  async call(_id: 'eval.label', input: LabelInput) {
    calls.push(input)
    return answer(input)
  },
}
/** The `label` step cost of each eval.mine run the journal knows; a run absent here has no priced step. */
let stepCosts = new Map<string, number>()
/** What `--auto` reads: the gateway's eval credit, the IU total, past runs' spend. A read set to throw fails the run. */
const spendReads = {
  credit: 1 as number | Error,
  iu: 0 as number | Error,
  runs: [] as { runId: string; labelled: number; creditUsd: number; iuUsd: number }[],
  asked: [] as string[],
}
const read = async <T>(name: string, value: T | Error) => {
  spendReads.asked.push(name)
  if (value instanceof Error) throw value
  return value
}

beforeAll(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'agw-evalmine-'))
  home = join(sandbox, 'home')
  isolatedHome = join(sandbox, 'empty-home')
  mkdirSync(isolatedHome)
  buildRepo(join(home, 'SourceRoot', 'alpha'))
  env.AGW_EVAL_HOME = home
  mineEntry = createEvalMine({
    registry,
    env,
    exec: isolated,
    now: () => NOW,
    logger: { warn: (message) => warnings.push(message) },
    history: {
      auto: {
        creditAvailableUsd: () => read('credit', spendReads.credit),
        iuSpentUsd: () => read('iu', spendReads.iu),
        runSpend: () => read('runs', spendReads.runs),
      },
      labelStepCosts: async ({ runIds, limit }) =>
        runIds
          .filter((id) => stepCosts.has(id))
          .slice(0, limit)
          .map((runId) => ({ runId, cost: stepCosts.get(runId) as number })),
    },
  })
  t = await startTestHost({ prefix: 'evalmine', extra: [mineEntry] })
})
afterAll(async () => {
  await t.close()
  rmSync(sandbox, { recursive: true, force: true })
})

let n = 0
const writeOwner = (emails: string[]) => {
  const path = join(dirname(gtPath('report.json', env)), 'owner.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ emails }))
  return path
}

beforeEach(() => {
  env.AGW_EVAL_DIR = join(sandbox, `eval-${n++}`)
  env.AGW_EVAL_OWNER_EMAILS = undefined
  writeOwner([OWNER.toUpperCase()])
  warnings.length = 0
  calls.length = 0
  gitFailure = null
  answer = verdicts
  stepCosts = new Map()
  spendReads.credit = 1
  spendReads.iu = 0
  spendReads.runs = []
  spendReads.asked.length = 0
})

async function startRun(input: Record<string, unknown>) {
  const { body } = await t.json(
    await t.call('/workflows/eval/mine', {
      method: 'POST',
      body: { suite: 'review', ...input },
      headers: { prefer: 'wait=60' },
    }),
  )
  return body
}

async function mineRun(input: Record<string, unknown>) {
  const body = await startRun(input)
  expect(body.status).toBe('done')
  return body.output as Body
}

const asked = () => calls

const lines = (file: Parameters<typeof gtPath>[0]) =>
  readFileSync(gtPath(file, env), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

describe('eval.mine: mining', () => {
  test('mine only: candidates, controls, report; no model call; private modes', async () => {
    const out = await mineRun({ controls: 5 })
    expect(out).toMatchObject({
      suite: 'review',
      spent: false,
      labelledThisRun: 0,
      stopped: null,
      labelPlan: null,
      labelerVersion: LABELER_VERSION,
      limit: GT_LIMIT,
      funnel: { repos: 1, fixCommits: 4, candidates: 4, controls: 5 },
      summary: { labelled: 0, accepted: 0, cases: { dev: { bug: 0 }, test: { bug: 0 } } },
    })
    expect(calls).toHaveLength(0)
    expect(lines('candidates.jsonl')).toHaveLength(4)
    const cases = lines('cases.jsonl') as GtCase[]
    expect(cases.every((c) => c.kind === 'control')).toBe(true)
    expect(cases).toHaveLength(5)
    const report = JSON.parse(readFileSync(gtPath('report.json', env), 'utf8'))
    expect(report.funnel.candidates).toBe(4)
    expect(report.limit).toBe(GT_LIMIT)
    for (const file of ['candidates.jsonl', 'cases.jsonl', 'report.json'] as const) {
      expect(statSync(gtPath(file, env)).mode & 0o777).toBe(0o600)
    }
    expect(statSync(dirname(gtPath('report.json', env))).mode & 0o777).toBe(0o700)
    expect(readdirSync(dirname(gtPath('report.json', env))).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  test('the journal holds counts, not subjects or shas', async () => {
    const out = await mineRun({ controls: 2 })
    const row = await t.json(await t.call(`/runs/${out.runId}`))
    const text = JSON.stringify(row.body)
    expect(text).not.toContain('feat: add')
    expect(text).not.toContain('src/add.ts')
  })

  test('is a command with its flags', async () => {
    const { commands, skipped } = buildCommands(await t.host.openapi())
    expect(skipped).toEqual([])
    const command = commands.find((c) => c.words.join(' ') === 'eval mine')
    expect(command?.x).toMatchObject({ kind: 'workflow', positional: ['suite'], mutating: true })
    expect(mineEntry.workflow.concurrency).toBe(1)
    expect(command?.fields.map((f) => f.flag).sort()).toEqual([
      'auto',
      'concurrency',
      'controls',
      'iu-line-usd',
      'iu-margin-usd',
      'iu-since',
      'label',
      'max-per-run',
      'relabel-errors',
      'seed',
      'suite',
      'target',
      'yes',
    ])
  })
})

describe('eval.mine: owner emails', () => {
  const ownerFile = () => join(dirname(gtPath('report.json', env)), 'owner.json')

  test('mining refuses, naming both sources, when there is neither', async () => {
    rmSync(ownerFile())
    const body = await startRun({})
    expect(body.status).toBe('failed')
    expect(JSON.stringify(body)).toContain('no owner emails')
    expect(JSON.stringify(body)).toContain('AGW_EVAL_OWNER_EMAILS')
    expect(existsSync(gtPath('candidates.jsonl', env))).toBe(false)
  })

  test('AGW_EVAL_OWNER_EMAILS wins over owner.json', async () => {
    writeOwner(['nobody@example.com'])
    expect((await mineRun({})).funnel.candidates).toBe(0)
    env.AGW_EVAL_OWNER_EMAILS = ` ${OWNER} , other@example.com`
    expect((await mineRun({})).funnel.candidates).toBe(4)
  })

  test('an owner file without emails is refused', async () => {
    writeFileSync(ownerFile(), JSON.stringify({ emails: [] }))
    const body = await startRun({})
    expect(body.status).toBe('failed')
    expect(JSON.stringify(body)).toContain('owner.json')
  })
})

describe('eval.mine: an incomplete mine never shrinks the ground truth', () => {
  test('a repo that cannot be mined stops the run, records it in the report and leaves the files', async () => {
    await mineRun({ controls: 3 })
    const files = ['candidates.jsonl', 'cases.jsonl'] as const
    const before = files.map((f) => readFileSync(gtPath(f, env), 'utf8'))
    const broken = join(home, 'SourceRoot', 'broken')
    mkdirSync(join(broken, '.git'), { recursive: true })
    try {
      const body = await startRun({ controls: 3 })
      expect(body.status).toBe('failed')
      expect(JSON.stringify(body)).toContain('SourceRoot/broken')
    } finally {
      rmSync(broken, { recursive: true, force: true })
    }
    expect(files.map((f) => readFileSync(gtPath(f, env), 'utf8'))).toEqual(before)
    expect(JSON.parse(readFileSync(gtPath('report.json', env), 'utf8'))).toMatchObject({
      incomplete: true,
      skippedRepos: [{ repo: 'SourceRoot/broken', error: expect.any(String) }],
      funnel: { repos: 2, reposSkipped: 1 },
    })
  })

  test('no repositories at all stops the run too', async () => {
    await mineRun({ controls: 3 })
    const before = readFileSync(gtPath('candidates.jsonl', env), 'utf8')
    const empty = join(sandbox, 'empty-root')
    mkdirSync(empty)
    env.AGW_EVAL_HOME = empty
    try {
      const body = await startRun({})
      expect(body.status).toBe('failed')
      expect(JSON.stringify(body)).toContain('no repositories')
    } finally {
      env.AGW_EVAL_HOME = home
    }
    expect(readFileSync(gtPath('candidates.jsonl', env), 'utf8')).toBe(before)
  })
})

describe('eval.mine: labelling', () => {
  test('without --yes: the plan and an estimate; nothing is spent or labelled', async () => {
    await mineRun({ label: 2, yes: true, controls: 3 })
    // Two earlier runs wrote one record each; the per-candidate cost covers both labeller calls, so it is not doubled.
    const [first, second] = lines('labels.jsonl') as GtLabelRecord[]
    writeFileSync(
      gtPath('labels.jsonl', env),
      [
        { ...first, runId: 'old-a' },
        { ...second, runId: 'old-b' },
      ]
        .map((r) => `${JSON.stringify(r)}\n`)
        .join(''),
    )
    stepCosts = new Map([
      ['old-a', 0.3],
      ['old-b', 0.1],
      ['no-labels', 9],
    ])
    calls.length = 0
    const out = await mineRun({ label: 2 })
    expect(out.spent).toBe(false)
    expect(out.labelPlan?.candidates).toBe(2)
    expect(out.labelPlan?.estimate.historyRuns).toBe(2)
    expect(out.labelPlan?.estimate.meanCostUsd).toBeCloseTo(0.2, 10)
    expect(out.labelPlan?.estimate.totalUsd).toBeCloseTo(0.4, 10)
    expect(calls).toHaveLength(0)
  })

  test('the estimate counts only the labels of runs with a priced label step', async () => {
    await mineRun({ label: 2, yes: true, controls: 3 })
    const [first, second] = lines('labels.jsonl') as GtLabelRecord[]
    writeFileSync(
      gtPath('labels.jsonl', env),
      [
        { ...first, runId: 'priced' },
        { ...second, runId: 'unpriced' },
      ]
        .map((r) => `${JSON.stringify(r)}\n`)
        .join(''),
    )
    stepCosts = new Map([['priced', 0.3]])
    const out = await mineRun({ label: 2 })
    expect(out.labelPlan?.estimate).toMatchObject({ historyRuns: 1, meanCostUsd: 0.3, totalUsd: 0.6 })
  })

  test('the estimate is unknown without priced history, and capped at the unlabelled candidates', async () => {
    const out = await mineRun({ label: 50 })
    expect(out.labelPlan).toEqual({
      candidates: 4,
      estimate: { historyRuns: 0, meanCostUsd: null, totalUsd: null },
    })
  })

  test('--yes labels the next candidates in a seeded order, two seats each, and rebuilds the cases', async () => {
    const first = await mineRun({ label: 2, yes: true, controls: 3 })
    expect(first).toMatchObject({ spent: true, labelledThisRun: 2, stopped: null })
    expect(asked()).toHaveLength(4)
    expect(new Set(asked().map((c) => c.seat))).toEqual(new Set(['a', 'b']))
    const one = calls[0] as LabelInput
    expect(one.introDiff).toContain('+  return ')
    expect(one.introBody).toStartWith('Body of')
    expect(one.fixDiff).toContain('-  return ')
    expect(one.blamed).toEqual([{ file: expect.stringMatching(/^src\//), line: 2 }])
    const records = lines('labels.jsonl').map((r) => GtLabelRecord.parse(r))
    expect(records).toHaveLength(2)
    expect(records.every((r) => r.runId === first.runId && r.labelerVersion === LABELER_VERSION)).toBe(true)
    expect(records.every((r) => r.c === undefined)).toBe(true)

    // The next run labels the next two, never the same ones.
    const second = await mineRun({ label: 2, yes: true, controls: 3 })
    expect(second.labelledThisRun).toBe(2)
    const all = lines('labels.jsonl').map((r) => GtLabelRecord.parse(r))
    expect(new Set(all.map((r) => r.candidateId)).size).toBe(4)
    expect(asked()).toHaveLength(8)

    expect(second.summary).toMatchObject({
      labelled: 4,
      accepted: 1,
      acceptPaths: { 'a+b': 1 },
      rejected: { total: 3, byReason: { 'b-no': 1, 'no-overlap': 1, 'labeler-error': 1 } },
      bugClasses: { logic: 1 },
    })
    const cases = lines('cases.jsonl') as GtCase[]
    expect(cases.filter((c) => c.kind === 'bug')).toHaveLength(1)
    expect(cases.filter((c) => c.kind === 'control')).toHaveLength(3)
    expect(cases.find((c) => c.kind === 'bug' && c.subject === 'feat: add')).toMatchObject({
      repo: 'SourceRoot/alpha',
      bug: { fixSubject: 'fix: add is wrong', location: { file: 'src/add.ts', startLine: 2, endLine: 2 } },
    })
    expect(lines('rejected.jsonl')).toHaveLength(3)

    // Nothing left to label: no call, same cases.
    const third = await mineRun({ label: 2, yes: true, controls: 3 })
    expect(third.labelledThisRun).toBe(0)
    expect(calls).toHaveLength(8)
    expect(third.summary.accepted).toBe(1)
    const report = JSON.parse(readFileSync(gtPath('report.json', env), 'utf8'))
    expect(report).toMatchObject({
      labelled: 4,
      accepted: 1,
      acceptanceRate: 0.25,
      acceptPaths: { 'a+b': 1 },
      limit: GT_LIMIT,
      rejected: { byReason: { 'b-no': 1, 'no-overlap': 1, 'labeler-error': 1 } },
    })
  })

  test('a seat error is recorded and not retried, unless --relabel-errors', async () => {
    await mineRun({ label: 4, yes: true })
    expect(asked()).toHaveLength(8)
    const errored = (lines('labels.jsonl') as GtLabelRecord[]).filter((r) => 'error' in r.b)
    expect(errored).toHaveLength(1)
    expect(JSON.stringify(errored[0]?.b)).toContain('INVALID_OUTPUT')

    expect((await mineRun({ label: 4, yes: true })).labelledThisRun).toBe(0)
    expect(asked()).toHaveLength(8)

    answer = (input) => label(true, `src/${input.fixSubject.split(' ')[1]}.ts`, 2, 2)
    const again = await mineRun({ label: 4, yes: true, relabelErrors: true })
    expect(again.labelledThisRun).toBe(1)
    expect(asked()).toHaveLength(10)
    expect(again.summary).toMatchObject({ labelled: 4, accepted: 2 })
    expect(again.summary.rejected.byReason['labeler-error']).toBeUndefined()
  })

  test('stops at the first error that is not a seat answer and keeps what was written', async () => {
    let served = 0
    answer = (input) => {
      if (++served > 2) throw new CapabilityCallError('UPSTREAM_ERROR', 502, 'no eval credit', true, { status: 403 })
      return verdicts(input)
    }
    const out = await mineRun({ label: 4, yes: true, concurrency: 1 })
    expect(out.stopped).toContain('no eval credit')
    expect(out.labelledThisRun).toBe(1)
    expect(lines('labels.jsonl')).toHaveLength(1)
    expect(out.summary.labelled).toBe(1)
    // The run is a success; the stop is also a warning with the reason and the count of this run.
    expect(warnings.filter((w) => w.startsWith('labelling stopped:') && w.includes('no eval credit'))).toHaveLength(1)
    expect(warnings.find((w) => w.startsWith('labelling stopped:'))).toContain('(1 candidates labelled in this run)')
  })

  test('a torn trailing line in labels.jsonl is skipped with a warning; the next record starts a line of its own', async () => {
    await mineRun({ label: 1, yes: true })
    appendFileSync(gtPath('labels.jsonl', env), '{"candidateId":"alpha-tor')
    const out = await mineRun({ label: 2, yes: true })
    expect(out.labelledThisRun).toBe(2)
    expect(warnings.some((w) => w.includes('labels.jsonl:2'))).toBe(true)
    const raw = readFileSync(gtPath('labels.jsonl', env), 'utf8').split('\n')
    expect(raw[1]).toBe('{"candidateId":"alpha-tor')
    const valid = raw.filter((l) => l && l !== raw[1]).map((l) => GtLabelRecord.parse(JSON.parse(l)))
    expect(valid).toHaveLength(3)
    expect(out.summary.labelled).toBe(3)
  })

  test('a stop lets the candidate in flight finish and keep its record', async () => {
    let first: string | undefined
    answer = async (input) => {
      first ??= input.candidateId
      if (input.candidateId === first) {
        throw new CapabilityCallError('UPSTREAM_ERROR', 502, 'no eval credit', true, { status: 403 })
      }
      await Bun.sleep(150)
      return verdicts(input)
    }
    const out = await mineRun({ label: 2, yes: true, concurrency: 2 })
    expect(out.stopped).toContain('no eval credit')
    expect(out.labelledThisRun).toBe(1)
    expect(lines('labels.jsonl')).toHaveLength(1)
  })

  test('a git failure that is not a missing commit stops labelling and leaves the candidate unlabelled', async () => {
    gitFailure = 'locked'
    const out = await mineRun({ label: 2, yes: true })
    expect(out.stopped).toContain('index.lock')
    expect(out.labelledThisRun).toBe(0)
    expect(calls).toHaveLength(0)
    expect(existsSync(gtPath('labels.jsonl', env))).toBe(false)
  })

  test('a candidate whose commits left the checkout is recorded as a labeler error, without a model call', async () => {
    gitFailure = 'gone'
    const out = await mineRun({ label: 1, yes: true })
    expect(out.labelledThisRun).toBe(1)
    expect(calls).toHaveLength(0)
    expect(out.summary.rejected.byReason).toEqual({ 'labeler-error': 1 })
    const record = GtLabelRecord.parse(lines('labels.jsonl')[0])
    expect(record.a).toEqual({ error: expect.stringContaining('git: ') })
  })
})

describe('eval.mine: legacy records', () => {
  test('a record written with the removed seat c loads and is judged on a and b alone', async () => {
    await mineRun({ label: 4, yes: true, controls: 3 })
    const legacy = (lines('labels.jsonl') as GtLabelRecord[]).map((r) => ({
      ...r,
      c: label(true, 'src/other.ts', 1, 1),
      cVersion: 'eval-label-c-old',
      cRunId: 'old-run',
    }))
    writeFileSync(gtPath('labels.jsonl', env), legacy.map((r) => `${JSON.stringify(r)}\n`).join(''))
    calls.length = 0
    const out = await mineRun({ label: 4, yes: true, controls: 3 })
    expect(calls).toHaveLength(0)
    expect(out.summary).toMatchObject({
      labelled: 4,
      accepted: 1,
      rejected: { total: 3, byReason: { 'b-no': 1, 'no-overlap': 1, 'labeler-error': 1 } },
    })
  })
})

describe('eval.mine: --auto', () => {
  const bugCases = (out: Body) => out.summary.cases.dev.bug + out.summary.cases.test.bug

  test('sizes the run from the credit: 90 % of it over the fallback cost per candidate, and records why', async () => {
    // $0.12 × 0.9 = $0.108 → 2 candidates at the $0.05 fallback; IU $20 − $0.75 − $2.70 is room for far more.
    spendReads.credit = 0.12
    spendReads.iu = 2.7
    const out = await mineRun({ auto: true, yes: true, controls: 3 })
    expect(out).toMatchObject({ spent: true, labelledThisRun: 2, stopped: null })
    expect(out.auto).toEqual({
      state: 'labelled',
      target: 200,
      bugCasesBefore: 0,
      bugCasesAfter: bugCases(out),
      creditAvailableUsd: 0.12,
      creditPerCandidateUsd: 0.05,
      iuSpentUsd: 2.7,
      iuLineUsd: 20,
      iuPerCandidateUsd: 0.035,
      planned: 2,
    })
    expect(asked()).toHaveLength(4)
    expect(out.labelPlan.candidates).toBe(2)
  })

  test('the per-candidate cost is measured from the newest labelling runs when there are any', async () => {
    spendReads.credit = 0.5
    spendReads.runs = [
      { runId: 'r1', labelled: 10, creditUsd: 0.4, iuUsd: 0.3 },
      { runId: 'r2', labelled: 10, creditUsd: 0.6, iuUsd: 0.5 },
    ]
    const out = await mineRun({ auto: true, controls: 3 })
    // 0.5 × 0.9 / 0.05 = 9 by credit, capped at the 4 unlabelled candidates.
    expect(out.auto).toMatchObject({ creditPerCandidateUsd: 0.05, iuPerCandidateUsd: 0.04, planned: 4 })
  })

  test('without --yes it plans and labels nothing', async () => {
    spendReads.credit = 0.12
    const out = await mineRun({ auto: true, controls: 3 })
    expect(out).toMatchObject({ spent: false, labelledThisRun: 0 })
    expect(out.auto).toMatchObject({ state: 'labelled', planned: 2, bugCasesAfter: bugCases(out) })
    expect(out.labelPlan.candidates).toBe(2)
    expect(calls).toHaveLength(0)
  })

  test('the per-run cap and the candidates left bound the plan', async () => {
    spendReads.credit = 100
    expect((await mineRun({ auto: true, controls: 3, maxPerRun: 3 })).auto.planned).toBe(3)
    expect((await mineRun({ auto: true, controls: 3 })).auto.planned).toBe(4)
  })

  test('at the target nothing is read and nothing is labelled', async () => {
    await mineRun({ label: 4, yes: true, controls: 3 })
    const before = bugCases(await mineRun({ controls: 3 }))
    expect(before).toBeGreaterThan(0)
    calls.length = 0
    spendReads.asked.length = 0
    const out = await mineRun({ auto: true, yes: true, controls: 3, target: before })
    expect(out).toMatchObject({ spent: false, labelledThisRun: 0 })
    expect(out.auto).toEqual({
      state: 'target-reached',
      target: before,
      bugCasesBefore: before,
      bugCasesAfter: before,
      creditAvailableUsd: null,
      creditPerCandidateUsd: null,
      iuSpentUsd: null,
      iuLineUsd: 20,
      iuPerCandidateUsd: null,
      planned: 0,
    })
    expect(spendReads.asked).toEqual([])
    expect(calls).toHaveLength(0)
  })

  test('no credit left labels nothing, even with --yes', async () => {
    spendReads.credit = 0.04 // 90 % is $0.036, less than one candidate
    const out = await mineRun({ auto: true, yes: true, controls: 3 })
    expect(out).toMatchObject({ spent: false, labelledThisRun: 0 })
    expect(out.auto).toMatchObject({ state: 'no-credit', planned: 0, creditAvailableUsd: 0.04 })
    expect(calls).toHaveLength(0)
    expect(existsSync(gtPath('labels.jsonl', env))).toBe(false)
  })

  test('the IU line stops the run: total + planned never passes line − margin', async () => {
    spendReads.credit = 100
    spendReads.iu = 19.24 // $0.01 of room under $19.25, less than one candidate ($0.035)
    const out = await mineRun({ auto: true, yes: true, controls: 3 })
    expect(out.auto).toMatchObject({ state: 'iu-line', planned: 0, iuSpentUsd: 19.24 })
    expect(calls).toHaveLength(0)
    // $0.1 of room buys two candidates at the measured $0.035 × 1.25 = $0.04375: the IU side binds before the credit.
    spendReads.iu = 19.15
    expect((await mineRun({ auto: true, controls: 3 })).auto).toMatchObject({ state: 'labelled', planned: 2 })
  })

  test('the line, margin and since are inputs', async () => {
    spendReads.credit = 100
    const out = await mineRun({
      auto: true,
      controls: 3,
      iuLineUsd: 1,
      iuMarginUsd: 0.5,
      iuSince: '2026-01-01T00:00:00Z',
    })
    // $0.5 of room at $0.035 → 14, capped at the 4 candidates; the line is reported as given.
    expect(out.auto).toMatchObject({ iuLineUsd: 1, planned: 4 })
  })

  test('a read that fails fails the run with its reason, and nothing is labelled', async () => {
    spendReads.credit = new Error('gateway /health unreadable: HTTP 503')
    const body = await startRun({ auto: true, yes: true, controls: 3 })
    expect(body.status).toBe('failed')
    expect(JSON.stringify(body)).toContain(
      '--auto cannot size the run: eval credit: gateway /health unreadable: HTTP 503',
    )
    spendReads.credit = 1
    spendReads.iu = new Error('USAGE_PG_URL is not set')
    const second = await startRun({ auto: true, yes: true, controls: 3 })
    expect(second.status).toBe('failed')
    expect(JSON.stringify(second)).toContain('IU eval spend: USAGE_PG_URL is not set')
    expect(calls).toHaveLength(0)
  })

  test('every candidate labelled but the target not reached is a failed run, not a finished one', async () => {
    await mineRun({ label: 4, yes: true, controls: 3 })
    spendReads.credit = 100
    const body = await startRun({ auto: true, yes: true, controls: 3 })
    expect(body.status).toBe('failed')
    expect(JSON.stringify(body)).toContain('no unlabelled candidates are left')
  })

  test('--max-per-run 0 is refused: a plan of nothing is not a night off', async () => {
    const response = await t.call('/workflows/eval/mine', {
      method: 'POST',
      body: { suite: 'review', auto: true, maxPerRun: 0 },
      headers: { prefer: 'wait=60' },
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect(calls).toHaveLength(0)
  })

  test('--auto and --label are exclusive', async () => {
    const response = await t.call('/workflows/eval/mine', {
      method: 'POST',
      body: { suite: 'review', auto: true, label: 5 },
      headers: { prefer: 'wait=60' },
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect(calls).toHaveLength(0)
  })

  test('a run without --auto reports auto: null', async () => {
    expect((await mineRun({ controls: 3 })).auto).toBeNull()
  })
})

describe('seatAnswer', () => {
  test('an unusable output, a truncation, a refused input or a vendor refusal is an answer', () => {
    for (const code of ['INVALID_OUTPUT', 'OUTPUT_TRUNCATED', 'INVALID_INPUT']) {
      expect(seatAnswer(new CapabilityCallError(code, 502, 'bad', true))).toStartWith(code)
    }
    const refusal = new CapabilityCallError('UPSTREAM_ERROR', 502, 'blocked', true, { userError: { message: 'no' } })
    expect(seatAnswer(refusal)).toStartWith('UPSTREAM_ERROR')
  })

  test('the 403 no-credit error, outages, configuration and cancels are not', () => {
    expect(
      seatAnswer(new CapabilityCallError('UPSTREAM_ERROR', 502, 'no eval credit', true, { status: 403 })),
    ).toBeNull()
    expect(seatAnswer(new CapabilityCallError('UPSTREAM_ERROR', 502, 'down', true, { transport: true }))).toBeNull()
    expect(seatAnswer(new CapabilityCallError('NOT_CONFIGURED', 503, 'x', true))).toBeNull()
    expect(seatAnswer(new CapabilityCallError('CANCELLED', 499, 'x', true))).toBeNull()
    expect(seatAnswer(new Error('boom'))).toBeNull()
    expect(seatAnswer('boom')).toBeNull()
  })
})
