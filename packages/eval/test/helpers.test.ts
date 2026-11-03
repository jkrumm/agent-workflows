import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from '../src/exec.ts'
import { cleanup, materialize, setupSteps } from '../src/materialize.ts'
import { bootstrapMedianCI, median } from '../src/stats.ts'
import { BAD_DIFF, fixtureHome } from './support.ts'

describe('materialize', () => {
  test('clones at baseSha and applies the diff as uncommitted changes, without touching the source', async () => {
    const fx = fixtureHome()
    const tree = await materialize(
      { repo: 'SourceRoot/fixture', baseSha: fx.baseSha, patch: fx.diff },
      { exec, home: fx.home, setup: false },
    )
    if (!tree.ok) throw new Error(tree.detail)
    expect(readFileSync(join(tree.dir, 'app.ts'), 'utf8')).toContain('b = 3')
    const status = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: tree.dir }).stdout.toString()
    expect(status).toContain('M app.ts')
    expect(readFileSync(join(fx.repo, 'app.ts'), 'utf8')).toContain('b = 2')
    cleanup(tree.dir)
    expect(existsSync(tree.dir)).toBe(false)
  })

  test('a diff that does not apply is apply_failed; a missing repo or sha is named', async () => {
    const fx = fixtureHome()
    const options = { exec, home: fx.home, setup: false }
    const bad = await materialize({ repo: 'SourceRoot/fixture', baseSha: fx.baseSha, patch: BAD_DIFF }, options)
    expect(bad).toMatchObject({ ok: false, reason: 'apply_failed' })
    const missing = await materialize({ repo: 'SourceRoot/nope', baseSha: fx.baseSha }, options)
    expect(missing).toMatchObject({ ok: false, reason: 'repo_missing' })
    const sha = await materialize({ repo: 'SourceRoot/fixture', baseSha: 'f'.repeat(40) }, options)
    expect(sha).toMatchObject({ ok: false, reason: 'checkout_failed' })
  })

  test('files the patch creates are intent-to-add, so git diff HEAD shows them', async () => {
    const fx = fixtureHome()
    const added =
      'diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+export const c = 4\n'
    const tree = await materialize(
      { repo: 'SourceRoot/fixture', baseSha: fx.baseSha, patch: `${fx.diff}${added}` },
      { exec, home: fx.home, setup: false },
    )
    if (!tree.ok) throw new Error(tree.detail)
    const diff = Bun.spawnSync(['git', 'diff', 'HEAD', '--name-only'], { cwd: tree.dir }).stdout.toString()
    expect(diff.trim().split('\n').sort()).toEqual(['app.ts', 'new.ts'])
    cleanup(tree.dir)
  })

  test('setup runs bun install only when the Makefile check does not install itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agw-eval-setup-'))
    expect(setupSteps(dir)).toEqual([])
    writeFileSync(join(dir, 'bun.lock'), '{}')
    expect(setupSteps(dir)).toEqual([{ cmd: 'bun', args: ['install', '--frozen-lockfile'] }])
    writeFileSync(join(dir, 'Makefile'), 'check:\n\t@bun install --frozen-lockfile\n\t@bun test\n')
    expect(setupSteps(dir)).toEqual([])
  })
})

describe('stats', () => {
  test('median', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(median([])).toBeNull()
  })

  test('bootstrap CI is deterministic under a seed and brackets the median', () => {
    const values = [0.8, 0.9, 1.0, 1.05, 1.1, 1.2, 0.95, 1.3, 0.7, 1.0]
    const a = bootstrapMedianCI(values, { seed: 7 })
    expect(a).toEqual(bootstrapMedianCI(values, { seed: 7 }))
    const [lo, hi] = a as [number, number]
    expect(lo).toBeLessThanOrEqual(median(values) as number)
    expect(hi).toBeGreaterThanOrEqual(median(values) as number)
    expect(bootstrapMedianCI([1], { seed: 7 })).toBeNull()
  })
})
