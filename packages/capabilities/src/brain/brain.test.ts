import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Usage } from '../context.ts'
import { createBrainCapabilities } from './index.ts'
import { linksOf } from './read.ts'
import { cleanPath, readable } from './vault.ts'

// A temp vault with the real vault's shape, a secret outside it, and every way out a path can take.
const base = mkdtempSync(join(tmpdir(), 'agw-brain-'))
const vault = join(base, 'vault')
const outside = join(base, 'outside')

const note = (path: string, text: string) => {
  mkdirSync(join(vault, path, '..'), { recursive: true })
  writeFileSync(join(vault, path), text)
}

const [search, read] = createBrainCapabilities({ env: { AGW_BRAIN_DIR: vault } })

async function searchFor(query: string, maxResults?: number) {
  return search.call({ query, ...(maxResults ? { maxResults } : {}) })
}

beforeAll(() => {
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.md'), '---\ntype: Secret\n---\nthe launch code is 0000\n')
  note('index.md', '# Home\n\nSee [[model-routing]] and [[health-index]].\n')
  note(
    'wiki/engineering/model-routing.md',
    '---\ntype: Concept\ntitle: Model routing\ntags:\n  - engineering\ntimestamp: 2026-10-05\n---\n\n# Model routing\n\nTwo billing lanes. See [[pinning|Pinning]] and ![[diagram#top]].\n',
  )
  note(
    'wiki/engineering/pinning.md',
    '---\ntype: Concept\n---\nPin versions with a lockfile. Pinned versions never drift.\n',
  )
  note('wiki/health/index.md', '---\ntype: Index\ntitle: Health\n---\nHealth map: [[health-index]]\n')
  note('wiki/finance/index.md', '---\ntype: Index\n---\nFinance map\n')
  note('Areas/Health/Health.md', 'Dosierung und Schlaf. Kein Frontmatter hier.\n')
  note('Projects/p/p.md', '---\n: [broken yaml\n---\nbody of p\n')
  note('Inbox/raw.md', 'inbox secret launch code\n')
  note('.obsidian/workspace.md', 'dotdir launch code\n')
  note('wiki/.hidden.md', 'dotfile launch code\n')
  note('node_modules/pkg/readme.md', 'node_modules launch code\n')
  note('docs/brain-access.md', 'docs launch code\n')
  note('log.md', 'the private journal launch code\n')
  note('wiki/engineering/not-a-note.txt', 'launch code in a text file\n')
  // A nested-anchor ("billion laughs") frontmatter: parsed as YAML it would expand to 9^9 values.
  note(
    'wiki/bomb.md',
    `---\nlol0: &lol0 [x, x, x, x, x, x, x, x, x]\n${Array.from({ length: 8 }, (_, i) => `lol${i + 1}: &lol${i + 1} [${Array(9).fill(`*lol${i}`).join(', ')}]`).join('\n')}\n---\nbomb body\n`,
  )
  note('wiki/huge-frontmatter.md', `---\ntype: Concept\nnotes: ${'f'.repeat(50_000)}\n---\nshort body\n`)
  // Names in the other Unicode form and in other case than a request will use.
  note(`wiki/fr/${'Übung'.normalize('NFD')}.md`, 'Übung macht den Meister. Kein Frontmatter.\n')
  note('wiki/many-lines.md', Array.from({ length: 5 }, (_, i) => `repeat ${i}`).join('\n'))
  note('wiki/a/dup.md', 'first dup')
  note('wiki/b/dup.md', 'second dup')
  note('wiki/big.md', `---\ntype: Concept\n---\n${'x'.repeat(5_000)} needle\n`)
  // Ways out: a symlink to a note outside, a symlinked directory outside, a symlink into Inbox/, and an in-vault symlink.
  symlinkSync(join(outside, 'secret.md'), join(vault, 'wiki', 'escape.md'))
  symlinkSync(outside, join(vault, 'wiki', 'outdir'))
  symlinkSync('../../Inbox/raw.md', join(vault, 'wiki', 'engineering', 'to-inbox.md'))
  symlinkSync('pinning.md', join(vault, 'wiki', 'engineering', 'alias.md'))
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('brain.search', () => {
  test('finds a word across wiki, Areas, Projects and index.md with path, line and snippet', async () => {
    const out = await searchFor('model-routing')
    expect(out.matches.map((m) => m.path)).toContain('index.md')
    const lane = await searchFor('billing lanes')
    expect(lane.matches[0]).toEqual({
      path: 'wiki/engineering/model-routing.md',
      line: 11,
      snippet: expect.stringContaining('Two billing lanes'),
    })
    expect((await searchFor('schlaf')).matches.map((m) => m.path)).toEqual(['Areas/Health/Health.md'])
    expect((await searchFor('broken')).matches.map((m) => m.path)).toEqual(['Projects/p/p.md'])
  })

  test('never reaches Inbox, dotdirs, dotfiles, node_modules, docs, log.md, non-md files or anything outside', async () => {
    const out = await searchFor('launch code')
    expect(out.matches).toEqual([])
    expect(out.notes).toBe(0)
    expect((await searchFor('inbox')).matches).toEqual([])
    expect((await searchFor('secret')).matches).toEqual([])
  })

  test('a symlink to a note inside the vault is an alias, listed once under the note; one that leaves it (or goes into Inbox) is not', async () => {
    const paths = (await searchFor('lockfile')).matches.map((m) => m.path)
    expect(paths).toEqual(['wiki/engineering/pinning.md'])
  })

  test('words are any-of, notes holding more of them rank first, ranking is deterministic', async () => {
    const out = await searchFor('lockfile pin')
    expect(out.matches.map((m) => m.path)).toEqual(['wiki/engineering/pinning.md', 'wiki/engineering/model-routing.md'])
    expect(await searchFor('lockfile pin')).toEqual(out)
  })

  test('results are capped and say so; a long line is cut around the match', async () => {
    const capped = await searchFor('concept', 1)
    expect(capped.matches).toHaveLength(1)
    expect(capped.truncated).toBe(true)
    const long = await searchFor('needle')
    expect(long.matches[0]?.snippet.length).toBeLessThanOrEqual(202)
    expect(long.matches[0]?.snippet).toContain('needle')
  })

  test("truncated is also true when a note's lines were capped at three", async () => {
    const out = await searchFor('repeat')
    expect(out.matches.map((m) => m.line)).toEqual([1, 2, 3])
    expect(out.notes).toBe(1)
    expect(out.truncated).toBe(true)
    expect(out.warnings).toEqual([])
    expect((await searchFor('lockfile')).truncated).toBe(false)
  })

  test('costs nothing and is priced at zero', async () => {
    const seen: Usage[] = []
    await search.call({ query: 'lockfile' }, { addUsage: (u) => seen.push(u) })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ cost: 0, costSource: 'rate' })
  })
})

