import { expect, test } from 'bun:test'
import { select } from '../src/fast-tier.ts'

const base = 'a'.repeat(40)
const pick = (changed: string[], untracked: string[] = []) => select({ base, changed, untracked })

test('TypeScript under a package runs the tests its import graph reaches', () => {
  expect(pick(['packages/limits/src/spend.ts'])).toEqual({ mode: 'changed', base })
  expect(pick(['packages/host/test/friction.test.ts', 'docs/concept.md'])).toEqual({ mode: 'changed', base })
})

test('docs and top-level markdown alone run no test', () => {
  expect(pick(['docs/waves/PLAN.md', 'README.md', 'AGENTS.md'])).toEqual({ mode: 'none' })
  expect(pick([])).toEqual({ mode: 'none' })
})

test('what the import graph cannot see runs the whole suite', () => {
  for (const path of [
    'scripts/deploy.sh',
    'deploy/com.jkrumm.agent-workflows-host.plist.template',
    'agents/check/AGENTS.md',
    'packages/capabilities/playbook/core.md',
    'packages/host/package.json',
    'packages/testing/src/pg.ts',
    'bun.lock',
    'Makefile',
    'bunfig.toml',
    '.heavy-tests',
    'project.yaml',
  ]) {
    expect(pick(['packages/limits/src/spend.ts', path])).toMatchObject({ mode: 'full' })
  }
})

test('a path git does not track yet, or no merge base, runs the whole suite', () => {
  expect(pick(['packages/limits/src/spend.ts'], ['packages/limits/test/new.test.ts'])).toMatchObject({ mode: 'full' })
  expect(select({ base: null, changed: [], untracked: [] })).toMatchObject({ mode: 'full' })
})
