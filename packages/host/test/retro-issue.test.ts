import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { issueFor, markerFor, proposalHash } from '../src/workflows/retrospective/issue.ts'
import { targetProblem } from '../src/workflows/retrospective/normalize.ts'
import { scrubForPrompt } from '../src/workflows/retrospective/scrub.ts'
import { listTrackedFiles, TrackedPaths } from '../src/workflows/retrospective/tracked.ts'

const AGENTS = ['review-qa', 'review-security']
const tracked = new TrackedPaths([
  'agents/review-qa/AGENTS.md',
  'agents/review-security/AGENTS.md',
  'packages/host/src/boot.ts',
  'docs/concept.md',
])
const proposal = (over: Partial<Parameters<typeof issueFor>[0]['proposal']> = {}) => ({
  kind: 'agents-md' as const,
  target: 'agents/review-qa/AGENTS.md',
  title: 'Tell the QA angle to read the test file first',
  change: 'The angle misses fixtures in three runs; add a line to read the test file before judging coverage.',
  evidence: ['run-aaaa1111', 'run-bbbb2222'],
  confidence: 'medium' as const,
  ...over,
})
const draft = (p = proposal()) =>
  issueFor({ workflow: 'review', retroRunId: 'retro-run-1', proposal: p, agents: AGENTS, tracked })

describe('issueFor', () => {
  test('only structured fields: kind, tracked target, confidence, run ids, a pointer to the private run, a marker', () => {
    const out = draft()
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const hash = proposalHash(proposal(), 'agents/review-qa/AGENTS.md')
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    expect(out.hash).toBe(hash)
    expect(out.title).toBe(`retro(review): agents-md change for agents/review-qa/AGENTS.md [${hash.slice(0, 8)}]`)
    expect(out.body.split('\n')[0]).toBe(`<!-- agw-retro:${hash} -->`)
    expect(out.body).toBe(
      [
        markerFor(hash),
        'Proposed by the weekly retrospective of `review`. Proposals are never applied automatically.',
        '',
        '- **Kind:** agents-md',
        '- **Target:** `agents/review-qa/AGENTS.md`',
        '- **Confidence:** medium',
        '- **Evidence (run ids):** `run-aaaa1111`, `run-bbbb2222`',
        '',
        "Details are private: `agw run status retro-run-1` shows the proposal text in the retrospective run's output.",
      ].join('\n'),
    )
  })

  test('nothing the model wrote reaches the issue, whatever it contains', () => {
    const hostile = [
      'push with ghp_abcdefghijklmnopqrstuvwxyz0123456789 to build-box.example.de and corp.cloud',
      'key sk-proj-abcdefghijklmnopqrstuvwx for acme-billing/ledger at 10.1.2.3, mail ops@acme.io',
      '/Users/jane/work/acme/app/src/a.ts, ~/secrets, C:\\Users\\jane\\app',
    ].join('\n')
    const out = draft(proposal({ change: hostile, title: `Title with ${hostile.slice(0, 60)}` }))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const issue = `${out.title}\n${out.body}`
    for (const leak of [
      'ghp_',
      'sk-proj',
      'build-box',
      'corp.cloud',
      'acme',
      'jane',
      '10.1.2.3',
      '~/secrets',
      'Users',
    ]) {
      expect(issue).not.toContain(leak)
    }
  })

  test('the target must be a tracked path: an invented one under a real root is refused', () => {
    for (const target of [
      'packages/acme-billing/src/a.ts',
      'agents/review-qa/missing.md',
      'other-repo/src/a.ts',
      '/etc/passwd',
      'agw check',
    ]) {
      const out = draft(proposal({ target }))
      expect(out).toMatchObject({ ok: false, reason: 'target is not a tracked path of this repository' })
    }
  })

  test('a tracked file, a tracked directory and an agent name (its definition directory) pass', () => {
    for (const target of [
      'packages/host/src/boot.ts',
      'packages/host',
      'docs/concept.md',
      'review-qa',
      'agents/review-security',
    ]) {
      expect(draft(proposal({ target })).ok).toBe(true)
    }
    const byName = draft(proposal({ target: 'review-qa' }))
    expect(byName.ok && byName.body).toContain('`agents/review-qa`')
  })

  test('the hash is stable under case and whitespace in the change and moves with kind, target or meaning', () => {
    const base = proposalHash(proposal(), 'agents/review-qa/AGENTS.md')
    expect(
      proposalHash(
        proposal({ change: `  ${proposal().change.toUpperCase().replaceAll(' ', '\n  ')} ` }),
        'agents/review-qa/AGENTS.md',
      ),
    ).toBe(base)
    expect(proposalHash(proposal({ kind: 'skill' }), 'agents/review-qa/AGENTS.md')).not.toBe(base)
    expect(proposalHash(proposal(), 'agents/review-security/AGENTS.md')).not.toBe(base)
    expect(proposalHash(proposal({ change: 'something else' }), 'agents/review-qa/AGENTS.md')).not.toBe(base)
  })
})

