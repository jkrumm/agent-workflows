import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  atLeast,
  DEFAULT_REVIEW_CONFIG,
  decide,
  type FileChange,
  gitRunner,
  maxTier,
  parseReviewMd,
  type ReviewConfig,
  routeRange,
  SEATS,
  type Tier,
} from '../src/review/route.ts'

const change = (path: string, added = 10, removed = 0): FileChange => ({ path, added, removed })
const config: ReviewConfig = {
  none: ['docs/waves/**', '**/*.snap', 'bun.lock'],
  sensitive: ['packages/runtime/**', 'rules/security.md', '.github/**', '**/*.sql'],
  nits: 3,
}
const route = (changes: FileChange[], extra: { contentChanged?: boolean; min?: Tier } = {}) =>
  decide({ changes, contentChanged: true, config, ...extra })

describe('decide', () => {
  const cases: [string, FileChange[], Tier, string, 'rule' | 'default'][] = [
    ['empty diff', [], 'none', 'no content change (renames or whitespace only)', 'rule'],
    [
      'zero-line (binary) changes only',
      [change('a.png', 0, 0)],
      'none',
      'no content change (renames or whitespace only)',
      'rule',
    ],
    [
      'every file in none',
      [change('docs/waves/w9.md'), change('x/y.snap'), change('bun.lock')],
      'none',
      'every file matches REVIEW.md none',
      'rule',
    ],
    ['root-level **/ glob', [change('a.snap')], 'none', 'every file matches REVIEW.md none', 'rule'],
    ['one file outside none', [change('docs/waves/w9.md'), change('docs/x.md')], 'none', 'docs only', 'rule'],
    [
      'sensitive code',
      [change('packages/runtime/src/a.ts')],
      'deep',
      'sensitive path: packages/runtime/src/a.ts',
      'rule',
    ],
    [
      'sensitive count',
      [change('packages/runtime/a.ts'), change('.github/ci.yml'), change('db/a.sql')],
      'deep',
      'sensitive path: packages/runtime/a.ts (+2)',
      'rule',
    ],
    [
      'sensitive doc glob names docs',
      [change('rules/security.md')],
      'deep',
      'sensitive path: rules/security.md',
      'rule',
    ],
    [
      'package-dir glob does not make a doc sensitive',
      [change('packages/runtime/README.md')],
      'none',
      'docs only',
      'rule',
    ],
    [
      'a test under a sensitive dir is not sensitive',
      [change('packages/runtime/test/a.test.ts')],
      'light',
      'tests only',
      'rule',
    ],
    ['docs only', [change('README.md'), change('a.mdx'), change('b.txt')], 'none', 'docs only', 'rule'],
    [
      'html and json under docs/ are docs',
      [change('docs/spikes/x/index.html', 15000), change('docs/data/a.json', 400)],
      'none',
      'docs only',
      'rule',
    ],
    ['AGENTS.md only', [change('AGENTS.md', 20)], 'light', 'agent instructions', 'rule'],
    ['a skill', [change('skills/x/SKILL.md', 20)], 'light', 'agent instructions', 'rule'],
    ['a rules dir doc', [change('pkg/rules/a.md', 5), change('README.md')], 'light', 'agent instructions', 'rule'],
    ['tests only', [change('packages/host/test/a.ts', 900), change('b.spec.ts')], 'light', 'tests only', 'rule'],
    ['> 800 prod lines', [change('src/a.ts', 801)], 'deep', '801 changed non-test code lines > 800', 'rule'],
    ['800 prod lines is standard', [change('src/a.ts', 800)], 'standard', 'default', 'default'],
    [
      'test lines do not count towards 800',
      [change('src/a.ts', 100), change('test/a.ts', 900)],
      'standard',
      'default',
      'default',
    ],
    [
      '> 3 packages',
      ['a', 'b', 'c', 'd'].map((p) => change(`packages/${p}/x.ts`, 50)),
      'deep',
      '4 packages > 3: a cross-package change',
      'rule',
    ],
    ['3 packages', ['a', 'b', 'c'].map((p) => change(`packages/${p}/x.ts`, 50)), 'standard', 'default', 'default'],
    ['manifest', [change('package.json', 2)], 'standard', 'a manifest changed (dependencies)', 'rule'],
    [
      'nested manifest',
      [change('packages/a/package.json', 1)],
      'standard',
      'a manifest changed (dependencies)',
      'rule',
    ],
    ['small', [change('src/a.ts', 30, 10)], 'light', 'small: 40 code lines in 1 files', 'rule'],
    ['41 lines', [change('src/a.ts', 41)], 'standard', 'default', 'default'],
    ['4 small files', ['a', 'b', 'c', 'd'].map((n) => change(`src/${n}.ts`, 1)), 'standard', 'default', 'default'],
  ]
  test.each(cases)('%s', (_name, changes, tier, rule, decidedBy) => {
    const out = route(changes)
    expect(out).toMatchObject({ tier, rule, decidedBy, seat: SEATS[tier] })
  })

  test('whitespace-only content is none even with line changes', () => {
    expect(route([change('src/a.ts', 5, 5)], { contentChanged: false })).toMatchObject({
      tier: 'none',
      decidedBy: 'rule',
    })
  })

  test('seats', () => {
    expect(SEATS.deep?.vote).toBe(1)
    expect(SEATS.light?.effort).toBe('medium')
  })

  test('facts', () => {
    const out = route([
      change('packages/a/x.ts', 10, 5),
      change('packages/b/test/x.test.ts', 7),
      change('README.md', 3),
      change('z.ts', 0, 0),
    ])
    expect(out).toMatchObject({ files: 3, codeFiles: 2, codeLines: 22, prodLines: 15, packages: ['a', 'b'] })
  })

  test('min raises and says so', () => {
    const out = route([change('README.md')], { min: 'deep' })
    expect(out).toMatchObject({
      tier: 'deep',
      decidedBy: 'caller',
      rule: 'docs only (raised by caller from none)',
      seat: SEATS.deep,
    })
  })

  test('min raises a default too', () => {
    expect(route([change('src/a.ts', 100)], { min: 'deep' })).toMatchObject({
      decidedBy: 'caller',
      rule: 'default (raised by caller from standard)',
    })
  })

  test('min never lowers or relabels', () => {
    expect(route([change('packages/runtime/a.ts')], { min: 'light' })).toMatchObject({
      tier: 'deep',
      decidedBy: 'rule',
    })
    expect(route([change('AGENTS.md')], { min: 'light' })).toMatchObject({ tier: 'light', decidedBy: 'rule' })
  })

  test('tier helpers', () => {
    expect(maxTier('light', 'deep')).toBe('deep')
    expect(maxTier('standard', 'none')).toBe('standard')
    expect(atLeast('standard', 'standard')).toBe(true)
    expect(atLeast('light', 'standard')).toBe(false)
  })
})

