import { describe, expect, test } from 'bun:test'
import { createCapabilities, createRegistry } from '@agent-workflows/capabilities'
import { rejection } from './support.ts'
import { fakeTransports } from '@agent-workflows/capabilities/testing'
import { loadConfig } from '../src/config.ts'
import { ghCli } from '../src/workflows/retrospective/gh.ts'
import { createWorkflows, fingerprintWorkflows } from '../src/workflows/index.ts'

const base = { AGW_API_SECRET: 'x'.repeat(40), AGW_MACHINE: 'm', AGW_PG_URL: 'postgres://u@h/d' }

describe('retrospective config', () => {
  test('the weekly schedule is on and issue filing off unless told otherwise', () => {
    expect(loadConfig(base)).toMatchObject({ retroWeekly: true, retroFileIssues: false, retroIssueRepo: undefined })
    for (const off of ['0', 'off', 'false'])
      expect(loadConfig({ ...base, AGW_RETRO_WEEKLY: off }).retroWeekly).toBe(false)
  })

  test('filing issues needs a well-formed repository', () => {
    expect(() => loadConfig({ ...base, AGW_RETRO_FILE_ISSUES: '1' })).toThrow(
      'AGW_RETRO_FILE_ISSUES needs AGW_RETRO_ISSUE_REPO',
    )
    expect(() => loadConfig({ ...base, AGW_RETRO_ISSUE_REPO: 'not a repo' })).toThrow('owner/name')
    expect(loadConfig({ ...base, AGW_RETRO_FILE_ISSUES: 'true', AGW_RETRO_ISSUE_REPO: 'owner/name' })).toMatchObject({
      retroFileIssues: true,
      retroIssueRepo: 'owner/name',
    })
  })
})

describe('registration', () => {
  const registry = createRegistry(createCapabilities({ transports: fakeTransports({}), env: {} }))
  const stub = {
    journal: { sample: async () => [], countFinished: async () => 0 },
    learnings: {} as never,
  }

  test('without the retro deps the host serves what it did before', () => {
    const ids = createWorkflows({ registry }).map((w) => w.workflow.id)
    expect(ids).not.toContain('retrospective')
    expect(ids.some((id) => id.startsWith('learnings.'))).toBe(false)
  })

  test('with them: the learnings commands and the retrospective, which runs the retrospective agent on its own route', () => {
    const entries = createWorkflows({ registry, retro: stub })
    const ids = entries.map((w) => w.workflow.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'retrospective',
        'learnings.list',
        'learnings.add',
        'learnings.activate',
        'learnings.retire',
      ]),
    )
    expect(fingerprintWorkflows(entries).retrospective).toEqual([{ agent: 'retrospective', route: 'retro.analyze' }])
  })
})

describe('ghCli', () => {
  const calls: string[][] = []
  const run = (answer: string) => async (argv: string[]) => {
    calls.push(argv)
    return { exitCode: 0, stdout: answer, stderr: '' }
  }

  test('finds an exact title among a fuzzy search, open or closed', async () => {
    const gh = ghCli({
      repo: 'owner/name',
      run: run(
        JSON.stringify([
          { number: 4, title: 'retro(review): Other thing', url: 'u4' },
          { number: 7, title: 'Retro(review): The thing', url: 'u7' },
        ]),
      ),
    })
    expect(await gh.findByTitle('retro(review): the thing')).toEqual({ number: 7, url: 'u7' })
    expect(await gh.findByTitle('retro(review): missing')).toBeNull()
    expect(calls[0]).toEqual(expect.arrayContaining(['--repo', 'owner/name', '--state', 'all']))
  })

  test('creates in the configured repository with the title and body as arguments, never through a shell', async () => {
    calls.length = 0
    const gh = ghCli({ repo: 'owner/name', run: run('https://example.com/owner/name/issues/12\n') })
    expect(await gh.create({ title: 't; rm -rf', body: 'b' })).toEqual({
      number: 12,
      url: 'https://example.com/owner/name/issues/12',
    })
    expect(calls[0]).toEqual(['issue', 'create', '--repo', 'owner/name', '--title', 't; rm -rf', '--body', 'b'])
  })

  test('a failing gh surfaces its stderr; a malformed repository is refused at construction', async () => {
    const gh = ghCli({ repo: 'owner/name', run: async () => ({ exitCode: 1, stdout: '', stderr: 'auth required' }) })
    expect(await rejection(gh.create({ title: 't', body: 'b' }))).toContain('auth required')
    expect(() => ghCli({ repo: 'nope' })).toThrow('owner/name')
  })
})