describe('brain.read', () => {
  test('a note by path: frontmatter, body, outbound links without alias or heading', async () => {
    const out = await read.call({ note: 'wiki/engineering/model-routing.md' })
    expect(out).toMatchObject({
      found: true,
      path: 'wiki/engineering/model-routing.md',
      frontmatter: 'type: Concept\ntitle: Model routing\ntags:\n  - engineering\ntimestamp: 2026-10-05',
      links: ['pinning', 'diagram'],
      truncated: false,
    })
    if (out.found) expect(out.body).toContain('# Model routing')
  })

  test('a note by [[wikilink]] name, with alias and heading stripped; case-insensitive; a path-qualified name', async () => {
    for (const note of [
      '[[model-routing]]',
      '[[Model-Routing|Routing]]',
      '[[model-routing#top]]',
      '[[wiki/engineering/model-routing]]',
    ]) {
      expect(await read.call({ note })).toMatchObject({ found: true, path: 'wiki/engineering/model-routing.md' })
    }
  })

  test('an ambiguous name lists its candidates; an unknown one is not found', async () => {
    expect(await read.call({ note: '[[dup]]' })).toEqual({
      found: false,
      reason: '[[dup]] is ambiguous',
      candidates: ['wiki/a/dup.md', 'wiki/b/dup.md'],
    })
    expect(await read.call({ note: '[[b/dup]]' })).toMatchObject({ found: true, path: 'wiki/b/dup.md' })
    expect(await read.call({ note: '[[no-such-note]]' })).toMatchObject({ found: false })
  })

  test('a note without frontmatter reads with "", and frontmatter is returned as written, never parsed', async () => {
    expect(await read.call({ note: 'Areas/Health/Health.md' })).toMatchObject({ found: true, frontmatter: '' })
    // Not parsed, so not "invalid": the text is returned as written.
    expect(await read.call({ note: 'Projects/p/p.md' })).toMatchObject({
      found: true,
      frontmatter: ': [broken yaml',
      body: 'body of p\n',
    })
  })

  test('the body is cut with a marker', async () => {
    const out = await read.call({ note: 'wiki/big.md', maxChars: 100 })
    expect(out).toMatchObject({ found: true, truncated: true })
    if (out.found) {
      expect(out.body.startsWith('x'.repeat(80))).toBe(true)
      expect(out.frontmatter.length + out.body.indexOf('\n\n[truncated')).toBe(100)
      expect(out.body).toContain('[truncated: ')
    }
  })

  test('an in-vault symlink reads as the note it points to: the canonical path comes from the realpath', async () => {
    expect(await read.call({ note: 'wiki/engineering/alias.md' })).toMatchObject({
      found: true,
      path: 'wiki/engineering/pinning.md',
    })
    expect(await read.call({ note: '[[alias]]' })).toMatchObject({ found: false })
  })

  test('a nested-anchor frontmatter is returned as text, not expanded', async () => {
    const started = performance.now()
    const out = await read.call({ note: 'wiki/bomb.md' })
    expect(out).toMatchObject({ found: true, body: 'bomb body\n' })
    if (out.found) {
      expect(out.frontmatter.startsWith('lol0: &lol0 [x, x')).toBe(true)
      expect(out.frontmatter).toContain('lol8: &lol8 [*lol7, *lol7')
      expect(out.frontmatter.length).toBeLessThan(2_000)
    }
    // 9^9 values if the aliases were expanded; the raw text takes milliseconds.
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test('maxChars covers frontmatter and body together; each is cut with a marker', async () => {
    const out = await read.call({ note: 'wiki/huge-frontmatter.md', maxChars: 1_000 })
    expect(out).toMatchObject({ found: true, truncated: true })
    if (out.found) {
      expect(out.frontmatter.length).toBeLessThan(500 + 60)
      expect(out.frontmatter).toContain('[truncated: ')
      // The body is short and whole; frontmatter + body stay within maxChars plus the marker.
      expect(out.body).toBe('short body\n')
      expect(out.frontmatter.length + out.body.length).toBeLessThan(1_000 + 60)
    }
    const whole = await read.call({ note: 'wiki/huge-frontmatter.md', maxChars: 100_000 })
    if (whole.found) expect(whole.frontmatter.length).toBeLessThan(50_000 + 60)
  })

  describe('canonical paths: NFC, and the path of the file that was opened', () => {
    const nfc = 'wiki/fr/Übung.md'.normalize('NFC')
    const nfd = nfc.normalize('NFD')

    test('an NFD file name reads under both forms and always prints NFC', async () => {
      expect(nfd).not.toBe(nfc)
      for (const note of [nfc, nfd, `[[Übung]]`.normalize('NFC'), `[[Übung]]`.normalize('NFD'), '[[wiki/fr/übung]]']) {
        const out = await read.call({ note })
        expect(out).toMatchObject({ found: true })
        if (out.found) expect(out.path).toBe(nfc) // string equality: NFC, not merely canonically equivalent
      }
      const hit = (await searchFor('meister')).matches[0]
      expect(hit?.path).toBe(nfc)
      expect((await searchFor('Übung'.normalize('NFD'))).matches[0]?.path).toBe(nfc)
    })

    test('a case-variant path or name finds the same note under its canonical path', async () => {
      for (const note of ['WIKI/Engineering/PINNING.MD', 'wiki/engineering/Pinning.md', '[[PINNING]]']) {
        const out = await read.call({ note })
        expect(out).toMatchObject({ found: true, path: 'wiki/engineering/pinning.md' })
      }
    })

    test('exclusions are case-insensitive: Inbox, node_modules, .md, dotdirs under any spelling', async () => {
      for (const note of [
        'INBOX/raw.md',
        'inbox/Raw.MD',
        'Node_Modules/pkg/readme.md',
        'wiki/.HIDDEN.md',
        '.OBSIDIAN/workspace.md',
      ]) {
        expect((await read.call({ note })).found).toBe(false)
      }
      expect(readable('wiki/x.MD')).toBe(true)
      expect(readable('WIKI/x.md')).toBe(true)
      expect(readable('wiki/Node_Modules/x.md')).toBe(false)
      expect(readable('INBOX/x.md')).toBe(false)
      expect(readable('Index.MD')).toBe(true)
    })
  })

  test('a note swapped for a symlink out of the vault after the check is not read (descriptor check)', async () => {
    // readNote vets the real path, then reads through one O_NOFOLLOW descriptor whose fstat must equal the vetted lstat.
    const swap = join(vault, 'wiki', 'swap.md')
    writeFileSync(swap, 'inside\n')
    expect(await read.call({ note: 'wiki/swap.md' })).toMatchObject({ found: true, body: 'inside\n' })
    rmSync(swap)
    symlinkSync(join(outside, 'secret.md'), swap)
    const after = await read.call({ note: 'wiki/swap.md' })
    expect(after.found).toBe(false)
    expect(JSON.stringify(after)).not.toContain('launch code')
    rmSync(swap)
  })

  test('linksOf is linear: a long line of openings with no close costs milliseconds', () => {
    const attack = '[['.repeat(200_000)
    const started = performance.now()
    expect(linksOf(attack)).toEqual([])
    expect(linksOf(`${attack}\n[[real]] and [[also|alias#h]]`)).toEqual(['real', 'also'])
    expect(linksOf(`[[${'a'.repeat(100_000)}]]`)).toEqual([])
    // A bound far above the milliseconds a linear scan takes and far below a quadratic one's minutes; loaded hosts run slow.
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(linksOf('[[a]] [[a]] ![[b#c]] [[ ]] [[x\ny]] [[p]q]] [[[[z]]')).toEqual(['a', 'b', '[[z'])
  })

  describe('refusals: every way out is "not found", and nothing outside is ever returned', () => {
    const attempts: [string, string][] = [
      ['a .. escape', '../outside/secret.md'],
      ['a .. escape through wiki', 'wiki/../../outside/secret.md'],
      ['a .. that stays inside the vault', 'wiki/engineering/../health/index.md'],
      ['an absolute path', join(outside, 'secret.md')],
      ['an absolute path to a vault note', join(vault, 'index.md')],
      ['a symlinked note outside the vault', 'wiki/escape.md'],
      ['a file through a symlinked directory outside', 'wiki/outdir/secret.md'],
      ['a symlink into Inbox/', 'wiki/engineering/to-inbox.md'],
      ['Inbox/', 'Inbox/raw.md'],
      ['Inbox/ in other case', 'inbox/raw.md'],
      ['a dotdir', '.obsidian/workspace.md'],
      ['a dotfile', 'wiki/.hidden.md'],
      ['node_modules', 'node_modules/pkg/readme.md'],
      ['docs/', 'docs/brain-access.md'],
      ['log.md', 'log.md'],
      ['a non-md file', 'wiki/engineering/not-a-note.txt'],
      ['percent-encoded dots', '%2e%2e/outside/secret.md'],
      ['percent-encoded slashes', 'wiki%2fengineering%2fpinning.md'],
      ['a backslash', 'wiki\\engineering\\pinning.md'],
      ['a NUL', 'wiki/engineering/pinning.md\0.txt'],
      ['a directory', 'wiki/engineering'],
      ['a doubled slash', 'wiki//engineering/pinning.md'],
      ['a trailing slash', 'wiki/engineering/pinning.md/'],
      ['a wikilink escape', '[[../outside/secret]]'],
      ['a wikilink to Inbox', '[[Inbox/raw]]'],
      ['a wikilink name of a hidden file', '[[.hidden]]'],
      ['a wikilink that names an escaping symlink', '[[escape]]'],
    ]
    for (const [name, note] of attempts) {
      test(name, async () => {
        const out = await read.call({ note })
        expect(out.found).toBe(false)
        expect(JSON.stringify(out)).not.toContain('launch code')
      })
    }
  })
})

describe('the vault root', () => {
  test('AGW_BRAIN_DIR missing or not a directory is NOT_CONFIGURED, on both tools', async () => {
    for (const dir of [join(base, 'nope'), join(vault, 'index.md')]) {
      const [s, r] = createBrainCapabilities({ env: { AGW_BRAIN_DIR: dir } })
      expect(await s.call({ query: 'x' }).catch((e) => e)).toMatchObject({ code: 'NOT_CONFIGURED' })
      expect(await r.call({ note: 'index.md' }).catch((e) => e)).toMatchObject({ code: 'NOT_CONFIGURED' })
    }
  })

  test('an unset variable falls back to the default location, never to the process cwd', async () => {
    const [s] = createBrainCapabilities({ env: { AGW_BRAIN_DIR: '  ' } })
    // The default exists on the dev host and not on CI: either way the answer is a result or NOT_CONFIGURED.
    const out = await s.call({ query: 'zzzz-never-in-any-note' }).catch((e) => e)
    if (out instanceof Error) expect(out).toMatchObject({ code: 'NOT_CONFIGURED' })
    else expect(out.matches).toEqual([])
  })
})

describe('path rules', () => {
  test('readable is a positive list', () => {
    expect(readable('index.md')).toBe(true)
    expect(readable('wiki/a/b.md')).toBe(true)
    expect(readable('Areas/x.md')).toBe(true)
    expect(readable('Projects/x/y.md')).toBe(true)
    for (const no of [
      'AGENTS.md',
      'Inbox/a.md',
      'wiki/a.txt',
      'wiki/.a/b.md',
      'wiki/node_modules/a.md',
      'wiki',
      'a/wiki/b.md',
    ])
      expect(readable(no)).toBe(false)
  })

  test('cleanPath normalizes ./ and refuses the rest', () => {
    expect(cleanPath('./wiki/./a.md')).toBe('wiki/a.md')
    for (const no of ['', '/wiki/a.md', 'C:/wiki/a.md', 'wiki/../wiki/a.md', '..', 'wiki/a.md\0'])
      expect(cleanPath(no)).toBeNull()
  })
})