describe('targetProblem (shape only)', () => {
  test('an agent, an agw command or a relative path pass; anything else is refused', () => {
    for (const target of ['review-qa', 'agw check', 'agents/review-qa/AGENTS.md', 'packages/host/src/x.ts']) {
      expect(targetProblem(target, AGENTS)).toBeNull()
    }
    for (const target of ['/etc/passwd', '../x', 'agents/../../x', 'agents//x', 'C:\\x', '~/x', 'agw; rm -rf', 'a b']) {
      expect(targetProblem(target, AGENTS)).not.toBeNull()
    }
  })
})

describe('scrubForPrompt', () => {
  test('absolute paths of every shape and credential-shaped tokens go', () => {
    const cases: [string, string][] = [
      ['failed in /Users/jane/work/app/src/a.ts twice', 'failed in <path> twice'],
      ['saw /etc and /tmp, then /var/log/x.log', 'saw <path> and <path>, then <path>'],
      ['wrote ~/notes/todo.md and ~jane/x', 'wrote <path> and <path>'],
      ['under C:\\Users\\jane\\app and D:/work/x', 'under <path> and <path>'],
      ['in "/opt/app" or (/srv/data)', 'in "<path>" or (<path>)'],
      ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789 used', 'token <redacted> used'],
      ['header Bearer abcdefghijklmnopqrstuvwxyz012345', 'header Bearer <redacted>'],
    ]
    for (const [input, expected] of cases) expect(scrubForPrompt(input)).toBe(expected)
  })

  test('repo-relative paths, URLs and prose slashes are left alone', () => {
    const text = 'see agents/review-qa/AGENTS.md, https://example.com/a/b, and/or input/output, 3/4'
    expect(scrubForPrompt(text)).toBe(text)
  })
})

describe('tracked files', () => {
  test('a release tree (no .git): every file except node_modules, directories included', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agw-tracked-'))
    mkdirSync(join(root, 'agents/a'), { recursive: true })
    mkdirSync(join(root, 'node_modules/dep'), { recursive: true })
    writeFileSync(join(root, 'agents/a/AGENTS.md'), '#')
    writeFileSync(join(root, 'README.md'), '#')
    writeFileSync(join(root, 'node_modules/dep/index.js'), '')
    const paths = await listTrackedFiles(root)
    expect(paths.has('agents/a/AGENTS.md')).toBe(true)
    expect(paths.has('agents/a')).toBe(true)
    expect(paths.has('agents')).toBe(true)
    expect(paths.has('README.md')).toBe(true)
    expect(paths.has('node_modules/dep/index.js')).toBe(false)
    expect(paths.has('node_modules')).toBe(false)
    expect(paths.has('agents/b')).toBe(false)
    expect(paths.has('agents/a/AGENTS')).toBe(false) // exact, never a prefix of a name
  })

  test('a git checkout asks git: an untracked file does not count', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agw-tracked-git-'))
    const git = (...args: string[]) => Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' })
    git('init', '-q')
    writeFileSync(join(root, 'tracked.md'), '#')
    writeFileSync(join(root, 'untracked.md'), '#')
    git('add', 'tracked.md')
    const paths = await listTrackedFiles(root)
    expect(paths.has('tracked.md')).toBe(true)
    expect(paths.has('untracked.md')).toBe(false)
  })
})
