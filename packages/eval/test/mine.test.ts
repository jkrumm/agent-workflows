import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  acceptRecord,
  DEV_SHARE,
  type Exec,
  exec,
  type GtCandidate,
  type GtLabel,
  type GtLabelRecord,
  mine,
  discoverRepos,
  splitOf,
} from '../src/index.ts'
import { controlCase, type MineControl, pickControls } from '../src/mine/controls.ts'
import { removedLines } from '../src/mine/patch.ts'
import { isBugFixSubject, isCodeFile, isFixSubject, isWeakSubject } from '../src/mine/subjects.ts'

const OWNER = 'me@example.com'
const OTHER = 'other@example.com'
const NOW = new Date('2026-11-02T12:00:00Z')

let sandbox: string
let isolatedHome: string
let root: string
/** Git for the fixtures and for the miner: no user or system config reaches either. */
const isolated: Exec = (cmd, args, options = {}) =>
  exec(cmd, args, {
    ...options,
    env: { ...options.env, HOME: isolatedHome, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })

const git = (repo: string, args: string[], env: Record<string, string> = {}) => {
  const ran = Bun.spawnSync(['git', '-C', repo, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: isolatedHome,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...env,
    },
  })
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`)
  return ran.stdout.toString().trim()
}

interface Change {
  /** Path → content; null deletes. */
  files: Record<string, string | null>
  message: string
  date: string
  by?: string
}

function commit(repo: string, change: Change): string {
  for (const [path, content] of Object.entries(change.files)) {
    const full = join(repo, path)
    if (content === null) rmSync(full, { force: true })
    else {
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
    }
  }
  const email = change.by ?? OWNER
  const when = `${change.date}T10:00:00+0000`
  git(repo, ['add', '-A'])
  git(repo, ['commit', '--quiet', '--allow-empty-message', '-m', change.message], {
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: when,
  })
  return git(repo, ['rev-parse', 'HEAD'])
}

const sha = {} as Record<string, string>
const shaOf = (key: string) => sha[key] as string

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'agw-mine-test-'))
  isolatedHome = join(sandbox, 'home')
  mkdirSync(isolatedHome)
  root = join(sandbox, 'root')
  const repo = join(root, 'alpha')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '--quiet', '--initial-branch=main'])
  commit(repo, { files: { 'README.md': '# alpha\n' }, message: 'chore: init', date: '2026-01-01' })

  // A: a fix whose blame lands on an owner commit.
  sha.introA = commit(repo, {
    files: { 'src/a.ts': 'export function add(a: number, b: number) {\n  return a - b\n}\n' },
    message: 'feat: add\n\nBody of the intro.',
    date: '2026-09-01',
  })
  sha.fixA = commit(repo, {
    files: { 'src/a.ts': 'export function add(a: number, b: number) {\n  return a + b\n}\n' },
    message: 'fix: add subtracts',
    date: '2026-09-20',
  })

  // B: a fix that only touches a comment, a blank line and indentation.
  commit(repo, {
    files: { 'src/b.ts': '// helper\n\nexport function id(x: number) {\nreturn x\n}\n' },
    message: 'feat: id',
    date: '2026-09-02',
  })
  commit(repo, {
    files: { 'src/b.ts': '// the helper\nexport function id(x: number) {\n  return x\n}\n' },
    message: 'fix: tidy b',
    date: '2026-09-21',
  })

  // C: an additions-only fix.
  commit(repo, {
    files: { 'src/c.ts': 'export function head(xs: number[]) {\n  return xs[0]\n}\n' },
    message: 'feat: head',
    date: '2026-09-03',
  })
  commit(repo, {
    files: {
      'src/c.ts': 'export function head(xs: number[]) {\n  if (xs.length === 0) return undefined\n  return xs[0]\n}\n',
    },
    message: 'fix: head of empty list',
    date: '2026-09-22',
  })

  // D: the introducing commit is somebody else's.
  commit(repo, {
    files: { 'src/d.ts': 'export const limit = 10\n' },
    message: 'feat: limit',
    date: '2026-09-04',
    by: OTHER,
  })
  commit(repo, {
    files: { 'src/d.ts': 'export const limit = 100\n' },
    message: 'fix: limit too low',
    date: '2026-09-23',
  })

  // E: the introducing commit is older than 26 weeks at the fix.
  commit(repo, { files: { 'src/e.ts': 'export const retries = 0\n' }, message: 'feat: retries', date: '2026-01-10' })
  commit(repo, { files: { 'src/e.ts': 'export const retries = 3\n' }, message: 'fix: retries', date: '2026-09-30' })

  // F: a mass reformat in between is looked past.
  sha.introF = commit(repo, {
    files: { 'src/f.ts': 'export const label = "bad" + suffix\n' },
    message: 'feat: label',
    date: '2026-05-01',
  })
  sha.formatF = commit(repo, {
    files: { 'src/f.ts': "export const label = 'bad' + suffix\n" },
    message: 'style: format with prettier',
    date: '2026-05-10',
  })
  sha.fixF = commit(repo, {
    files: { 'src/f.ts': "export const label = 'good' + suffix\n" },
    message: 'fix: wrong label',
    date: '2026-06-01',
  })

  // A wide commit that only re-spaces: no matching subject, 20 files.
  const wide: Record<string, string> = {}
  for (let i = 0; i < 20; i++) wide[`wide/w${i}.ts`] = `export const w${i} = ${i}\nexport const x${i} = ${i}\n`
  commit(repo, { files: wide, message: 'feat: wide files', date: '2026-04-01' })
  const spaced: Record<string, string> = {}
  for (let i = 0; i < 20; i++) spaced[`wide/w${i}.ts`] = `  export const w${i} = ${i}\n  export const x${i} = ${i}\n`
  sha.wideReformat = commit(repo, { files: spaced, message: 'chore: tidy up', date: '2026-04-02' })

  // Fix commits the message filter drops; they touch lines that would blame to an owner commit.
  commit(repo, {
    files: { 'package.json': '{"dependencies":{"x":"1.0.0"}}\n' },
    message: 'feat: dep',
    date: '2026-08-01',
  })
  commit(repo, {
    files: { 'package.json': '{"dependencies":{"x":"1.1.0"}}\n' },
    message: 'fix(deps): bump x',
    date: '2026-08-05',
  })
  commit(repo, { files: { 'src/t.ts': 'export const msg = "recieve"\n' }, message: 'feat: msg', date: '2026-08-02' })
  commit(repo, {
    files: { 'src/t.ts': 'export const msg = "receive"\n' },
    message: 'fix: typo in msg',
    date: '2026-08-06',
  })

  // Controls: an old logic commit nobody fixed, and one that is too recent.
  sha.controlOld = commit(repo, {
    files: { 'src/g.ts': 'export const g = (n: number) => n * 2\n' },
    message: 'feat: double',
    date: '2026-07-01',
  })
  sha.controlRecent = commit(repo, {
    files: { 'src/h.ts': 'export const h = (n: number) => n * 3\n' },
    message: 'feat: triple',
    date: '2026-10-25',
  })

  // Repos that are not mined.
  for (const name of ['brain', '.hidden', 'dispatch-scratch', 'dotfiles-private']) {
    const other = join(root, name)
    mkdirSync(other)
    git(other, ['init', '--quiet'])
    commit(other, { files: { 'x.ts': 'x\n' }, message: 'fix: x', date: '2026-09-01' })
  }
  mkdirSync(join(root, 'plain'))
  git(repo, ['worktree', 'add', '--quiet', join(root, 'linked'), '-b', 'wt'])
})

afterAll(() => rmSync(sandbox, { recursive: true, force: true }))

const run = (overrides: Partial<Parameters<typeof mine>[0]> = {}) =>
  mine({ root, exec: isolated, now: NOW, seed: 1, ownerEmails: [OWNER], ...overrides })

describe('discoverRepos', () => {
  test('only direct git checkouts, minus the excluded names, dot dirs and linked worktrees', () => {
    expect(discoverRepos(root).map((r) => r.name)).toEqual(['SourceRoot/alpha'])
  })
})

describe('mine', () => {
  test('a fix whose blame lands on an owner commit is a candidate', async () => {
    const { candidates } = await run()
    const a = candidates.find((c) => c.fixSha === sha.fixA)
    expect(a).toMatchObject({
      id: `alpha-${sha.fixA?.slice(0, 10)}-${sha.introA?.slice(0, 10)}`,
      repo: 'SourceRoot/alpha',
      introSha: sha.introA,
      introSubject: 'feat: add',
      fixSubject: 'fix: add subtracts',
      blamed: [{ file: 'src/a.ts', line: 2 }],
      minerVersion: expect.any(String),
    })
    expect(a?.introParent).toMatch(/^[0-9a-f]{40}$/)
    expect(a?.introChangedLines).toBe(3)
  })

  test('cosmetic-only, additions-only, non-owner, too-old and message-filtered fixes yield no candidate', async () => {
    const { candidates, funnel } = await run()
    expect(candidates.map((c) => c.fixSubject).sort()).toEqual(['fix: add subtracts', 'fix: wrong label'])
    expect(funnel).toMatchObject({
      repos: 1,
      fixCommits: 8,
      afterMessageFilter: 6,
      droppedNotOwner: 1,
      droppedTooOld: 1,
      droppedMerge: 0,
      droppedTooLarge: 0,
      candidates: 2,
    })
    // tidy b (comments, blank, indentation) and head (additions only) have nothing to blame.
    expect(funnel.fixesWithRemovableLines).toBe(4)
    expect(funnel.droppedCosmeticLines).toBeGreaterThan(0)
  })

  test('a mass reformat is looked past, not blamed', async () => {
    const { candidates, funnel } = await run()
    const f = candidates.find((c) => c.fixSha === sha.fixF)
    expect(f?.introSha).toBe(sha.introF)
    expect(f?.introSubject).toBe('feat: label')
    // The prettier commit by subject and the 20-file re-spacing by numstat.
    expect(funnel.ignoredReformats).toBe(2)
  })

  test('a control is chosen and a blamed commit is not', async () => {
    const { controls, candidates } = await run()
    const ids = controls.map((c) => c.sha)
    expect(ids).toContain(shaOf('controlOld'))
    expect(ids).not.toContain(shaOf('controlRecent'))
    for (const blamed of [sha.introA, sha.introF]) expect(ids).not.toContain(blamed as string)
    for (const c of candidates) expect(ids).not.toContain(c.introSha)
    expect(ids).not.toContain(shaOf('wideReformat'))
    expect(controls.find((c) => c.sha === sha.controlOld)).toMatchObject({
      id: `alpha-control-${sha.controlOld?.slice(0, 10)}`,
      repo: 'SourceRoot/alpha',
      subject: 'feat: double',
    })
  })

  test('the same history and seed give the same result; controls honour the count', async () => {
    const first = await run({ controls: 3 })
    const second = await run({ controls: 3 })
    expect(second).toEqual(first)
    expect(first.controls).toHaveLength(3)
    expect(first.funnel.controls).toBe(3)
    expect(first.funnel.controlsEligible).toBeGreaterThan(3)
  })

  test('the owner emails are configurable and case-insensitive', async () => {
    const none = await run({ ownerEmails: ['nobody@example.com'] })
    expect(none.candidates).toEqual([])
    const upper = await run({ ownerEmails: [OWNER.toUpperCase(), OTHER] })
    expect(upper.candidates.some((c) => c.introSubject === 'feat: limit')).toBe(true)
  })
})

describe('split', () => {
  test('deterministic by id, and near DEV_SHARE', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `alpha-${i}`)
    expect(ids.map(splitOf)).toEqual(ids.map(splitOf))
    const dev = ids.filter((id) => splitOf(id) === 'dev').length / ids.length
    expect(Math.abs(dev - DEV_SHARE)).toBeLessThan(0.04)
  })

  test('a control case takes the same rule', () => {
    const control: MineControl = {
      id: 'alpha-control-0123456789',
      repo: 'SourceRoot/alpha',
      dir: 'alpha',
      sha: 'a'.repeat(40),
      parent: 'b'.repeat(40),
      subject: 'feat: x',
    }
    expect(controlCase(control)).toMatchObject({ kind: 'control', split: splitOf(control.id), sha: control.sha })
  })
})

describe('pickControls', () => {
  const make = (n: number, subject: string): MineControl[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `r-control-${subject.replace(/\W/g, '')}${i}`,
      repo: 'SourceRoot/r',
      dir: 'r',
      sha: String(i).padStart(40, '0'),
      parent: 'f'.repeat(40),
      subject: `${subject} ${i}`,
    }))

  test('at most 15 % with a docs, test, refactor or chore type', () => {
    const eligible = [...make(30, 'test: more'), ...make(30, 'refactor: split'), ...make(30, 'feat: logic')]
    const picked = pickControls(eligible, { count: 20, seed: 7 })
    expect(picked).toHaveLength(20)
    expect(picked.filter((c) => isWeakSubject(c.subject))).toHaveLength(3)
    expect(pickControls(eligible, { count: 20, seed: 7 })).toEqual(picked)
    expect(pickControls(eligible, { count: 20, seed: 8 })).not.toEqual(picked)
  })

  test('takes fewer when too few strong ones exist', () => {
    const picked = pickControls([...make(10, 'chore: x'), ...make(2, 'fix: y')], { count: 20, seed: 1 })
    expect(picked).toHaveLength(2 + Math.floor(20 * 0.15))
  })
})

describe('subjects and files', () => {
  test('fix, revert and the exclusions', () => {
    expect(['fix: x', 'Fix(api)!: x', 'revert: x', 'Revert "feat: y"', 'revert(core): z'].every(isFixSubject)).toBe(
      true,
    )
    expect(['feat: fix x', 'fixup! x', 'chore: revert'].some(isFixSubject)).toBe(false)
    expect(isBugFixSubject('fix(api): null deref')).toBe(true)
    for (const subject of [
      'fix(deps): bump a',
      'fix(ci): runner',
      'fix(docs): link',
      'fix: typo in label',
      'fix(lint): unused',
      'fix: format output',
      'fix: fmt',
      'fix(release): tag',
      'fix(style): spacing',
    ]) {
      expect(isBugFixSubject(subject)).toBe(false)
    }
  })

  test('code files', () => {
    for (const path of [
      'README.md',
      'a.mdx',
      'n.txt',
      'bun.lock',
      'package-lock.json',
      'a.snap',
      'logo.svg',
      'docs/x.ts',
      'a/docs/b.ts',
    ]) {
      expect(isCodeFile(path)).toBe(false)
    }
    for (const path of ['src/a.ts', 'package.json', 'Makefile', 'docsite/a.ts']) expect(isCodeFile(path)).toBe(true)
  })
})

describe('removedLines', () => {
  const header = (file: string) => `diff --git a/${file} b/${file}\nindex 1..2 100644\n--- a/${file}\n+++ b/${file}\n`

  test('changed and removed lines, additions-only hunks skipped, comments and blanks dropped', () => {
    const patch = `${header('src/x.ts')}@@ -3 +3 @@\n-  return a - b\n+  return a + b\n@@ -9,0 +10,2 @@\n+  guard()\n+  more()\n@@ -20,3 +22,0 @@\n-// old comment\n-\n-  call()\n`
    const lines = removedLines(patch)
    expect(lines.files).toEqual([
      {
        file: 'src/x.ts',
        ranges: [
          { start: 3, end: 3 },
          { start: 22, end: 22 },
        ],
      },
    ])
    expect(lines.removed).toBe(4)
    expect(lines.cosmetic).toBe(2)
  })

  test('a hunk that only re-spaces is cosmetic; a new file and a prose file are skipped', () => {
    const respaced = `${header('src/y.ts')}@@ -1,2 +1,2 @@\n-const a=1\n-const b = 2\n+const a = 1\n+const b=2\n`
    expect(removedLines(respaced).files).toEqual([])
    const created = 'diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+x\n'
    expect(removedLines(created).files).toEqual([])
    const prose = `${header('README.md')}@@ -1 +1 @@\n-old\n+new\n`
    expect(removedLines(prose)).toEqual({ files: [], removed: 1, cosmetic: 1 })
  })

  test('a removed line starting with dashes is body, not a header', () => {
    const patch = `${header('q.sql')}@@ -4,2 +4,0 @@\n--- note\n-select 1\n`
    expect(removedLines(patch).files).toEqual([{ file: 'q.sql', ranges: [{ start: 4, end: 5 }] }])
  })
})

