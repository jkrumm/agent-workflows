import { describe, expect, test } from 'bun:test'
import { issueFor, sanitizeIssueText, targetProblem } from '../src/workflows/retrospective/filter.ts'

const AGENTS = ['review-qa', 'review-security']
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
  issueFor({ workflow: 'review', retroRunId: 'retro-run-1', proposal: p, agents: AGENTS })

describe('sanitizeIssueText', () => {
  test('absolute paths are stripped, whatever the platform', () => {
    for (const path of [
      '/Users/jane/work/app/src/a.ts',
      '/home/ci/build/x',
      '/tmp/x/y',
      '~/notes/todo.md',
      'C:\\Users\\jane\\app',
    ]) {
      const out = sanitizeIssueText(`it failed in ${path} twice`)
      expect(out).toEqual({ ok: true, text: 'it failed in <path> twice' })
    }
  })

  test('paths inside this repo and ordinary prose pairs survive', () => {
    const text =
      'Edit agents/review-qa/AGENTS.md and packages/host/src/boot.ts; input/output and and/or read fine, so does 3/4.'
    expect(sanitizeIssueText(text)).toEqual({ ok: true, text })
  })

  test('anything that could name another repository, host or person is refused, not repaired', () => {
    const cases: [string, string][] = [
      ['acme-corp/payments-api has no Makefile', 'outside this repo'],
      ['see Org/Repo for the fixture', 'outside this repo'],
      ['clone https://git.example.com/x/y', 'URL'],
      ['remote git@github.com:acme/app.git', 'git remote'],
      ['the host 10.0.0.12 refused', 'IP'],
      ['mail jane@acme.dev', 'email'],
      ['call build-box.internal first', 'hostname'],
      ['see ../secrets/x', 'outside this repo'],
    ]
    for (const [text, why] of cases) {
      const out = sanitizeIssueText(text)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.reason).toContain(why)
    }
  })
})

describe('targetProblem', () => {
  test('an agent of the workflow, an agw command or a path in this repo', () => {
    for (const target of [
      'review-qa',
      'agw review',
      'agw learnings list',
      'agents/review-qa/AGENTS.md',
      'packages/host/src/x.ts',
      'docs/concept.md',
    ]) {
      expect(targetProblem(target, AGENTS)).toBeNull()
    }
  })

  test('everything else is refused', () => {
    for (const target of [
      '/etc/passwd',
      '../x',
      'agents/../../x',
      'other-repo/src/a.ts',
      'unknown-agent',
      'agw; rm -rf',
      'agents//x',
      'C:\\x',
      '~/x',
    ]) {
      expect(targetProblem(target, AGENTS)).not.toBeNull()
    }
  })
})

describe('issueFor', () => {
  test('the issue carries the proposal text, kind, target, confidence and run ids, nothing else', () => {
    const out = draft()
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.title).toBe('retro(review): Tell the QA angle to read the test file first')
    expect(out.body).toContain('- **Kind:** agents-md')
    expect(out.body).toContain('- **Target:** `agents/review-qa/AGENTS.md`')
    expect(out.body).toContain('The angle misses fixtures in three runs')
    expect(out.body).toContain('`run-aaaa1111`, `run-bbbb2222`')
    expect(out.body).toContain('run `retro-run-1`')
  })

  test('a quoted absolute path is stripped from the body', () => {
    const out = draft(
      proposal({ change: 'The agent re-ran make in /Users/jane/work/app several times; offer a capability.' }),
    )
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.body).toContain('re-ran make in <path> several times')
      expect(out.body).not.toContain('Users')
      expect(out.body).not.toContain('jane')
    }
  })

  test('a repo name, URL or foreign target refuses the issue with the reason', () => {
    const repo = draft(proposal({ change: 'In acme-corp/payments-api the check target is missing.' }))
    expect(repo).toMatchObject({ ok: false })
    expect(!repo.ok && repo.reason).toContain('change')
    const title = draft(proposal({ title: 'Fix checks in acme-corp/payments-api runs' }))
    expect(!title.ok && title.reason).toContain('title')
    const target = draft(proposal({ target: '/Users/jane/app/AGENTS.md' }))
    expect(!target.ok && target.reason).toContain('target')
  })
})
