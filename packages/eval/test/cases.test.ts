import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckCase, casesPath, ReviewCase, readCases, writeCases } from '../src/index.ts'

const SHA = 'a'.repeat(40)

const review = {
  id: 'job-1',
  source: 'jobs-db',
  createdAt: '2026-10-27T12:00:00.000Z',
  repo: 'SourceRoot/dotfiles',
  input: { scope: 'uncommitted' },
  baseSha: SHA,
  baseInferred: true,
  diff: 'diff --git a/x b/x\n',
  legacy: {
    outcome: 'actionable',
    depth: 'standard',
    findings: [{ severity: 'blocking', file: 'x', line: 3, message: 'boom', angle: 'senior-dev' }],
    testGaps: [],
    failedAngles: [],
    costUsd: 0.04,
    costExact: false,
    wallMs: 90_000,
  },
}

describe('eval cases', () => {
  test('round-trip through a jsonl file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agw-eval-')), 'review', 'cases.jsonl')
    writeCases(path, ReviewCase, [review])
    expect(readCases(path, ReviewCase)).toEqual([review] as never)
  })

  test('invalid cases are refused', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agw-eval-')), 'cases.jsonl')
    expect(() => writeCases(path, CheckCase, [{ ...review }])).toThrow()
    const bad = { ...review, repo: '/Users/someone/SourceRoot/dotfiles' }
    expect(() => ReviewCase.parse(bad)).toThrow()
  })

  test('cases live outside the repo', () => {
    expect(casesPath('check', { AGW_EVAL_DIR: '/tmp/e' })).toBe('/tmp/e/check/cases.jsonl')
  })
})
