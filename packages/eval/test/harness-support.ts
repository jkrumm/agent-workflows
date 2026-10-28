import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CheckCase, ReviewCase } from '../src/cases.ts'
import type { CheckRunner, ReviewOutput, ReviewRequest, ReviewRunner } from '../src/harness/ports.ts'

function git(cwd: string, ...args: string[]): string {
  const ran = Bun.spawnSync(['git', '-c', 'user.email=eval@example.com', '-c', 'user.name=eval', ...args], { cwd })
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`)
  return ran.stdout.toString().trim()
}

/** A home root with `SourceRoot/fixture`: one commit, and a diff on it that applies cleanly. */
export function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'agw-eval-home-'))
  const repo = join(home, 'SourceRoot', 'fixture')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '--quiet', '--initial-branch=main')
  writeFileSync(join(repo, 'app.ts'), 'export const a = 1\nexport const b = 2\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '--quiet', '-m', 'init')
  const baseSha = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'app.ts'), 'export const a = 1\nexport const b = 3\n')
  const diff = `${git(repo, 'diff')}\n`
  git(repo, 'checkout', '--quiet', '--', '.')
  return { home, repo, baseSha, diff }
}

export const BAD_DIFF =
  'diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1,2 +1,2 @@\n-nothing like this\n+here\n'

export function reviewCase(overrides: Partial<ReviewCase> & Pick<ReviewCase, 'baseSha' | 'diff'>): ReviewCase {
  return {
    id: 'case-1',
    source: 'jobs-db',
    createdAt: '2026-10-27T12:00:00.000Z',
    repo: 'SourceRoot/fixture',
    input: { scope: 'uncommitted' },
    baseInferred: false,
    legacy: {
      outcome: 'actionable',
      depth: 'standard',
      findings: [
        {
          severity: 'blocking',
          file: 'app.ts',
          line: 2,
          message: 'b changed from 2 to 3 breaks the exported constant contract',
          angle: 'senior-dev',
        },
        { severity: 'improvement', file: 'app.ts', line: 1, message: 'name a better', angle: 'senior-dev' },
      ],
      testGaps: [],
      failedAngles: [],
      costUsd: 0.04,
      costExact: true,
      wallMs: 100_000,
    },
    ...overrides,
  }
}

export function checkCase(overrides: Partial<CheckCase> & Pick<CheckCase, 'baseSha'>): CheckCase {
  return {
    id: 'check-1',
    source: 'synthetic',
    createdAt: '2026-10-27T12:00:00.000Z',
    repo: 'SourceRoot/fixture',
    input: {},
    baseInferred: false,
    legacy: {
      passed: true,
      steps: [{ name: 'check', passed: true }],
      costUsd: 0.01,
      costExact: true,
      wallMs: 60_000,
    },
    ...overrides,
  }
}

export function reviewOutput(overrides: Partial<ReviewOutput> = {}): ReviewOutput {
  return {
    schemaVersion: 2,
    outcome: 'actionable',
    blocking: [
      { file: 'app.ts', line: 3, message: 'Changing b from 2 to 3 breaks the exported contract', angle: 'correctness' },
    ],
    improvements: [],
    discussions: [],
    testGaps: [],
    summary: 'one blocking finding',
    ...overrides,
  }
}

/** A review runner that records what it was asked and answers with `output`. */
export function fakeReview(output: ReviewOutput, spend = { costUsd: 0.04, costExact: true, wallMs: 110_000 }) {
  const calls: ReviewRequest[] = []
  const runner: ReviewRunner = {
    async review(request) {
      calls.push(request)
      return { output, spend, runId: `run-${calls.length}` }
    },
  }
  return { runner, calls }
}

export function fakeCheck(passed: boolean, spend = { costUsd: 0.01, costExact: true, wallMs: 50_000 }) {
  let count = 0
  const runner: CheckRunner = {
    async check() {
      count++
      return { output: { passed, steps: [{ name: 'check', passed }], summary: '' }, spend }
    },
  }
  return { runner, calls: () => count }
}
