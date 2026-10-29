import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SOURCE_NOTE_MAX_CHARS, vaultSourceReader } from './source.ts'

/** The error a promise rejects with; fails the test when it resolves. */
async function rejected(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof Error)) throw new Error('expected a rejection')
  return error
}

const roots: string[] = []
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

function makeVault(): { vault: string; outside: string } {
  const vault = temp('source-vault-')
  const outside = temp('source-outside-')
  writeFileSync(join(vault, 'note.md'), '---\ntitle: Note\n---\n\nBody text.\n')
  mkdirSync(join(vault, 'Inbox'))
  writeFileSync(join(vault, 'Inbox', 'x.md'), 'An inbox draft.')
  mkdirSync(join(vault, 'Areas'))
  writeFileSync(join(vault, 'Areas', '.hidden.md'), 'hidden file')
  writeFileSync(join(vault, 'Areas', 'plain.md'), 'plain')
  mkdirSync(join(vault, '.obsidian'))
  writeFileSync(join(vault, '.obsidian', 'x.md'), 'obsidian internals')
  mkdirSync(join(vault, 'foo', '.hidden'), { recursive: true })
  writeFileSync(join(vault, 'foo', '.hidden', 'x.md'), 'nested hidden')
  writeFileSync(join(vault, 'x.txt'), 'not markdown')
  writeFileSync(join(outside, 'secret.md'), 'top secret')
  writeFileSync(join(vault, '..outside-name.md'), 'a name that merely starts with dots')
  return { vault, outside }
}

describe('vaultSourceReader', () => {
  const { vault, outside } = makeVault()
  const reader = vaultSourceReader(vault)

  test('reads the raw file, frontmatter included', async () => {
    expect(await reader.read('note.md')).toBe('---\ntitle: Note\n---\n\nBody text.\n')
  })

  test('reads outside the brain capability’s folders (an Inbox draft)', async () => {
    expect(await reader.read('Inbox/x.md')).toBe('An inbox draft.')
    expect(await reader.read('Areas/plain.md')).toBe('plain')
  })

  test('refuses a hidden directory, a hidden file and a nested hidden directory', async () => {
    for (const path of ['.obsidian/x.md', 'Areas/.hidden.md', 'foo/.hidden/x.md']) {
      const error = await rejected(reader.read(path))
      expect(error.message).toContain(path)
      expect(error.message).toContain('outside hidden directories')
    }
  })

  test('refuses a path that escapes the vault via ..', async () => {
    const error = await rejected(reader.read('../outside.md'))
    expect(error.message).toContain('escapes the vault')
    expect((await rejected(reader.read('Inbox/../../outside.md'))).message).toContain('escapes the vault')
  })

  test('refuses an absolute path', async () => {
    const error = await rejected(reader.read(join(outside, 'secret.md')))
    expect(error.message).toContain('relative to the vault')
  })

  test('refuses a symlink inside the vault that points to a file outside it', async () => {
    symlinkSync(join(outside, 'secret.md'), join(vault, 'escape.md'))
    const error = await rejected(reader.read('escape.md'))
    expect(error.message).toContain('escapes the vault')
    expect(error.message).not.toContain('top secret')
  })

  test('refuses a symlinked directory that points outside the vault', async () => {
    symlinkSync(outside, join(vault, 'linked-dir'))
    expect((await rejected(reader.read('linked-dir/secret.md'))).message).toContain('escapes the vault')
  })

  test('refuses an in-vault symlink whose target is hidden or not markdown', async () => {
    mkdirSync(join(vault, '.git'))
    writeFileSync(join(vault, '.git', 'config'), '[core] secret = yes')
    writeFileSync(join(vault, 'notes.txt'), 'plain text, not a note')
    symlinkSync(join(vault, '.git', 'config'), join(vault, 'Inbox', 'to-git.md'))
    symlinkSync(join(vault, 'Areas', '.hidden.md'), join(vault, 'Inbox', 'to-hidden.md'))
    symlinkSync(join(vault, 'notes.txt'), join(vault, 'Inbox', 'to-text.md'))
    symlinkSync(join(vault, '.obsidian'), join(vault, 'Inbox', 'to-dir'))
    for (const path of ['Inbox/to-git.md', 'Inbox/to-hidden.md', 'Inbox/to-text.md', 'Inbox/to-dir/x.md']) {
      const error = await rejected(reader.read(path))
      expect(error.message).toContain('outside hidden directories')
      expect(error.message).not.toContain('secret')
    }
  })

  test('follows a symlink that stays inside the vault', async () => {
    symlinkSync(join(vault, 'Inbox', 'x.md'), join(vault, 'alias.md'))
    expect(await reader.read('alias.md')).toBe('An inbox draft.')
  })

  test('refuses a non-markdown file', async () => {
    expect((await rejected(reader.read('x.txt'))).message).toContain('only markdown notes')
  })

  test('a missing note is "not found"', async () => {
    const error = await rejected(reader.read('Inbox/missing.md'))
    expect(error.message).toContain('Inbox/missing.md')
    expect(error.message).toContain('not found')
  })

  test('a directory named like a note is not a file', async () => {
    mkdirSync(join(vault, 'dir.md'))
    expect((await rejected(reader.read('dir.md'))).message).toContain('not a file')
  })

  test('a note above the limit fails naming the path, it is not truncated', async () => {
    writeFileSync(join(vault, 'huge.md'), 'a'.repeat(SOURCE_NOTE_MAX_CHARS + 1))
    const error = await rejected(reader.read('huge.md'))
    expect(error.message).toContain('huge.md')
    expect(error.message).toContain(String(SOURCE_NOTE_MAX_CHARS))
    writeFileSync(join(vault, 'exact.md'), 'a'.repeat(SOURCE_NOTE_MAX_CHARS))
    expect((await reader.read('exact.md')).length).toBe(SOURCE_NOTE_MAX_CHARS)
  })

  test('the limit is 200,000 characters', () => {
    expect(SOURCE_NOTE_MAX_CHARS).toBe(200_000)
  })

  test('a name that merely starts with dots inside a segment-free path is still a hidden-name refusal, not a read', async () => {
    // ".." prefix names start with "." and so count as hidden, like any dotfile.
    expect((await rejected(reader.read('..outside-name.md'))).message).toContain('outside hidden directories')
  })

  test('a composed path reads a decomposed file name and vice versa (NFC on the caller’s side)', async () => {
    const nfc = 'Käse-Übersicht.md'
    const nfd = nfc.normalize('NFD')
    expect(nfc).not.toBe(nfd)
    writeFileSync(join(vault, nfd), 'decomposed on disk')
    // Whether the file system keeps the written form (Linux) or normalises it (APFS), the caller's NFD path must work.
    expect(await reader.read(nfd)).toBe('decomposed on disk')
    expect(await reader.read(nfc)).toBe('decomposed on disk')
  })
})
