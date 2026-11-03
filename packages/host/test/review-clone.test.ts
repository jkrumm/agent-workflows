import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExec, defaultExec } from '../src/process.ts'
import {
  CLONE_ROOT,
  cloneDirFor,
  cloneForRef,
  removeClone,
  removeEscapingSymlinks,
  type ReviewPorts,
  sweepStaleClones,
} from '../src/review/clone.ts'
import { branchProblem, scopeProblem, splitRange } from '../src/review/scope.ts'

// realpath'd: the clone root is one spelling everywhere (macOS tmpdir is a symlink)
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'agw-review-clone-')))
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
  return { exec: defaultExec, env: {}, stateDir: fresh('state'), now: Date.now, ...over }
}

/**
 * An origin with main and a feature branch that is also the head of pull request `pr`, and a working clone of it.
 * `feature` adds commits on top of `a1`.
 */
function origin(
  pr: number,
  feature: (seed: string) => void = (seed) => put(seed, { 'a.ts': 'a2\n', 'added.ts': 'new\n' }),
) {
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
  feature(seed)
  git(seed, 'add', '-A')
  git(seed, 'commit', '-q', '-m', 'feature')
  git(seed, 'push', '-q', 'origin', 'feat', `feat:refs/pull/${pr}/head`)
  const cwd = fresh('work')
  git(scratch, 'clone', '-q', bare, cwd)
  return { bare, seed, cwd }
}

/** The state of a work tree that a clone must leave alone. */
function snapshot(dir: string) {
  return {
    head: git(dir, 'rev-parse', 'HEAD').trim(),
    refs: git(dir, 'for-each-ref'),
    status: git(dir, 'status', '--porcelain'),
    fetchHead: existsSync(join(dir, '.git', 'FETCH_HEAD')),
    worktrees: git(dir, 'worktree', 'list'),
  }
}

async function cloned(
  cwd: string,
  ref: { pr?: number; branch?: string },
  p = ports(),
  key = 'run:prepare',
  expected?: { headOid: string; baseOid: string },
) {
  const made = await cloneForRef(p, cwd, key, ref, expected)
  if ('error' in made) throw new Error(`clone failed: ${made.error}`)
  return made
}