describe('decide: a fix round of a deep thread', () => {
  const fix = (changes: FileChange[], extra: { threadDeep?: boolean; min?: Tier } = {}) =>
    decide({ changes, contentChanged: true, config, threadDeep: true, ...extra })

  test('a sensitive path alone routes standard with the fix-round rule', () => {
    expect(fix([change('packages/runtime/src/a.ts')])).toMatchObject({
      tier: 'standard',
      rule: 'sensitive path: packages/runtime/src/a.ts (fix round, thread already deep)',
      decidedBy: 'rule',
    })
    expect(fix([change('packages/runtime/a.ts'), change('.github/ci.yml'), change('db/a.sql')]).rule).toBe(
      'sensitive path: packages/runtime/a.ts (+2) (fix round, thread already deep)',
    )
    // a tiny sensitive change is standard, never light
    expect(fix([change('packages/runtime/a.ts', 1)]).tier).toBe('standard')
  })

  test('deep by size or by packages stays deep with its own rule', () => {
    expect(fix([change('packages/runtime/a.ts'), change('packages/host/b.ts', 900)])).toMatchObject({
      tier: 'deep',
      rule: '910 changed non-test code lines > 800',
    })
    const wide = ['a', 'b', 'c', 'd'].map((p) => change(`packages/${p}/x.ts`))
    expect(fix([change('packages/runtime/a.ts'), ...wide])).toMatchObject({
      tier: 'deep',
      rule: '5 packages > 3: a cross-package change',
    })
  })

  test('a thread that is not deep goes deep on a sensitive path', () => {
    expect(fix([change('packages/runtime/a.ts')], { threadDeep: false })).toMatchObject({
      tier: 'deep',
      rule: 'sensitive path: packages/runtime/a.ts',
    })
  })

  test('--min raises afterwards', () => {
    expect(fix([change('packages/runtime/a.ts')], { min: 'deep' })).toMatchObject({
      tier: 'deep',
      decidedBy: 'caller',
      rule: 'sensitive path: packages/runtime/a.ts (fix round, thread already deep) (raised by caller from standard)',
    })
  })
})

