import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultExec } from '../src/workflows/review/exec.ts'
import {
  baseFor,
  CLONE_ROOT,
  cloneDirFor,
  countChangedLines,
  ocrModeFor,
  prepare,
  type Prepared,
  type ReviewPorts,
  removeClone,
  sweepStaleClones,
} from '../src/workflows/review/git.ts'

const scratch = mkdtempSync(join(tmpdir(), 'agw-review-git-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString()
}

let seq = 0
const fresh = (name: string) => {
  const dir = join(scratch, `${name}-${++seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
const put = (dir: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
}

function ports(over: Partial<ReviewPorts> = {}): ReviewPorts {
  return { exec: defaultExec, which: () => null, env: {}, stateDir: fresh('state'), now: Date.now, ...over }
}

function repo(files: Record<string, string>) {
  const dir = fresh('repo')
  git(dir, 'init', '-q', '-b', 'main')
  put(dir, files)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  return dir
}

/** The state of a work tree that a review must leave alone. */
function snapshot(dir: string) {
  const index = join(dir, '.git', 'index')
  return {
    head: git(dir, 'rev-parse', 'HEAD').trim(),
    branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(),
    refs: git(dir, 'for-each-ref'),
    status: git(dir, 'status', '--porcelain'),
    index: existsSync(index) ? createHash('sha256').update(readFileSync(index)).digest('hex') : null,
    fetchHead: existsSync(join(dir, '.git', 'FETCH_HEAD')),
    worktrees: git(dir, 'worktree', 'list'),
  }
}

async function ok(input: Parameters<typeof prepare>[0], p = ports(), key = 'run:prepare'): Promise<Prepared> {
  const result = await prepare(input, key, p)
  if (!result.ok) throw new Error(`prepare failed: ${result.kind}: ${result.message}`)
  return result
}

describe('scopes', () => {
  test('uncommitted is staged and unstaged together plus untracked files, and leaves the index alone', async () => {
    const dir = repo({ 'a.ts': 'a1\n', 'b.ts': 'b1\n', 'c.ts': 'c1\n' })
    put(dir, { 'a.ts': 'a2\n' }) // unstaged
    put(dir, { 'b.ts': 'b2\n' })
    git(dir, 'add', 'b.ts') // staged
    put(dir, { 'new dir/n.ts': 'fresh\n' }) // untracked, with a space in the path
    put(dir, { '.gitignore': 'ignored.ts\n', 'ignored.ts': 'x\n' })
    const before = snapshot(dir)
    const p = await ok({ cwd: dir })
    expect(snapshot(dir)).toEqual(before)
    expect(p.label).toBe('uncommitted')
    expect(p.repo).toBe(dir)
    expect(p.clone).toBeNull()
    expect([...p.files].sort()).toEqual(['.gitignore', 'a.ts', 'b.ts', 'new dir/n.ts'])
    expect(p.diff).toContain('+a2')
    expect(p.diff).toContain('+b2')
    expect(p.diff).toContain('+fresh')
    expect(p.diff).not.toContain('ignored.ts\n+x')
    expect(p.changedLines).toBe(countChangedLines(p.diff))
    expect(p.ocr).toEqual({ mode: 'uncommitted', from: null, to: null })
  })

  test('a clean tree has an empty diff and no static-tool run', async () => {
    const dir = repo({ 'a.ts': 'a\n' })
    let fallowRuns = 0
    const p = await ok(
      { cwd: dir },
      ports({
        which: () => '/usr/bin/fallow',
        exec: (argv, o) => {
          if (argv[0] === 'fallow') fallowRuns++
          return defaultExec(argv, o)
        },
      }),
    )
    expect(p.diff).toBe('')
    expect(p.files).toEqual([])
    expect(fallowRuns).toBe(0)
  })

  test('a repo without a first commit reviews its staged files', async () => {
    const dir = fresh('unborn')
    git(dir, 'init', '-q', '-b', 'main')
    put(dir, { 'a.ts': 'a\n' })
    git(dir, 'add', 'a.ts')
    expect((await ok({ cwd: dir })).diff).toContain('+a')
  })

  test('head is the last commit; a bare ref is ref..HEAD; a range and a path pass through', async () => {
    const dir = repo({ 'a.ts': 'a1\n', 'b.ts': 'b1\n' })
    put(dir, { 'a.ts': 'a2\n' })
    git(dir, 'commit', '-qam', 'second')
    put(dir, { 'b.ts': 'b2\n' })
    git(dir, 'commit', '-qam', 'third')
    const head = await ok({ cwd: dir, scope: 'head' })
    expect(head.diff).toContain('+b2')
    expect(head.diff).not.toContain('+a2')
    expect(head.files).toEqual(['b.ts'])
    const ref = await ok({ cwd: dir, scope: 'HEAD~2' })
    expect([...ref.files].sort()).toEqual(['a.ts', 'b.ts'])
    expect(ref.base).toEqual({ kind: 'base', ref: 'HEAD~2' })
    const range = await ok({ cwd: dir, scope: 'HEAD~2..HEAD~1' })
    expect(range.files).toEqual(['a.ts'])
    expect(range.base).toEqual({ kind: 'skip' }) // fallow cannot review a range that ends elsewhere than HEAD
    const path = await ok({ cwd: dir, scope: 'b.ts' })
    expect(path.diff).toBe('') // a path scope is the working tree against the index: nothing is pending there
    expect(path.ocr).toBeNull()
  })

  test('a ref git cannot resolve is invalid_input, not a clean review', async () => {
    const dir = repo({ 'a.ts': 'a\n' })
    const result = await prepare({ cwd: dir, scope: 'no-such-ref' }, 'k', ports())
    expect(result).toMatchObject({ ok: false, kind: 'invalid_input' })
  })

  test('cwd must be a directory inside a git work tree', async () => {
    const plain = fresh('plain')
    expect(await prepare({ cwd: plain }, 'k', ports())).toMatchObject({ ok: false, kind: 'invalid_input' })
    expect(await prepare({ cwd: join(plain, 'missing') }, 'k', ports())).toMatchObject({
      ok: false,
      kind: 'invalid_input',
    })
    const file = join(plain, 'f')
    writeFileSync(file, 'x')
    expect(await prepare({ cwd: file }, 'k', ports())).toMatchObject({ ok: false, kind: 'invalid_input' })
  })

  test('package.json decides the qa floor', async () => {
    const withTests = repo({ 'package.json': '{"scripts":{"test":"bun test"}}\n', 'a.ts': 'a\n' })
    put(withTests, { 'a.ts': 'b\n' })
    expect((await ok({ cwd: withTests })).hasTestScript).toBe(true)
    const without = repo({ 'package.json': '{}\n', 'a.ts': 'a\n' })
    put(without, { 'a.ts': 'b\n' })
    expect((await ok({ cwd: without })).hasTestScript).toBe(false)
  })

  test('the pure scope helpers', () => {
    expect(baseFor('uncommitted')).toEqual({ kind: 'base', ref: 'HEAD' })
    expect(baseFor('head')).toEqual({ kind: 'base', ref: 'HEAD~1' })
    expect(baseFor('main..HEAD')).toEqual({ kind: 'base', ref: 'main' })
    expect(baseFor('main..')).toEqual({ kind: 'base', ref: 'main' })
    expect(baseFor('..HEAD')).toEqual({ kind: 'skip' })
    expect(baseFor('src/a.ts')).toEqual({ kind: 'auto' })
    expect(ocrModeFor('head', null)).toEqual({ mode: 'head', from: null, to: null })
    expect(ocrModeFor('main..', null)).toEqual({ mode: 'range', from: 'main', to: 'HEAD' })
    expect(ocrModeFor('pr:3', 'abc123')).toEqual({ mode: 'range', from: 'abc123', to: 'HEAD' })
    expect(ocrModeFor('..HEAD', null)).toBeNull()
    expect(countChangedLines('--- a/x\n+++ b/x\n@@\n+one\n-two\n context\n')).toBe(2)
  })
})

describe('pr and branch mode', () => {
  /** An origin with main and a feature branch that is also a PR head; a working clone of it on main. */
  function origin() {
    const bare = fresh('origin')
    git(bare, 'init', '-q', '--bare', '-b', 'main')
    const seed = fresh('seed')
    git(seed, 'init', '-q', '-b', 'main')
    put(seed, { 'a.ts': 'a1\n', 'keep.ts': 'k\n' })
    git(seed, 'add', '-A')
    git(seed, 'commit', '-q', '-m', 'base')
    git(seed, 'remote', 'add', 'origin', bare)
    git(seed, 'push', '-q', 'origin', 'main')
    git(seed, 'checkout', '-q', '-b', 'feat')
    put(seed, { 'a.ts': 'a2\n', 'added.ts': 'new\n' })
    git(seed, 'add', '-A')
    git(seed, 'commit', '-q', '-m', 'feature')
    git(seed, 'push', '-q', 'origin', 'feat', 'feat:refs/pull/7/head')
    const cwd = fresh('work')
    git(scratch, 'clone', '-q', bare, cwd)
    return { bare, cwd }
  }

  test('pr: a throwaway shared clone with the PR checked out; cwd keeps its HEAD, index, refs and worktrees', async () => {
    const { cwd } = origin()
    put(cwd, { 'wip.ts': 'my own work\n' }) // the caller's uncommitted state must survive too
    const before = snapshot(cwd)
    const p = ports()
    const prepared = await ok({ cwd, pr: 7 }, p, 'run-a:prepare')
    expect(snapshot(cwd)).toEqual(before)
    expect(prepared.label).toBe('pr:7')
    expect(prepared.clone).toBe(prepared.repo)
    expect(prepared.repo.startsWith(join(p.stateDir, CLONE_ROOT))).toBe(true)
    expect([...prepared.files].sort()).toEqual(['a.ts', 'added.ts'])
    expect(prepared.diff).toContain('+a2')
    expect(prepared.diff).not.toContain('wip.ts')
    expect(readFileSync(join(prepared.repo, 'a.ts'), 'utf8')).toBe('a2\n') // the agents read the PR's files
    expect(git(prepared.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD') // detached
    expect(prepared.ocr?.mode).toBe('range')
    expect(prepared.base.kind).toBe('base')
    removeClone(p, prepared.clone as string)
    expect(existsSync(prepared.repo)).toBe(false)
    expect(snapshot(cwd)).toEqual(before)
  })

  test('branch: the same, from a remote branch', async () => {
    const { cwd } = origin()
    const before = snapshot(cwd)
    const prepared = await ok({ cwd, branch: 'feat' })
    expect(snapshot(cwd)).toEqual(before)
    expect(prepared.label).toBe('branch:feat')
    expect(prepared.diff).toContain('+new')
    expect(readdirSync(join(prepared.repo, '..'))).toHaveLength(1)
  })

  test('a repeat of the same step key starts from a clean clone', async () => {
    const { cwd } = origin()
    const p = ports()
    const first = await ok({ cwd, pr: 7 }, p, 'same:prepare')
    writeFileSync(join(first.repo, 'stray.txt'), 'left by a crashed attempt')
    const second = await ok({ cwd, pr: 7 }, p, 'same:prepare')
    expect(second.repo).toBe(first.repo)
    expect(existsSync(join(second.repo, 'stray.txt'))).toBe(false)
  })

  test('a PR that does not exist is an error and leaves no clone behind', async () => {
    const { cwd } = origin()
    const p = ports()
    const result = await prepare({ cwd, pr: 999 }, 'k:prepare', p)
    expect(result).toMatchObject({ ok: false, kind: 'error' })
    expect((result as { message: string }).message).toContain('pull/999/head')
    expect(readdirSync(join(p.stateDir, CLONE_ROOT))).toEqual([])
  })

  test('no origin remote is an error', async () => {
    const dir = repo({ 'a.ts': 'a\n' })
    const result = await prepare({ cwd: dir, pr: 1 }, 'k:prepare', ports())
    expect(result).toMatchObject({ ok: false, kind: 'error' })
    expect((result as { message: string }).message).toContain('no origin remote')
  })
})

describe('clone housekeeping', () => {
  test('the next prepare sweeps clones older than a day, never a fresh one or the run’s own', async () => {
    const p = ports()
    const root = join(p.stateDir, CLONE_ROOT)
    const old = join(root, 'crashed')
    const young = join(root, 'running')
    const own = cloneDirFor(p, 'mine:prepare').dir
    for (const d of [old, young, own]) mkdirSync(d, { recursive: true })
    const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000)
    utimesSync(old, twoDaysAgo, twoDaysAgo)
    utimesSync(own, twoDaysAgo, twoDaysAgo)
    expect(sweepStaleClones(p, own)).toEqual([old])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(young)).toBe(true)
    expect(existsSync(own)).toBe(true)
    // prepare runs the sweep for every review, scope mode included
    utimesSync(young, twoDaysAgo, twoDaysAgo)
    const dir = repo({ 'a.ts': 'a\n' })
    await ok({ cwd: dir }, p, 'other:prepare')
    expect(existsSync(young)).toBe(false)
  })

  test('removeClone refuses a path outside the clone root', () => {
    const p = ports()
    const outside = fresh('precious')
    expect(() => removeClone(p, outside)).toThrow('refusing to remove')
    expect(() => removeClone(p, join(p.stateDir, CLONE_ROOT))).toThrow('refusing to remove')
    expect(existsSync(outside)).toBe(true)
  })
})
