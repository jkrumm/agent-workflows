import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Exec,
  exec as bunExec,
  type GtBugCase,
  type GtCandidate,
  type JudgeInput,
  type JudgeOutput,
} from '@agent-workflows/eval'
import { ingestLabels, parseLabels } from '../src/workflows/eval-gt/ingest.ts'
import type { JudgeRun, JudgeRunReader } from '../src/workflows/eval-gt/judge-runs.ts'
import { buildPack, type PackDeps } from '../src/workflows/eval-gt/pack.ts'

let root: string
let env: Record<string, string | undefined>
let home: string
const sha: Record<string, string> = {}

/** Git with no global or system config: the test never reads the real HOME. */
const gitEnv = (dir: string) => ({
  HOME: dir,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
})
const exec: Exec = (cmd, args, options) => bunExec(cmd, args, { ...options, env: { ...options?.env, ...gitEnv(root) } })
const git = (dir: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', '-C', dir, ...args], { env: { ...process.env, ...gitEnv(root) } })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

const lines = (n: number, patch: Record<number, string> = {}) =>
  `${Array.from({ length: n }, (_, i) => patch[i + 1] ?? `line ${i + 1}`).join('\n')}\n`

const label = (defect: boolean, startLine = 20) => ({
  defect,
  location: defect ? { file: 'src/a.ts', startLine, endLine: startLine + 1 } : null,
  description: defect ? 'seat claims an off-by-one' : '',
  bugClass: 'logic' as const,
  severity: 'major' as const,
  reason: 'r',
  model: 'm',
})

function jsonl(file: string, rows: unknown[]) {
  const path = join(env.AGW_EVAL_DIR as string, 'review-gt', file)
  mkdirSync(join(env.AGW_EVAL_DIR as string, 'review-gt'), { recursive: true })
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`)
}

const bugCase = (n: number): GtBugCase => ({
  id: `case-${n}`,
  split: 'test',
  repo: 'SourceRoot/demo',
  sha: sha.intro as string,
  parent: sha.base as string,
  subject: 'feat: add the loop',
  minerVersion: 'm1',
  kind: 'bug',
  bug: {
    location: { file: 'src/a.ts', startLine: 20, endLine: 21 },
    description: `Case ${n}: the loop runs once too often`,
    bugClass: 'logic',
    severity: 'major',
    fixSha: sha.fix as string,
    fixSubject: 'fix: loop bound',
  },
  candidateId: `cand-ok-${n}`,
})

const candidate = (id: string, blamed = [{ file: 'src/a.ts', line: 22 }]): GtCandidate => ({
  id,
  repo: 'SourceRoot/demo',
  fixSha: sha.fix as string,
  fixSubject: 'fix: loop bound',
  fixDate: '2026-10-01T00:00:00+00:00',
  introSha: sha.intro as string,
  introParent: sha.base as string,
  introSubject: 'feat: add the loop',
  introDate: '2026-09-01T00:00:00+00:00',
  blamed,
  introChangedLines: 40,
  minerVersion: 'm1',
})

const finding = (id: string, message: string) => ({
  id,
  tag: 'important' as const,
  file: 'src/a.ts',
  line: 20,
  message,
})
const judgeRun = (
  n: number,
  caseId: string,
  classes: Record<string, JudgeOutput['findings'][number]['class']>,
  preselected: string[],
): JudgeRun => {
  const input: JudgeInput = {
    caseId,
    bug: { location: { file: 'src/a.ts', startLine: 20, endLine: 20 }, description: 'the loop runs once too often' },
    findings: Object.keys(classes).map((id) => finding(id, `message of ${id}`)),
    preselected,
    diff: 'diff',
  }
  const output: JudgeOutput = {
    findings: Object.entries(classes).map(([id, c]) => ({ id, class: c, reason: 'r' })),
    model: 'm',
  }
  return { runId: `judge-${n}`, evalRunId: 'eval-1', input, output }
}
const reader = (runs: JudgeRun[]): JudgeRunReader => ({ judgeRuns: async () => runs })

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agw-eval-gt-'))
  home = join(root, 'home')
  const repo = join(home, 'SourceRoot', 'demo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), 'demo\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  sha.base = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'src', 'a.ts'), lines(40))
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'feat: add the loop')
  sha.intro = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'src', 'a.ts'), lines(40, { 20: 'line 20 fixed' }))
  git(repo, 'commit', '-q', '-am', 'fix: loop bound')
  sha.fix = git(repo, 'rev-parse', 'HEAD')

  env = { AGW_EVAL_DIR: join(root, 'eval') }
  jsonl('cases.jsonl', [bugCase(1), bugCase(2), bugCase(3)])
  jsonl('candidates.jsonl', [
    candidate('cand-no-a'),
    candidate('cand-no-both', [
      { file: 'src/a.ts', line: 30 },
      { file: 'src/a.ts', line: 31 },
    ]),
  ])
  jsonl('rejected.jsonl', [
    { candidateId: 'cand-no-a', reason: 'a-no', labelerVersion: 'l1' },
    { candidateId: 'cand-no-both', reason: 'both-no', labelerVersion: 'l1' },
  ])
  jsonl('labels.jsonl', [
    {
      candidateId: 'cand-no-a',
      labelerVersion: 'l1',
      at: '2026-11-01T00:00:00.000Z',
      a: label(false),
      b: label(true, 25),
      runId: 'r',
    },
    {
      candidateId: 'cand-no-both',
      labelerVersion: 'l1',
      at: '2026-11-01T00:00:00.000Z',
      a: label(false),
      b: label(false),
      runId: 'r',
    },
  ])
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const deps = (runs: JudgeRun[]): PackDeps => ({
  env,
  exec,
  home,
  judgeRuns: reader(runs),
  now: () => new Date('2026-11-02T10:00:00Z'),
})
const RUNS = [
  judgeRun(1, 'case-1', { '0': 'match', '1': 'real', '2': 'nit' }, ['0', '1']),
  judgeRun(2, 'case-2', { '0': 'match', '1': 'not-a-bug' }, ['0', '1']),
]
const page = (html: string) => JSON.parse(/id="data">(.*?)<\/script>/s.exec(html)?.[1] ?? 'null')

describe('buildPack', () => {
  test('counts: cases, dropped candidates and half-and-half pairs; files private; the preselection rule holds', async () => {
    const result = await buildPack(deps(RUNS), { evalRuns: ['eval-1'], cases: 2, rejected: 2, pairs: 4, seed: 1 })
    expect(result.counts).toEqual({
      cases: 2,
      rejected: 2,
      pairs: 4,
      pairsJudgePositive: 2,
      pairsJudgeNegative: 2,
      total: 8,
    })
    expect(result.notes).toEqual([])
    expect(statSync(result.html).mode & 0o777).toBe(0o600)
    expect(statSync(result.dir).mode & 0o777).toBe(0o700)
    const manifest = JSON.parse(readFileSync(result.manifest, 'utf8'))
    const pairs = manifest.items.filter((i: { kind: string }) => i.kind === 'pair')
    // The nit that was not preselected is never a negative.
    expect(pairs.map((p: { id: string }) => p.id).sort()).toEqual([
      'case-1:judge-1:0',
      'case-1:judge-1:1',
      'case-2:judge-2:0',
      'case-2:judge-2:1',
    ])
    expect(pairs.find((p: { id: string }) => p.id === 'case-2:judge-2:1').judgeClass).toBe('not-a-bug')
  })

  test('the page is blind and carries the code: marked lines, ±15 and ±10, the fix diff', async () => {
    const result = await buildPack(deps(RUNS), { evalRuns: ['eval-1'], cases: 2, rejected: 2, pairs: 4, seed: 1 })
    const html = readFileSync(result.html, 'utf8')
    expect(html).not.toMatch(/accepted|rejected|not-a-bug|judgeClass/i)
    const data = page(html)
    expect(data.items).toHaveLength(8)
    const okCase = data.items.find((i: { id: string }) => i.id === 'cand-ok-1')
    expect(okCase.code[0].n).toBe(5)
    expect(okCase.code.at(-1).n).toBe(36)
    expect(okCase.code.filter((l: { mark: boolean }) => l.mark).map((l: { n: number }) => l.n)).toEqual([20, 21])
    expect(okCase.fixDiff).toContain('+line 20 fixed')
    expect(okCase.where).toBe('src/a.ts:20-21')
    const pair = data.items.find((i: { id: string }) => i.id === 'case-1:judge-1:0')
    expect(pair.bug.code.map((l: { n: number }) => l.n)).toEqual(Array.from({ length: 21 }, (_, i) => i + 10))
    expect(pair.finding.where).toBe('src/a.ts:20')
  })

  test('a dropped candidate shows seat a, else seat b, else the blamed lines and says nobody claimed a defect', async () => {
    const result = await buildPack(deps(RUNS), { evalRuns: ['eval-1'], cases: 0, rejected: 2, pairs: 0, seed: 1 })
    const items = page(readFileSync(result.html, 'utf8')).items
    const seatB = items.find((i: { id: string }) => i.id === 'cand-no-a')
    expect(seatB.claim).toBe('seat claims an off-by-one')
    expect(seatB.where).toBe('src/a.ts:25-26')
    const none = items.find((i: { id: string }) => i.id === 'cand-no-both')
    expect(none.claim).toContain('No labeller claimed a defect')
    expect(none.where).toBe('src/a.ts:30-31')
    expect(none.code.filter((l: { mark: boolean }) => l.mark).map((l: { n: number }) => l.n)).toEqual([30, 31])
  })

  test('fewer judge-positive pairs than half: all of them, negatives fill, the shortfall is said in the output and on the page', async () => {
    const result = await buildPack(deps(RUNS), { evalRuns: ['eval-1'], cases: 0, rejected: 0, pairs: 10, seed: 1 })
    expect(result.counts).toMatchObject({ pairsJudgePositive: 2, pairsJudgeNegative: 2, pairs: 4 })
    expect(result.notes.join('\n')).toContain('2 judge-positive pairs exist for a quota of 5')
    expect(result.notes.join('\n')).toContain('only 4 of 10 requested pairs exist')
    expect(readFileSync(result.html, 'utf8')).toContain('2 judge-positive pairs exist for a quota of 5')
  })

  test('fewer cases than asked: all are shown and it says so', async () => {
    const result = await buildPack(deps(RUNS), { evalRuns: ['eval-1'], cases: 50, rejected: 20, pairs: 0, seed: 1 })
    expect(result.counts).toMatchObject({ cases: 3, rejected: 2 })
    expect(result.notes).toHaveLength(2)
  })

  test('the same seed builds the same session', async () => {
    const a = await buildPack(deps(RUNS), { evalRuns: ['eval-1'], cases: 2, rejected: 1, pairs: 4, seed: 7 })
    const b = await buildPack(deps(RUNS), { evalRuns: ['eval-1'], cases: 2, rejected: 1, pairs: 4, seed: 7 })
    expect(b.sessionId).toBe(a.sessionId)
  })

  test('code that cannot be read does not stop the pack', async () => {
    const broken: Exec = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository\n' })
    const result = await buildPack(
      { ...deps(RUNS), exec: broken },
      { evalRuns: ['eval-1'], cases: 1, rejected: 0, pairs: 0, seed: 1 },
    )
    expect(page(readFileSync(result.html, 'utf8')).items[0].code).toContain('code unavailable')
  })

  test('nothing to show is an error that names why', async () => {
    const error = await buildPack(deps([]), { evalRuns: ['eval-1'], cases: 0, rejected: 0, pairs: 10, seed: 1 }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect((error as Error).message).toContain('nothing to show')
  })
})

describe('ingest', () => {
  const at = '2026-11-02T11:00:00.000Z'
  const line = (o: object) => JSON.stringify({ at, ...o })

  test('appends, reports case precision and kappa against the manifest, counts the unanswered', async () => {
    await buildPack(deps(RUNS), { evalRuns: ['eval-1'], cases: 2, rejected: 2, pairs: 4, seed: 1 })
    const labelsPath = join(env.AGW_EVAL_DIR as string, 'review-gt', 'owner-labels.jsonl')
    rmSync(labelsPath, { force: true })
    const manifest = JSON.parse(
      readFileSync(join(env.AGW_EVAL_DIR as string, 'review-gt', 'owner', 'manifest.json'), 'utf8'),
    )
    const text = manifest.items
      .map((i: { kind: string; id: string; truth?: string; judgeClass?: string }) => {
        if (i.kind === 'case')
          return line({ kind: 'case', candidateId: i.id, verdict: i.truth === 'accepted' ? 'yes' : 'no' })
        return line({ kind: 'pair', pairId: i.id, verdict: i.judgeClass === 'match' ? 'yes' : 'no', note: 'ok' })
      })
      .concat([line({ kind: 'case', candidateId: 'not-in-session', verdict: 'yes' })])
      .join('\n')
    const result = ingestLabels(env, `${text}\n`)
    expect(result).toMatchObject({ appended: 8, duplicates: 0, unknown: 1 })
    expect(result.report.cases.accepted).toMatchObject({ shown: 2, yes: 2, precision: 1 })
    expect(result.report.cases.rejected).toMatchObject({ shown: 2, no: 2, lost: 0 })
    expect(result.report.pairs.kappa).toBe(1)
    expect(result.report.bars).toMatchObject({ cases: { met: true }, kappa: { met: true } })
    expect(result.report.unanswered).toEqual({ cases: 0, pairs: 0 })
    expect(statSync(labelsPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(labelsPath, 'utf8').trim().split('\n')).toHaveLength(8)
  })

  test('ingesting the same export again appends nothing; a changed answer appends and wins', () => {
    const labelsPath = join(env.AGW_EVAL_DIR as string, 'review-gt', 'owner-labels.jsonl')
    const first = readFileSync(labelsPath, 'utf8')
    expect(ingestLabels(env, first)).toMatchObject({ appended: 0, duplicates: 8 })
    const changed = line({ kind: 'case', candidateId: 'cand-ok-1', verdict: 'no', at: '2026-11-02T12:00:00.000Z' })
    const result = ingestLabels(env, changed)
    expect(result.appended).toBe(1)
    expect(result.report.cases.accepted).toMatchObject({ yes: 1, no: 1, precision: 0.5 })
    expect(result.report.bars.cases.met).toBe(false)
  })

  test('one bad line refuses the file and appends nothing', () => {
    const labelsPath = join(env.AGW_EVAL_DIR as string, 'review-gt', 'owner-labels.jsonl')
    const before = readFileSync(labelsPath, 'utf8')
    const text = `${line({ kind: 'case', candidateId: 'cand-ok-2', verdict: 'maybe' })}\nnot json\n`
    expect(() => ingestLabels(env, text)).toThrow(/line 1: .*\n?.*line 2: not JSON|line 1/)
    expect(readFileSync(labelsPath, 'utf8')).toBe(before)
  })

  test('without a session there is nothing to ingest into', () => {
    expect(() =>
      ingestLabels({ AGW_EVAL_DIR: join(root, 'empty') }, line({ kind: 'case', candidateId: 'x', verdict: 'yes' })),
    ).toThrow('no owner session')
  })

  test('parseLabels reads what the page exports', () => {
    const exported = [
      { kind: 'case', candidateId: 'c', verdict: 'unsure', at, note: 'hmm' },
      { kind: 'pair', pairId: 'p', verdict: 'yes', at },
    ]
    expect(parseLabels(`${exported.map((e) => JSON.stringify(e)).join('\n')}\n`)).toEqual(exported as never)
  })
})