describe('parseReviewMd', () => {
  test('valid', () => {
    const text = '---\nnone: [a/**, "**/*.snap"]\nsensitive: [x]\nnits: 5\n---\n# body'
    expect(parseReviewMd(text)).toEqual({ config: { none: ['a/**', '**/*.snap'], sensitive: ['x'], nits: 5 } })
  })

  test('absent', () => {
    expect(parseReviewMd(null)).toEqual({ config: DEFAULT_REVIEW_CONFIG })
    expect(parseReviewMd('# no frontmatter')).toEqual({ config: DEFAULT_REVIEW_CONFIG })
  })

  test('missing keys default', () => {
    expect(parseReviewMd('---\nnits: 1\n---\n')).toEqual({ config: { none: [], sensitive: [], nits: 1 } })
  })

  test.each([
    ['broken yaml', '---\nnone: [a, \n---\n'],
    ['not a list', '---\nnone: foo\n---\n'],
    ['non-string glob', '---\nsensitive: [1, 2]\n---\n'],
    ['bad nits', '---\nnits: many\n---\n'],
    ['scalar frontmatter', '---\njust text\n---\n'],
  ])('malformed: %s', (_name, text) => {
    const out = parseReviewMd(text)
    expect(out.config).toEqual(DEFAULT_REVIEW_CONFIG)
    expect(out.warning).toContain('REVIEW.md frontmatter ignored')
  })

  test('wrapped lists, comments and quoted globs', () => {
    const text = [
      '---',
      '# comment',
      'none:        [docs/waves/**, "**/*.snap"]',
      'sensitive:   [packages/runtime/**, packages/cli/src/generate*,',
      '              scripts/*secret*, ".env*.tpl",',
      '              "**/*.sql"]',
      'nits: 3',
      '---',
    ].join('\n')
    expect(parseReviewMd(text).config).toEqual({
      none: ['docs/waves/**', '**/*.snap'],
      sensitive: ['packages/runtime/**', 'packages/cli/src/generate*', 'scripts/*secret*', '.env*.tpl', '**/*.sql'],
      nits: 3,
    })
  })
})

describe('globs (fnmatch semantics)', () => {
  const out = (glob: string, path: string) =>
    decide({ changes: [change(path)], contentChanged: true, config: { none: [glob], sensitive: [], nits: 3 } }).tier ===
    'none'

  test.each([
    ['a/*.ts', 'a/b/c.ts', true],
    ['**/*.sql', 'x.sql', true],
    ['**/*.sql', 'a/b/x.sql', true],
    ['a?c', 'abc', true],
    ['a?c', 'a/c', true],
    ['[ab].ts', 'a.ts', true],
    ['[!ab].ts', 'a.ts', false],
    ['[!ab].ts', 'c.ts', true],
    ['a.b', 'axb', false],
    ['[x', '[x', true],
  ])('%s vs %s', (glob, path, expected) => {
    expect(out(glob, path)).toBe(expected)
  })
})