describe('cloneForRef', () => {
  test('pr: a throwaway shared clone with the PR checked out; cwd keeps its HEAD, index, refs and worktrees', async () => {
    const { cwd } = origin(7)
    put(cwd, { 'wip.ts': 'my own work\n' }) // the caller's uncommitted state must survive too
    const before = snapshot(cwd)
    const p = ports()
    const made = await cloned(cwd, { pr: 7 }, p, 'run-a:prepare')
    expect(snapshot(cwd)).toEqual(before)
    expect(made.dir.startsWith(join(p.stateDir, CLONE_ROOT))).toBe(true)
    expect(readFileSync(join(made.dir, 'a.ts'), 'utf8')).toBe('a2\n')
    expect(existsSync(join(made.dir, 'wip.ts'))).toBe(false)
    expect(git(made.dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD') // detached
    expect(git(made.dir, 'rev-parse', 'HEAD').trim()).toBe(made.headOid)
    expect(git(made.dir, 'merge-base', made.baseOid, made.headOid).trim()).toBe(made.baseOid)
    removeClone(p, made.dir)
    expect(existsSync(made.dir)).toBe(false)
    expect(snapshot(cwd)).toEqual(before)
  })

  test('branch: the same, from a remote branch', async () => {
    const { cwd } = origin(7)
    const before = snapshot(cwd)
    const made = await cloned(cwd, { branch: 'feat' })
    expect(snapshot(cwd)).toEqual(before)
    expect(readFileSync(join(made.dir, 'added.ts'), 'utf8')).toBe('new\n')
    expect(readdirSync(join(made.dir, '..'))).toHaveLength(1)
  })

  test('a repeat of the same step key starts from a clean clone', async () => {
    const { cwd } = origin(7)
    const p = ports()
    const first = await cloned(cwd, { pr: 7 }, p, 'same:prepare')
    writeFileSync(join(first.dir, 'stray.txt'), 'left by a crashed attempt')
    const second = await cloned(cwd, { pr: 7 }, p, 'same:prepare')
    expect(second.dir).toBe(first.dir)
    expect(existsSync(join(second.dir, 'stray.txt'))).toBe(false)
  })

  test('a PR that does not exist is an error and leaves no clone behind', async () => {
    const { cwd } = origin(7)
    const p = ports()
    const made = await cloneForRef(p, cwd, 'k:prepare', { pr: 999 })
    expect(made).toHaveProperty('error')
    expect((made as { error: string }).error).toContain('pull/999/head')
    expect(readdirSync(join(p.stateDir, CLONE_ROOT))).toEqual([])
  })

  test('no origin remote is an error', async () => {
    const dir = fresh('plain')
    git(dir, 'init', '-q', '-b', 'main')
    put(dir, { 'a.ts': 'a\n' })
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'base')
    const made = await cloneForRef(ports(), dir, 'k:prepare', { pr: 1 })
    expect((made as { error: string }).error).toContain('no origin remote')
  })

  test('a journaled commit pair is fetched again by id when the PR moved on', async () => {
    const { cwd, seed } = origin(9)
    const p = ports()
    const first = await cloned(cwd, { pr: 9 }, p, 'r:prepare')
    removeClone(p, first.dir)
    put(seed, { 'a.ts': 'a3\n' })
    git(seed, 'commit', '-qam', 'force-pushed later')
    git(seed, 'push', '-q', '-f', 'origin', 'feat:refs/pull/9/head')
    const again = await cloneForRef(p, cwd, 'r:prepare', { pr: 9 }, { headOid: first.headOid, baseOid: first.baseOid })
    // a server that refuses a fetch by id gives a clear error, never a silent other commit
    if ('error' in again) expect(again.error).toContain('cannot be fetched again')
    else expect(again.headOid).toBe(first.headOid)
  })

  test('fetch and ls-remote get SSH_AUTH_SOCK and XDG_CONFIG_HOME; clone and checkout do not', async () => {
    const { cwd } = origin(2)
    const seen: { sub: string; net: boolean }[] = []
    const env = { PATH: process.env.PATH, SSH_AUTH_SOCK: '/tmp/agent.sock', XDG_CONFIG_HOME: '/home/x/.config' }
    const p = ports({
      env,
      exec: (argv, o) => {
        const sub = argv.find((a, i) => i > 0 && !a.startsWith('-') && !a.startsWith('core.')) ?? argv[0] ?? ''
        seen.push({ sub, net: Boolean(o.env?.SSH_AUTH_SOCK) })
        return createExec(env)(argv, { ...o, env: { ...o.env, SSH_AUTH_SOCK: o.env?.SSH_AUTH_SOCK ?? '' } })
      },
    })
    await cloned(cwd, { pr: 2 }, p)
    const withNet = new Set(seen.filter((s) => s.net).map((s) => s.sub))
    expect([...withNet].sort()).toEqual(['fetch', 'ls-remote'])
    expect(seen.some((s) => s.sub === 'clone' && !s.net)).toBe(true)
    expect(seen.some((s) => s.sub === 'checkout' && !s.net)).toBe(true)
  })

  test('a throw after the clone directory exists removes it and comes back as the error', async () => {
    const { cwd } = origin(6)
    const p = ports({
      exec: (argv, o) => {
        if (argv.includes('checkout')) throw new Error('boom in checkout')
        return defaultExec(argv, o)
      },
    })
    const made = await cloneForRef(p, cwd, 'k:prepare', { pr: 6 })
    expect((made as { error: string }).error).toContain('boom in checkout')
    expect(readdirSync(join(p.stateDir, CLONE_ROOT))).toEqual([])
  })

  test('a failing fetch removes the half-built clone', async () => {
    const { cwd } = origin(8)
    const p = ports({
      exec: (argv, o) =>
        argv.includes('fetch')
          ? Promise.resolve({ stdout: '', stderr: 'fatal: unable to access', code: 128, timedOut: false })
          : defaultExec(argv, o),
    })
    const made = await cloneForRef(p, cwd, 'f:prepare', { pr: 8 })
    expect((made as { error: string }).error).toContain('could not fetch')
    expect(readdirSync(join(p.stateDir, CLONE_ROOT))).toEqual([])
  })
})

describe('clone housekeeping', () => {
  test('sweepStaleClones removes clones older than a day, never a fresh one or the run’s own', () => {
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
  })

  test('removeClone refuses a path outside the clone root', () => {
    const p = ports()
    const outside = fresh('precious')
    expect(() => removeClone(p, outside)).toThrow('refusing to remove')
    expect(() => removeClone(p, join(p.stateDir, CLONE_ROOT))).toThrow('refusing to remove')
    expect(existsSync(outside)).toBe(true)
  })
})

describe('symlinks in a clone', () => {
  test('every symlink whose target leaves the clone is deleted; links inside stay', () => {
    const root = fresh('clone')
    const outside = fresh('outside')
    put(root, { 'a.ts': 'a\n', 'sub/b.ts': 'b\n', '.git/config': 'keep\n' })
    symlinkSync('/etc', join(root, 'abs-out')) // absolute, outside
    symlinkSync(outside, join(root, 'sub', 'abs-out2'))
    symlinkSync('../../../..', join(root, 'sub', 'up')) // relative, climbs out
    symlinkSync('missing-target-outside/../../../x', join(root, 'dangling-out')) // dangling, lexically outside
    symlinkSync('a.ts', join(root, 'inside')) // stays
    symlinkSync('sub', join(root, 'dir-inside')) // stays
    symlinkSync('/nowhere/at/all', join(root, 'dangling-abs')) // dangling, absolute, outside
    const removed = removeEscapingSymlinks(root)
    expect(removed.sort()).toEqual(['dangling-abs', 'dangling-out', 'sub/abs-out2', 'sub/up', 'abs-out'].sort())
    expect(readlinkSync(join(root, 'inside'))).toBe('a.ts')
    expect(readlinkSync(join(root, 'dir-inside'))).toBe('sub')
    expect(existsSync(join(root, 'abs-out'))).toBe(false)
    expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe('keep\n')
  })

  test('a link to a directory is not followed while walking, and a chain that ends outside is removed', () => {
    const root = fresh('clone')
    const outside = fresh('outside')
    put(outside, { 'secret.txt': 's' })
    symlinkSync(outside, join(root, 'hop'))
    symlinkSync('hop', join(root, 'chain'))
    // `chain` is removed too when it is met first; when `hop` goes first it is left dangling inside the clone. Either way
    // nothing reaches the outside any more.
    expect(removeEscapingSymlinks(root)).toContain('hop')
    expect(existsSync(join(root, 'chain', 'secret.txt'))).toBe(false)
    expect(existsSync(join(root, 'hop', 'secret.txt'))).toBe(false)
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('s') // the target is never touched
  })

  test('a PR that carries escaping symlinks is checked out without them', async () => {
    const { cwd } = origin(5, (seed) => {
      symlinkSync('/etc', join(seed, 'etc-link'))
      symlinkSync('../../..', join(seed, 'up-link'))
      symlinkSync('a.ts', join(seed, 'ok-link'))
    })
    const made = await cloned(cwd, { pr: 5 })
    expect(existsSync(join(made.dir, 'etc-link'))).toBe(false)
    expect(existsSync(join(made.dir, 'up-link'))).toBe(false)
    expect(readlinkSync(join(made.dir, 'ok-link'))).toBe('a.ts')
  })
})

describe('scope vocabulary', () => {
  test('scopeProblem accepts the keywords, refs and ranges, and refuses flags and unsafe characters', () => {
    for (const ok of ['uncommitted', 'head', 'main', 'HEAD~2', 'a..b', 'main..', '..HEAD', 'v2.0...HEAD', 'src/a.ts']) {
      expect(scopeProblem(ok)).toBeNull()
    }
    expect(scopeProblem('-p')).toContain("must not start with '-'")
    expect(scopeProblem('a..--output=x')).toContain("must not start with '-'")
    expect(scopeProblem('a b')).toContain('unsafe characters')
    expect(scopeProblem('a;b')).toContain('unsafe characters')
  })

  test('branchProblem refuses empty, long, flag-like and dotted-parent branches', () => {
    expect(branchProblem('feat/x-1')).toBeNull()
    expect(branchProblem('')).toContain('empty')
    expect(branchProblem('a'.repeat(201))).toContain('200')
    expect(branchProblem('-x')).toContain('unsafe characters')
    expect(branchProblem('a..b')).toContain("'..'")
  })

  test('splitRange splits both range forms and returns null for anything else', () => {
    expect(splitRange('a..b')).toEqual({ from: 'a', to: 'b' })
    expect(splitRange('a...b')).toEqual({ from: 'a', to: 'b' })
    expect(splitRange('..HEAD')).toEqual({ from: '', to: 'HEAD' })
    expect(splitRange('main')).toBeNull()
  })
})
