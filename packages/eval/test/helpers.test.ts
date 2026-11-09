import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from '../src/exec.ts'
import { cleanup, createdPaths, materialize, setupSteps } from '../src/materialize.ts'
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
    const accented =
      'diff --git a/café.ts b/café.ts\nnew file mode 100644\n--- /dev/null\n+++ b/café.ts\n@@ -0,0 +1 @@\n+export const d = 5\n'
    const tree = await materialize(
      { repo: 'SourceRoot/fixture', baseSha: fx.baseSha, patch: `${fx.diff}${added}${accented}` },
      { exec, home: fx.home, setup: false },
    )
    if (!tree.ok) throw new Error(tree.detail)
    const diff = Bun.spawnSync(['git', '-c', 'core.quotePath=false', 'diff', 'HEAD', '--name-only'], {
      cwd: tree.dir,
    }).stdout.toString()
    expect(diff.trim().split('\n').sort()).toEqual(['app.ts', 'café.ts', 'new.ts'])
    // only the created file is intent-to-add: git 2.43 marks a modified one `DA` when the patch is applied with `--intent-to-add`
    const status = Bun.spawnSync(['git', '-c', 'core.quotePath=false', 'status', '--porcelain'], {
      cwd: tree.dir,
    }).stdout.toString()
    expect(status.split('\n').filter(Boolean).sort()).toEqual([' A café.ts', ' A new.ts', ' M app.ts'])
    cleanup(tree.dir)
  })

  test('createdPaths reads the `create mode` lines of git apply --summary', () => {
    const summary =
      ' create mode 100644 new.ts\n delete mode 100644 old.ts\n create mode 100755 bin/run sh\n create mode 100644 "q\\"uote.ts"\n rename a.ts => b.ts (100%)\n'
    expect(createdPaths(summary)).toEqual(['new.ts', 'bin/run sh', 'q"uote.ts'])
    expect(createdPaths('')).toEqual([])
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