describe('routeRange', () => {
  const git = async (cwd: string, ...args: string[]) =>
    gitRunner(cwd, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args])
  const write = (repo: string, path: string, content: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
  const commit = async (repo: string, message: string) => {
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-qm', message)
    return (await git(repo, 'rev-parse', 'HEAD')).trim()
  }

  test('rename, whitespace, REVIEW.md at base, classifier seam', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'agw-route-'))
    await git(repo, 'init', '-q')
    const body = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    write(repo, 'REVIEW.md', '---\nsensitive: [src/secret.ts]\n---\n')
    write(repo, 'src/a.ts', `${body}\n`)
    write(repo, 'src/secret.ts', 'x\n')
    const c0 = await commit(repo, 'base')

    renameSync(join(repo, 'src/a.ts'), join(repo, 'src/b.ts'))
    const c1 = await commit(repo, 'rename')
    expect(await routeRange({ git: gitRunner, repo, base: c0, head: c1 })).toMatchObject({
      tier: 'none',
      rule: 'no content change (renames or whitespace only)',
    })

    write(repo, 'src/b.ts', `${body.replaceAll('line', 'line  ')}\n\n`)
    const c2 = await commit(repo, 'whitespace')
    expect(await routeRange({ git: gitRunner, repo, base: c1, head: c2 })).toMatchObject({ tier: 'none' })

    write(repo, 'src/secret.ts', 'y\n')
    write(repo, 'REVIEW.md', '---\nsensitive: []\n---\n')
    const c3 = await commit(repo, 'sensitive edit and config change')
    const atBase = await routeRange({ git: gitRunner, repo, base: c0, head: c3 })
    expect(atBase).toMatchObject({ tier: 'deep', config: { sensitive: ['src/secret.ts'] } })
    expect(atBase.changes.map((c) => c.path).sort()).toEqual(['REVIEW.md', 'src/a.ts', 'src/b.ts', 'src/secret.ts'])

    const configAt = await routeRange({ git: gitRunner, repo, base: c0, head: c3, configAt: c3 })
    expect(configAt).toMatchObject({ tier: 'standard', config: { sensitive: [] } })

    write(repo, 'src/big.ts', `${body}\n${body}\n`)
    const c4 = await commit(repo, 'default case')
    let calls = 0
    const classify = async () => {
      calls++
      return 'deep' as const
    }
    const unclassified = await routeRange({ git: gitRunner, repo, base: c3, head: c4 })
    expect(unclassified).toMatchObject({ tier: 'standard', decidedBy: 'default' })

    const classified = await routeRange({ git: gitRunner, repo, base: c3, head: c4, classify })
    expect(classified).toMatchObject({
      tier: 'deep',
      decidedBy: 'classifier',
      rule: 'classifier: deep (rules left it open)',
      seat: SEATS.deep,
    })
    expect(calls).toBe(1)

    await routeRange({ git: gitRunner, repo, base: c0, head: c1, classify })
    await routeRange({ git: gitRunner, repo, base: c0, head: c3, classify })
    expect(calls).toBe(1)

    const raised = await routeRange({
      git: gitRunner,
      repo,
      base: c3,
      head: c4,
      classify: async () => 'light',
      min: 'standard',
    })
    expect(raised).toMatchObject({
      tier: 'standard',
      decidedBy: 'caller',
      rule: 'classifier: light (rules left it open) (raised by caller from light)',
    })
  })

  test('REVIEW.md missing at base means defaults', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'agw-route-'))
    await git(repo, 'init', '-q')
    write(repo, 'a.txt', 'x\n')
    const c0 = await commit(repo, 'base')
    write(repo, 'REVIEW.md', '---\nnone: [a.txt]\n---\n')
    write(repo, 'a.txt', 'y\n')
    const c1 = await commit(repo, 'edit')
    expect(await routeRange({ git: gitRunner, repo, base: c0, head: c1 })).toMatchObject({
      tier: 'light',
      config: DEFAULT_REVIEW_CONFIG,
    })
  })
})
