import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from '../src/harness/exec.ts'
import { cleanup, materialize } from '../src/harness/materialize.ts'
import { fixtureHome } from './harness-support.ts'

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-c', 'user.email=eval@example.com', '-c', 'user.name=eval', ...args], { cwd })
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`)
  return ran.stdout.toString().trim()
}

describe('materialize isolate', () => {
  test('no ref reaches a commit after the reviewed one', async () => {
    const fx = fixtureHome()
    const tmpRoot = mkdtempSync(join(tmpdir(), 'agw-eval-tmp-'))
    git(fx.repo, 'tag', 'v1')
    git(fx.repo, 'checkout', '--quiet', '-b', 'fix')
    writeFileSync(join(fx.repo, 'app.ts'), 'export const a = 1\nexport const b = 4\n')
    git(fx.repo, 'commit', '--quiet', '-am', 'fix: later')
    const later = git(fx.repo, 'rev-parse', 'HEAD')
    git(fx.repo, 'tag', 'v2')
    git(fx.repo, 'checkout', '--quiet', 'main')
    writeFileSync(join(fx.repo, 'app.ts'), 'export const a = 9\n')
    git(fx.repo, 'stash', 'push', '--quiet')
    const options = { exec, home: fx.home, tmpRoot, setup: false }

    const open = await materialize({ repo: 'SourceRoot/fixture', baseSha: fx.baseSha }, options)
    if (!open.ok) throw new Error(open.detail)
    expect(git(open.dir, 'rev-list', '--all').split('\n')).toContain(later)

    const tree = await materialize({ repo: 'SourceRoot/fixture', baseSha: fx.baseSha, isolate: true }, options)
    if (!tree.ok) throw new Error(tree.detail)
    expect(git(tree.dir, 'log', '--all', '--format=%H')).toBe(fx.baseSha)
    expect(git(tree.dir, 'rev-list', '--all')).not.toContain(later)
    expect(git(tree.dir, 'rev-parse', 'HEAD')).toBe(fx.baseSha)
    expect(git(tree.dir, 'for-each-ref')).toBe('')
    expect(git(tree.dir, 'reflog', '--all')).toBe('')
    expect(git(tree.dir, 'show', `${fx.baseSha}:app.ts`)).toContain('b = 2')

    cleanup(open.dir)
    cleanup(tree.dir)
    rmSync(tmpRoot, { recursive: true, force: true })
    rmSync(fx.home, { recursive: true, force: true })
  })
})