describe('acceptRecord', () => {
  const candidate: GtCandidate = {
    id: 'alpha-1111111111-2222222222',
    repo: 'SourceRoot/alpha',
    fixSha: '1'.repeat(40),
    fixSubject: 'fix: x',
    fixDate: '2026-09-20T10:00:00+00:00',
    introSha: '2'.repeat(40),
    introParent: '3'.repeat(40),
    introSubject: 'feat: x',
    introDate: '2026-09-01T10:00:00+00:00',
    blamed: [{ file: 'src/a.ts', line: 2 }],
    introChangedLines: 3,
    minerVersion: 'v',
  }
  const yes = (file: string, startLine: number, endLine: number, description = 'd'): GtLabel & { model: string } => ({
    defect: true,
    location: { file, startLine, endLine },
    description,
    bugClass: 'logic',
    severity: 'major',
    reason: 'r',
    model: 'm',
  })
  const no: GtLabel & { model: string } = {
    defect: false,
    location: null,
    description: '',
    bugClass: 'other',
    severity: 'minor',
    reason: 'r',
    model: 'm',
  }
  const record = (a: GtLabelRecord['a'], b: GtLabelRecord['b']): GtLabelRecord => ({
    candidateId: candidate.id,
    labelerVersion: 'L1',
    at: '2026-11-02T12:00:00.000Z',
    a,
    b,
    runId: 'run-1',
  })
  const reason = (r: GtLabelRecord) => {
    const out = acceptRecord(r, candidate)
    return out.accepted ? 'accepted' : out.rejected.reason
  }

  test('both yes with overlapping locations: a bug case from seat a', () => {
    const out = acceptRecord(
      record({ ...yes('src/a.ts', 2, 4, 'from a'), severity: 'critical' }, yes('./src/a.ts', 5, 9, 'from b')),
      candidate,
    )
    expect(out.accepted).toBe(true)
    if (!out.accepted) return
    expect(out.case).toMatchObject({
      kind: 'bug',
      id: candidate.id,
      candidateId: candidate.id,
      split: splitOf(candidate.id),
      repo: 'SourceRoot/alpha',
      sha: candidate.introSha,
      parent: candidate.introParent,
      subject: 'feat: x',
      bug: {
        location: { file: 'src/a.ts', startLine: 2, endLine: 4 },
        description: 'from a',
        bugClass: 'logic',
        severity: 'critical',
        fixSha: candidate.fixSha,
        fixSubject: 'fix: x',
      },
    })
  })

  test('the rejection reasons', () => {
    expect(reason(record(no, yes('a.ts', 1, 2)))).toBe('a-no')
    expect(reason(record(yes('a.ts', 1, 2), no))).toBe('b-no')
    expect(reason(record(no, no))).toBe('both-no')
    expect(reason(record({ error: 'boom' }, yes('a.ts', 1, 2)))).toBe('labeler-error')
    expect(reason(record(yes('a.ts', 1, 2), { error: 'boom' }))).toBe('labeler-error')
    expect(reason(record(yes('a.ts', 1, 2), yes('b.ts', 1, 2)))).toBe('no-overlap')
    expect(reason(record(yes('a.ts', 1, 2), yes('a.ts', 20, 30)))).toBe('no-overlap')
  })

  test('the slack is inclusive at LOCATION_SLACK lines', () => {
    expect(reason(record(yes('a.ts', 1, 2), yes('a.ts', 5, 6)))).toBe('accepted')
    expect(reason(record(yes('a.ts', 1, 2), yes('a.ts', 6, 7)))).toBe('no-overlap')
    expect(reason(record(yes('a.ts', 10, 12), yes('a.ts', 4, 7)))).toBe('accepted')
  })

  test('the rejection carries the labeler version', () => {
    const out = acceptRecord(record(no, no), candidate)
    expect(out).toEqual({
      accepted: false,
      rejected: { candidateId: candidate.id, reason: 'both-no', labelerVersion: 'L1' },
    })
  })
})
