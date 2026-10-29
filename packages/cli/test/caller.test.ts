import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { callerHeaders, gitProject } from '../src/host.ts'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'agw-caller-')))
afterAll(() => rmSync(base, { recursive: true, force: true }))

/** A repo `<place>/<name>` with a `.git` directory. */
function repo(place: string, name: string): string {
  const dir = join(base, place, name)
  mkdirSync(join(dir, '.git'), { recursive: true })
  return dir
}

/** A linked worktree of `main` at `<place>/<folder>`, the way git writes it. */
function worktree(main: string, folder: string): string {
  const dir = join(base, folder)
  const admin = join(main, '.git', 'worktrees', 'wt')
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
    const headers = callerHeaders({ CLAUDECODE: '1' }, join(dir, 'packages', 'x'))
    expect(headers).toEqual({
      'x-agw-caller': 'claude-code',
      'x-agw-project': 'some-repo',
      'x-agw-workspace': 'private',
    })
    expect(Object.values(headers).some((v) => v.includes('/'))).toBe(false)
  })

  test('IuRoot is work; a place that is neither leaves the workspace to Argo', () => {
    expect(callerHeaders({}, repo('IuRoot', 'a-work-repo'))['x-agw-workspace']).toBe('work')
    expect(callerHeaders({}, repo('elsewhere', 'plain'))).toEqual({ 'x-agw-caller': 'cli', 'x-agw-project': 'plain' })
  })

  test('a linked worktree is the repo it was cut from, not its folder', () => {
    const main = repo('SourceRoot', 'the-repo')
    const wt = worktree(main, 'w9-usage-caller')
    expect(gitProject(wt)?.name).toBe('the-repo')
    expect(callerHeaders({ CLAUDECODE: '1' }, wt)['x-agw-project']).toBe('the-repo')
  })

  test('AGW_CALLER wins over the inference; outside a repo there is no project', () => {
    const outside = join(base, 'not-a-repo')
    mkdirSync(outside)
    expect(callerHeaders({ AGW_CALLER: 'hermes', CLAUDECODE: '1' }, outside)).toEqual({ 'x-agw-caller': 'hermes' })
  })

  test('a folder name the host would refuse is not sent', () => {
    expect(callerHeaders({}, repo('SourceRoot', 'has space'))).toEqual({ 'x-agw-caller': 'cli' })
  })

  test('a malformed AGW_CALLER is a usage error naming the rule', () => {
    expect(() => callerHeaders({ AGW_CALLER: 'Not Valid' }, base)).toThrow(/AGW_CALLER must match/)
  })
})
