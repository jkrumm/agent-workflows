import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artifactDir, artifactRoot, RETENTION_MS, sweep } from '../src/artifacts.ts'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agw-artifacts-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const aged = (path: string, daysAgo: number, now: number) => {
  const t = (now - daysAgo * 24 * 60 * 60 * 1000) / 1000
  utimesSync(path, t, t)
}

test('the run directory is <root>/<workflow>/<runId>, created private', () => {
  const dir = artifactDir('image.generate', '01a1b2c3-d4e5', { root })
  expect(dir).toBe(join(root, 'image.generate', '01a1b2c3-d4e5'))
  expect(statSync(dir).isDirectory()).toBe(true)
  expect(statSync(dir).mode & 0o077).toBe(0)
  expect(artifactDir('image.generate', '01a1b2c3-d4e5', { root })).toBe(dir)
})

test('names that could leave the store are refused', () => {
  for (const workflow of ['', '..', '../x', 'a/b', 'Image', '.hidden']) {
    expect(() => artifactDir(workflow, 'run1', { root })).toThrow('invalid workflow id')
  }
  for (const run of ['', '..', '../x', 'a/b', '.hidden', 'a b']) {
    expect(() => artifactDir('image.generate', run, { root })).toThrow('invalid run id')
  }
  expect(existsSync(join(root, '..', 'x'))).toBe(false)
})

test('the root is AGW_ARTIFACTS_DIR, else artifacts/ under the state dir', () => {
  expect(artifactRoot({ AGW_ARTIFACTS_DIR: ' /data/art ' })).toBe('/data/art')
  expect(artifactRoot({})).toEndWith('/agent-workflows/artifacts')
})

test('sweep removes run directories older than the cutoff and keeps the rest, newest activity wins', () => {
  const now = Date.now()
  const old = artifactDir('image.generate', 'old-run', { root, now })
  const fresh = artifactDir('image.generate', 'fresh-run', { root, now })
  const lone = artifactDir('podcast', 'lone-run', { root, now })
  writeFileSync(join(old, '1.png'), 'x')
  writeFileSync(join(fresh, '1.png'), 'x')
  writeFileSync(join(lone, 'cover.png'), 'x')
  aged(old, 31, now)
  aged(fresh, 29, now)
  aged(lone, 40, now)

  const { removed } = sweep(RETENTION_MS, { root, now })

  expect(removed.sort()).toEqual([lone, old].sort())
  expect(existsSync(old)).toBe(false)
  expect(existsSync(fresh)).toBe(true)
  // a workflow directory left empty goes with its last run
  expect(existsSync(join(root, 'podcast'))).toBe(false)
  expect(existsSync(join(root, 'image.generate'))).toBe(true)
})

test('sweeping a root that does not exist is a no-op', () => {
  expect(sweep(RETENTION_MS, { root: join(root, 'nothing-here') })).toEqual({ removed: [] })
})

test('writing sweeps: the first artifactDir of a root removes what is past retention, the next within the hour does not', () => {
  const now = Date.now()
  const stale = artifactDir('image.generate', 'stale', { root: join(root, 'a'), now: now - 2 * 60 * 60 * 1000 })
  aged(stale, 45, now)
  artifactDir('image.generate', 'trigger', { root: join(root, 'a'), now })
  expect(existsSync(stale)).toBe(false)

  // inside the hour the sweep is skipped, so a newly aged directory survives until the next window
  const later = artifactDir('image.generate', 'later', { root: join(root, 'a'), now })
  aged(later, 45, now)
  artifactDir('image.generate', 'again', { root: join(root, 'a'), now: now + 60_000 })
  expect(existsSync(later)).toBe(true)
  artifactDir('image.generate', 'next-window', { root: join(root, 'a'), now: now + 61 * 60_000 })
  expect(existsSync(later)).toBe(false)
})
