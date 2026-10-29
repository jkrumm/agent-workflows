import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CALLER_PATTERN, PROJECT_PATTERN } from '../../host/src/auth.ts'
import { CALLER_NAME, callerHeaders, gitProject, PROJECT_NAME } from '../src/host.ts'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'agw-caller-')))
afterAll(() => rmSync(base, { recursive: true, force: true }))

/** A repo `<place>/<name>` with a `.git` directory. */
function repo(place: string, name: string): string {
  const dir = join(base, place, name)
  mkdirSync(join(dir, '.git'), { recursive: true })
  return dir
}

/** A linked worktree at `<where>` of the repo whose common git directory is `common`, the way git writes it. */
function worktree(common: string, where: string): string {
  const dir = join(base, where)
  const admin = join(common, 'worktrees', 'wt')
  mkdirSync(admin, { recursive: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.git'), `gitdir: ${admin}\n`)
  writeFileSync(join(admin, 'commondir'), '../..\n')
  return dir
}

describe('caller headers', () => {
  test('a Claude Code session in a repo: claude-code, the repo name, its workspace; never a path', () => {
    const dir = repo('SourceRoot', 'some-repo')
    mkdirSync(join(dir, 'packages', 'x'), { recursive: true })
    const headers = callerHeaders({ CLAUDECODE: '1', HOME: base }, join(dir, 'packages', 'x'))
    expect(headers).toEqual({
      'x-agw-caller': 'claude-code',
      'x-agw-project': 'some-repo',
      'x-agw-workspace': 'private',
    })
    expect(Object.values(headers).some((v) => v.includes('/'))).toBe(false)
  })

  test('IuRoot is work; a place that is neither leaves the workspace to Argo', () => {
    expect(callerHeaders({ HOME: base }, repo('IuRoot', 'a-work-repo'))['x-agw-workspace']).toBe('work')
    expect(callerHeaders({ HOME: base }, repo('elsewhere', 'plain'))).toEqual({
      'x-agw-caller': 'cli',
      'x-agw-project': 'plain',
    })
  })

  test('a linked worktree is the repo it was cut from, and its workspace is the repo’s, not the worktree’s', () => {
    const main = repo('IuRoot', 'the-repo')
    const wt = worktree(join(main, '.git'), join('SourceRoot', 'scratch', 'w9-usage-caller'))
    expect(gitProject(wt)).toEqual({ name: 'the-repo', root: main })
    expect(callerHeaders({ CLAUDECODE: '1', HOME: base }, wt)).toMatchObject({
      'x-agw-project': 'the-repo',
      'x-agw-workspace': 'work',
    })
  })

  test('a common git directory not named .git: a bare x.git and a separate git dir name the repo, not the worktree', () => {
    const bare = join(base, 'bare', 'x.git')
    mkdirSync(bare, { recursive: true })
    expect(gitProject(worktree(bare, 'throwaway-1'))?.name).toBe('x')

    const separate = join(base, 'gitdirs', 'proj')
    mkdirSync(separate, { recursive: true })
    const checkout = join(base, 'checkout-folder')
    mkdirSync(checkout, { recursive: true })
    writeFileSync(join(checkout, '.git'), `gitdir: ${separate}\n`)
    expect(gitProject(checkout)?.name).toBe('proj')
    expect(gitProject(worktree(separate, 'throwaway-2'))?.name).toBe('proj')
  })

  test('the walk up stops at $HOME: a ~/.git never makes the home folder a project', () => {
    const home = join(base, 'home', 'someone')
    mkdirSync(join(home, '.git'), { recursive: true })
    const loose = join(home, 'notes', 'deep')
    mkdirSync(loose, { recursive: true })
    expect(gitProject(loose, home)).toBeNull()
    expect(gitProject(home, home)).toBeNull()
    expect(callerHeaders({ HOME: home }, loose)).toEqual({ 'x-agw-caller': 'cli' })
    // A repo inside home is still found.
    const inside = join(home, 'code', 'app')
    mkdirSync(join(inside, '.git'), { recursive: true })
    expect(gitProject(inside, home)?.name).toBe('app')
  })

  test('AGW_CALLER wins over the inference; outside a repo there is no project', () => {
    const outside = join(base, 'not-a-repo')
    mkdirSync(outside)
    expect(callerHeaders({ AGW_CALLER: 'hermes', CLAUDECODE: '1', HOME: base }, outside)).toEqual({
      'x-agw-caller': 'hermes',
    })
  })

  test('a folder name the host would refuse is not sent', () => {
    expect(callerHeaders({ HOME: base }, repo('SourceRoot', 'has space'))).toEqual({ 'x-agw-caller': 'cli' })
  })

  test('a malformed AGW_CALLER is a usage error naming the rule', () => {
    expect(() => callerHeaders({ AGW_CALLER: 'Not Valid', HOME: base }, base)).toThrow(/AGW_CALLER must match/)
  })

  test('the CLI’s copies of the name rules are the host’s', () => {
    expect(CALLER_NAME.source).toBe(CALLER_PATTERN.source)
    expect(PROJECT_NAME.source).toBe(PROJECT_PATTERN.source)
  })
})
