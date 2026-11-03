import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckCase, casesPath, readCases, writeCases } from '../src/index.ts'

const check = {
  id: 'check-1',
  source: 'synthetic',
  createdAt: '2026-10-27T12:00:00.000Z',
  repo: 'SourceRoot/dotfiles',
  input: {},
  baseSha: 'a'.repeat(40),
  baseInferred: false,
  legacy: { passed: true, steps: [{ name: 'check', passed: true }], costUsd: 0.01, costExact: true, wallMs: 60_000 },
}

describe('eval cases', () => {
  test('round-trip through a jsonl file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agw-eval-')), 'check', 'cases.jsonl')
    writeCases(path, CheckCase, [check])
    expect(readCases(path, CheckCase)).toEqual([check] as never)
  })

  test('invalid cases are refused', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agw-eval-')), 'cases.jsonl')
    expect(() => writeCases(path, CheckCase, [{ ...check, baseSha: 'short' }])).toThrow()
    expect(() => CheckCase.parse({ ...check, repo: '/Users/someone/SourceRoot/dotfiles' })).toThrow()
  })

  test('cases live outside the repo', () => {
    expect(casesPath('check', { AGW_EVAL_DIR: '/tmp/e' })).toBe('/tmp/e/check/cases.jsonl')
  })
})
