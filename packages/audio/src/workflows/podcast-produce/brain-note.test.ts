import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type EpisodeNoteInput,
  type EpisodeProfile,
  episodeNoteFilename,
  renderEpisodeNote,
  renderFolderNote,
  writeEpisodeBrainNote,
} from './brain-note.ts'
import { setProduceLogger } from './log.ts'

// Ports audio-gateway/src/brain-note.test.ts. The git cases run on real temp repos with a bare repo as the push remote —
// no network, no global git identity (CI has none), no shell. Lock waits go through an injected sleep, never a real wait.

setProduceLogger({ warn: () => {}, error: () => {} })

const PROFILE: EpisodeProfile = {
  format: 'Erklärstück',
  lead: 'A',
  humor: 'sparse',
  opening: 'Direkt rein',
  minutes: 18,
  durationSeconds: 1080,
  topics: ['Peptide', 'Recovery'],
  segmentCount: 4,
  toolCalls: 3,
  researchCalls: 1,
}

const TRANSCRIPT_MARKDOWN = [
  '# Test Episode',
  '',
  'A short description of the episode.',
  '',
  '## Segment One',
  '',
  '**Jonas:** Hallo und willkommen.',
  "**Lena:** Und los geht's.",
  '',
].join('\n')

const MULTI_PARAGRAPH_TRANSCRIPT_MARKDOWN = [
  '# Test Episode',
  '',
  'First paragraph of the description.',
  '',
  'Second paragraph of the description.',
  '',
  '## Segment One',
  '',
  '**Jonas:** Hallo und willkommen.',
  '',
].join('\n')

function baseInput(overrides: Partial<EpisodeNoteInput> = {}): EpisodeNoteInput {
  return {
    brainDir: '/tmp/does-not-matter',
    jobId: 'job-123',
    title: 'Test Episode',
    description: 'A short description of the episode.',
    series: 'Brain Sonderausgabe',
    createdAt: '2026-09-06T12:00:00.000Z',
    profile: PROFILE,
    transcriptMarkdown: TRANSCRIPT_MARKDOWN,
    absItemId: null,
    ...overrides,
  }
}

describe('renderEpisodeNote', () => {
  test('frontmatter carries the expected keys and the transcript heading/description are not duplicated', () => {
    const note = renderEpisodeNote(baseInput())
    expect(note).toContain('---\n')
    expect(note).toContain('title: "Test Episode"')
    expect(note).toContain('date: 2026-09-06')
    expect(note).toContain('tags: [podcast, brain-sonderausgabe]')
    expect(note).toContain('series: "Brain Sonderausgabe"')
    expect(note).toContain('format: "Erklärstück"')
    expect(note).toContain('lead: A')
    expect(note).toContain('humor: sparse')
    expect(note).toContain('minutes: 18')
    expect(note).toContain('topics:\n  - "Peptide"\n  - "Recovery"')
    expect(note).toContain('job: job-123')
    expect(note).not.toContain('abs:')

    expect(note).toContain('# Test Episode')
    expect(note).toContain('## Transkript')
    // The transcript's own leading "# Test Episode" + description line must not repeat inside the body.
    const afterTranskript = note.split('## Transkript')[1] ?? ''
    expect(afterTranskript).not.toContain('# Test Episode\n')
    expect(afterTranskript).toContain('## Segment One')
    expect(afterTranskript).toContain('**Jonas:** Hallo und willkommen.')
  })

  test('quotes a title containing a colon', () => {
    const note = renderEpisodeNote(baseInput({ title: 'Titel: Der Doppelpunkt' }))
    expect(note).toContain('title: "Titel: Der Doppelpunkt"')
  })

  test('quotes a plain title with no special characters, e.g. a trailing episode number', () => {
    const note = renderEpisodeNote(baseInput({ title: 'Der Roadtrip #1' }))
    expect(note).toContain('title: "Der Roadtrip #1"')
  })

  test('escapes an embedded double quote', () => {
    const note = renderEpisodeNote(baseInput({ title: 'Er sagte "Hallo"' }))
    expect(note).toContain('title: "Er sagte \\"Hallo\\""')
  })

  test('escapes a backslash', () => {
    const note = renderEpisodeNote(baseInput({ title: 'C:\\Users\\test' }))
    expect(note).toContain('title: "C:\\\\Users\\\\test"')
  })

  test('includes abs when present', () => {
    const note = renderEpisodeNote(baseInput({ absItemId: 'abs-item-1' }))
    expect(note).toContain('abs: abs-item-1')
  })

  test('writes topics: [] when there are none', () => {
    const note = renderEpisodeNote(baseInput({ profile: { ...PROFILE, topics: [] } }))
    expect(note).toContain('topics: []')
  })

  test('does not duplicate a multi-paragraph description', () => {
    const note = renderEpisodeNote(baseInput({ transcriptMarkdown: MULTI_PARAGRAPH_TRANSCRIPT_MARKDOWN }))
    const afterTranskript = note.split('## Transkript')[1] ?? ''
    expect(afterTranskript).not.toContain('First paragraph of the description.')
    expect(afterTranskript).not.toContain('Second paragraph of the description.')
    expect(afterTranskript).toContain('## Segment One')
    expect(afterTranskript).toContain('**Jonas:** Hallo und willkommen.')
  })
})

