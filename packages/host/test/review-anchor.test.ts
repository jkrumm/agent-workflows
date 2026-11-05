import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { anchorFindings, anchorKey, changedLines, countLines, nearChange } from '../src/review/anchor.ts'

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@ export function f() {
 context
-old
+new one
+new two
 context
@@ -40,2 +41,1 @@
-gone
 keep
diff --git a/src/n.ts b/src/n.ts
new file mode 100644
--- /dev/null
+++ b/src/n.ts
@@ -0,0 +1,2 @@
+first
+second
diff --git a/src/del.ts b/src/del.ts
deleted file mode 100644
--- a/src/del.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
diff --git a/src/old.ts b/src/renamed.ts
similarity index 90%
rename from src/old.ts
rename to src/renamed.ts
--- a/src/old.ts
+++ b/src/renamed.ts
@@ -5 +5 @@
-x
+y
\\ No newline at end of file
diff --git a/src/top.ts b/src/top.ts
--- a/src/top.ts
+++ b/src/top.ts
@@ -3,1 +2,0 @@
-removed after line two
`

describe('changedLines', () => {
  const changed = changedLines(DIFF)

  test('added lines at their new-side number; a deletion at the line that follows it', () => {
    expect(changed.get('src/a.ts')).toEqual([11, 11, 12, 41])
  })
  test('a new file counts every line', () => {
    expect(changed.get('src/n.ts')).toEqual([1, 2])
  })
  test('a deleted file has no new side', () => {
    expect(changed.has('src/del.ts')).toBe(false)
  })
  test('a rename is keyed by its new path', () => {
    expect(changed.get('src/renamed.ts')).toEqual([5, 5])
    expect(changed.has('src/old.ts')).toBe(false)
  })
  test('a deletion-only hunk counts at the position after the line before it', () => {
    expect(changed.get('src/top.ts')).toEqual([3])
  })
  test('a "+++" content line inside a hunk is not a header', () => {
    const tricky = '--- a/x\n+++ b/x\n@@ -1,1 +1,2 @@\n a\n+++ b/fake\n'
    expect([...changedLines(tricky).keys()]).toEqual(['x'])
  })
})

describe('nearChange and countLines', () => {
  test('3 lines away is anchored, 4 is not', () => {
    expect(nearChange([10], 13)).toBe(true)
    expect(nearChange([10], 7)).toBe(true)
    expect(nearChange([10], 14)).toBe(false)
    expect(nearChange([10], 6)).toBe(false)
  })
  test('lines of a text', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a\nb\n')).toBe(2)
    expect(countLines('a\nb')).toBe(2)
  })
})

describe('anchorFindings', () => {
  const dirs: string[] = []
  const fixture = (files: Record<string, string>, diff: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), 'agw-anchor-'))
    dirs.push(dir)
    const worktree = join(dir, 'tree')
    mkdirSync(worktree)
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(worktree, path)), { recursive: true })
      writeFileSync(join(worktree, path), content)
    }
    if (diff !== null) writeFileSync(join(dir, 'diff.patch'), diff)
    return { worktree, jobDir: dir }
  }
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })
  const at = async (where: { worktree: string; jobDir: string }, finding: { file: string; line: number | null }) =>
    (await anchorFindings({ ...where, findings: [finding] })).get(anchorKey(finding))

  const lines = (n: number) => `${Array.from({ length: n }, (_, i) => `l${i}`).join('\n')}\n`

  test('valid and anchored; the ±3 boundary; beyond EOF; untouched file; missing file', async () => {
    const where = fixture({ 'src/a.ts': lines(50), 'src/b.ts': lines(5) }, DIFF)
    expect(await at(where, { file: 'src/a.ts', line: 15 })).toEqual({ lineValid: true, anchored: true })
    expect(await at(where, { file: 'src/a.ts', line: 16 })).toEqual({ lineValid: true, anchored: false })
    expect(await at(where, { file: 'src/a.ts', line: 50 })).toEqual({ lineValid: true, anchored: false })
    expect(await at(where, { file: 'src/a.ts', line: 51 })).toEqual({ lineValid: false, anchored: false })
    expect(await at(where, { file: 'src/b.ts', line: 2 })).toEqual({ lineValid: true, anchored: false })
    expect(await at(where, { file: 'src/gone.ts', line: 1 })).toEqual({ lineValid: false, anchored: false })
  })

  test('a finding without a line is null on both', async () => {
    const where = fixture({ 'src/a.ts': lines(5) }, DIFF)
    expect(await at(where, { file: 'src/a.ts', line: null })).toEqual({ lineValid: null, anchored: null })
  })

  test('a path that leaves the worktree is rejected', async () => {
    const where = fixture({ 'src/a.ts': lines(5) }, DIFF)
    writeFileSync(join(where.jobDir, 'outside.ts'), lines(5))
    expect(await at(where, { file: '../outside.ts', line: 1 })).toMatchObject({ lineValid: false })
    expect(await at(where, { file: '/etc/hosts', line: 1 })).toMatchObject({ lineValid: false })
  })

  test('an unreadable diff or worktree is unknown, never a throw', async () => {
    const noDiff = fixture({ 'src/a.ts': lines(5) }, null)
    expect(await at(noDiff, { file: 'src/a.ts', line: 2 })).toEqual({ lineValid: true, anchored: null })
    const where = fixture({}, DIFF)
    rmSync(where.worktree, { recursive: true })
    expect(await at(where, { file: 'src/a.ts', line: 12 })).toEqual({ lineValid: null, anchored: true })
  })
})