describe('episodeNoteFilename', () => {
  test("formats as '<yyyy-mm-dd> <title>.md' and keeps umlauts", () => {
    expect(episodeNoteFilename('2026-09-06T12:00:00.000Z', 'Erklärstück über Peptide')).toBe(
      '2026-09-06 Erklärstück über Peptide.md',
    )
  })

  test('strips filesystem-hostile characters', () => {
    const name = episodeNoteFilename('2026-01-01T00:00:00.000Z', 'A/B\\C:D*E?F"G<H>I|J')
    expect(name).toBe('2026-01-01 ABCDEFGHIJ.md')
  })

  test('collapses whitespace and caps at 80 chars', () => {
    const longTitle = `word ${'x'.repeat(100)}`
    const name = episodeNoteFilename('2026-01-01T00:00:00.000Z', `Multiple   \n\n  spaces   ${longTitle}`)
    expect(name.startsWith('2026-01-01 Multiple spaces word ')).toBe(true)
    expect(name.length).toBeLessThanOrEqual('2026-01-01 '.length + 80 + '.md'.length)
  })
})

describe('renderFolderNote', () => {
  test('sorts entries newest first', () => {
    const note = renderFolderNote([
      { file: '2026-01-01 Old', title: 'Old', date: '2026-01-01', format: 'Kurzbriefing', minutes: 5 },
      { file: '2026-03-01 New', title: 'New', date: '2026-03-01', format: 'Erklärstück', minutes: 20 },
      { file: '2026-02-01 Mid', title: 'Mid', date: '2026-02-01', format: 'Interview', minutes: 10 },
    ])
    const lines = note.split('\n').filter((l) => l.startsWith('- [['))
    expect(lines).toEqual([
      '- [[2026-03-01 New|New]] — 2026-03-01 · Erklärstück · 20 min',
      '- [[2026-02-01 Mid|Mid]] — 2026-02-01 · Interview · 10 min',
      '- [[2026-01-01 Old|Old]] — 2026-01-01 · Kurzbriefing · 5 min',
    ])
  })

  test('renders an empty list without entries', () => {
    const note = renderFolderNote([])
    expect(note).toContain('# Podcasts')
    expect(note.split('\n').some((l) => l.startsWith('- [['))).toBe(false)
  })
})

describe('writeEpisodeBrainNote', () => {
  const cleanup: string[] = []
  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function tmp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    cleanup.push(dir)
    return dir
  }

  function git(cwd: string, ...args: string[]): string {
    const out = Bun.spawnSync(['git', ...args], { cwd })
    if (out.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr.toString()}`)
    return out.stdout.toString()
  }

  /** A repo with a local identity (CI has no global one), an initial commit on `main`, and optionally a bare push remote. */
  function initVault(withRemote: boolean): { vault: string; remote: string | null } {
    const vault = tmp('brain-vault-')
    git(vault, 'init', '-q', '-b', 'main')
    git(vault, 'config', 'user.email', 'test@example.com')
    git(vault, 'config', 'user.name', 'Test')
    git(vault, 'config', 'commit.gpgsign', 'false')
    git(vault, 'commit', '--allow-empty', '-q', '-m', 'init')
    if (!withRemote) return { vault, remote: null }
    const remote = tmp('brain-remote-')
    git(remote, 'init', '--bare', '-q', '-b', 'main')
    git(vault, 'remote', 'add', 'origin', remote)
    git(vault, 'push', '-q', '-u', 'origin', 'main')
    return { vault, remote }
  }

  const freshLockDir = () => join(tmp('brain-lock-test-'), 'lock')
  const commitCount = (vault: string) => Number(git(vault, 'rev-list', '--count', 'HEAD').trim())

  test('writes the note + folder note and commits + pushes to the remote', async () => {
    const { vault, remote } = initVault(true)
    const lockDir = freshLockDir()

    const result = await writeEpisodeBrainNote(baseInput({ brainDir: vault, lockDir }))

    expect(existsSync(result.path)).toBe(true)
    expect(result.path.endsWith('2026-09-06 Test Episode.md')).toBe(true)
    const folderNotePath = join(vault, 'Areas', 'Podcasts', 'Podcasts.md')
    expect(readFileSync(folderNotePath, 'utf8')).toContain('2026-09-06 Test Episode|Test Episode')
    expect(result.committed).toBe(true)
    expect(result.pushed).toBe(true)
    expect(existsSync(lockDir)).toBe(false) // released once the git chain finished
    expect(git(vault, 'log', '--oneline', '-1')).toContain('podcast: Test Episode')
    expect(git(remote as string, 'log', '--oneline', '-1', 'main')).toContain('podcast: Test Episode')
    expect(git(vault, 'status', '--porcelain')).toBe('')
  })

  test('a repo without a remote commits but does not push, and does not throw', async () => {
    const { vault } = initVault(false)
    const result = await writeEpisodeBrainNote(baseInput({ brainDir: vault, lockDir: freshLockDir() }))
    expect(result.committed).toBe(true)
    expect(result.pushed).toBe(false)
    expect(git(vault, 'log', '--oneline', '-1')).toContain('podcast: Test Episode')
  })

  test('returns committed:false without throwing when the directory is not a git repo', async () => {
    const plainDir = tmp('brain-plain-')
    const lockDir = freshLockDir()
    const result = await writeEpisodeBrainNote(baseInput({ brainDir: plainDir, lockDir }))
    expect(existsSync(result.path)).toBe(true)
    expect(result.committed).toBe(false)
    expect(result.pushed).toBe(false)
    expect(existsSync(lockDir)).toBe(false)
  })

  test('returns committed:false without throwing when the note cannot be written', async () => {
    const blocker = join(tmp('brain-blocked-'), 'file')
    writeFileSync(blocker, 'not a directory')
    const result = await writeEpisodeBrainNote(baseInput({ brainDir: blocker, lockDir: freshLockDir() }))
    expect(result.committed).toBe(false)
    expect(result.pushed).toBe(false)
  })

  test('waits for a held brain-sync lock, then proceeds once it is released', async () => {
    const { vault } = initVault(true)
    const lockDir = freshLockDir()
    mkdirSync(lockDir) // simulate brain-sync.sh holding the lock right now
    const sleeps: number[] = []

    const result = await writeEpisodeBrainNote(
      baseInput({
        brainDir: vault,
        lockDir,
        lockRetryAttempts: 10,
        lockRetryDelayMs: 20,
        // brain-sync.sh finishing while we wait: the first wait releases the lock.
        sleep: async (ms) => {
          sleeps.push(ms)
          rmSync(lockDir, { recursive: true, force: true })
        },
      }),
    )

    expect(sleeps).toEqual([20])
    expect(result.committed).toBe(true)
    expect(result.pushed).toBe(true)
    expect(existsSync(lockDir)).toBe(false)
  })

  test('never removes a lock it did not create, and skips the git chain while it stays busy', async () => {
    const { vault } = initVault(true)
    const lockDir = freshLockDir()
    mkdirSync(lockDir) // held by "someone else" for the whole test
    const sleeps: number[] = []

    const result = await writeEpisodeBrainNote(
      baseInput({
        brainDir: vault,
        lockDir,
        lockRetryAttempts: 2,
        lockRetryDelayMs: 5,
        sleep: async (ms) => {
          sleeps.push(ms)
        },
      }),
    )

    expect(sleeps).toEqual([5, 5])
    expect(result.committed).toBe(false)
    expect(result.pushed).toBe(false)
    expect(existsSync(lockDir)).toBe(true) // not ours — must survive
    expect(commitCount(vault)).toBe(1)
  })

  test('the commit message carries the Effect-Key line as its second paragraph', async () => {
    const { vault } = initVault(false)
    await writeEpisodeBrainNote(baseInput({ brainDir: vault, lockDir: freshLockDir(), effectKey: 'run-1:brain-note' }))
    expect(git(vault, 'log', '-1', '--format=%B').trim()).toBe('podcast: Test Episode\n\nEffect-Key: run-1:brain-note')
  })

  test('without an effect key the commit message is the subject only', async () => {
    const { vault } = initVault(false)
    await writeEpisodeBrainNote(baseInput({ brainDir: vault, lockDir: freshLockDir() }))
    expect(git(vault, 'log', '-1', '--format=%B').trim()).toBe('podcast: Test Episode')
  })

  test('writing the same note twice makes exactly one commit', async () => {
    const { vault, remote } = initVault(true)
    const input = baseInput({ brainDir: vault, lockDir: freshLockDir(), effectKey: 'run-1:brain-note' })

    const first = await writeEpisodeBrainNote(input)
    const second = await writeEpisodeBrainNote(input)

    expect(commitCount(vault)).toBe(2) // init + the note
    expect(first).toEqual(second)
    expect(second.committed).toBe(true)
    expect(second.pushed).toBe(true)
    expect(git(remote as string, 'rev-list', '--count', 'main').trim()).toBe('2')
  })

  test('a resumed run retries the push without a second commit', async () => {
    const { vault, remote } = initVault(true)
    const input = baseInput({ brainDir: vault, lockDir: freshLockDir() })
    git(vault, 'remote', 'set-url', 'origin', join(vault, 'missing-remote')) // the first run's push goes nowhere

    const first = await writeEpisodeBrainNote(input)
    expect(first).toMatchObject({ committed: true, pushed: false })

    git(vault, 'remote', 'set-url', 'origin', remote as string)
    const second = await writeEpisodeBrainNote(input)

    expect(second).toMatchObject({ committed: true, pushed: true })
    expect(commitCount(vault)).toBe(2)
    expect(git(remote as string, 'rev-list', '--count', 'main').trim()).toBe('2')
  })

  test('changed content for the same note is committed again', async () => {
    const { vault } = initVault(false)
    const lockDir = freshLockDir()
    await writeEpisodeBrainNote(baseInput({ brainDir: vault, lockDir }))
    await writeEpisodeBrainNote(baseInput({ brainDir: vault, lockDir, absItemId: 'abs-item-1' }))
    expect(commitCount(vault)).toBe(3)
  })
})
