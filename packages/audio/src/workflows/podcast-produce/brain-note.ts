import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { z } from 'zod'
import type { Profile } from '../podcast/schema.ts'
import { log, messageOf } from './log.ts'

// Ports audio-gateway/src/brain-note.ts: the transcript note written back into the second brain after a podcast episode
// finishes. Best-effort: a write or git-sync failure never throws — it is logged and reflected in the returned
// `{ committed, pushed }` flags, since a finished episode must not fail the job just because the note couldn't be filed.
// Follows ~/SourceRoot/brain/AGENTS.md's folder-note convention: the folder note lives at `Areas/Podcasts/Podcasts.md`,
// same name as its folder. New against legacy: `effectKey` (second commit paragraph) and an idempotent resume (identical
// content already committed → no second commit, push is retried).

export type EpisodeProfile = z.output<typeof Profile>

export interface EpisodeNoteInput {
  brainDir: string
  jobId: string
  title: string
  description: string
  series: string
  /** ISO timestamp. */
  createdAt: string
  profile: EpisodeProfile
  /** The caller renders this (the produce stage's transcript markdown). */
  transcriptMarkdown: string
  absItemId?: string | null
  /** The workflow step's effect key; becomes the commit's second paragraph `Effect-Key: <key>`. */
  effectKey?: string
  /** brain-sync's own mkdir lock dir (dotfiles/brain/brain-sync.sh); injectable for tests, defaults to `~/Library/Caches/brain-sync.lock`. */
  lockDir?: string
  /** Injectable for tests — defaults mirror brain-sync.sh (6 retries, 5s apart). */
  lockRetryAttempts?: number
  lockRetryDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface BrainNoteResult {
  path: string
  committed: boolean
  pushed: boolean
}

const FOLDER_NOTE_TITLE = 'Podcasts'

// ---------------------------------------------------------------------------
// Pure rendering
// ---------------------------------------------------------------------------

/** Always double-quoted (backslash escaped first, then the quote) — simpler and safer than guessing which scalars need it. */
function yamlScalar(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function buildFrontmatter(input: EpisodeNoteInput): string {
  const date = input.createdAt.slice(0, 10)
  const lines: string[] = [
    '---',
    `title: ${yamlScalar(input.title)}`,
    `date: ${date}`,
    `tags: [podcast, ${slugify(input.series)}]`,
    `series: ${yamlScalar(input.series)}`,
    `format: ${yamlScalar(input.profile.format)}`,
    `lead: ${input.profile.lead}`,
    `humor: ${input.profile.humor}`,
    `minutes: ${input.profile.minutes}`,
  ]
  if (input.profile.topics.length > 0) {
    lines.push('topics:')
    for (const topic of input.profile.topics) lines.push(`  - ${yamlScalar(topic)}`)
  } else {
    lines.push('topics: []')
  }
  lines.push(`job: ${input.jobId}`)
  if (input.absItemId) lines.push(`abs: ${input.absItemId}`)
  lines.push('---')
  return lines.join('\n')
}

/**
 * The transcript markdown always opens with `# <title>\n\n<description>\n\n` before the first `## <segment>` heading —
 * strip that prefix so the episode note's own `# <title>` + description aren't duplicated above "## Transkript". Cuts at
 * the first line starting with `## ` rather than counting paragraphs, so a multi-paragraph description is dropped in full
 * instead of leaving its later paragraphs duplicated in the body.
 */
function stripHeadingAndDescription(transcriptMarkdown: string): string {
  if (!transcriptMarkdown.startsWith('# ')) return transcriptMarkdown
  const lines = transcriptMarkdown.split('\n')
  const headingIndex = lines.findIndex((line) => line.startsWith('## '))
  return headingIndex === -1 ? transcriptMarkdown : lines.slice(headingIndex).join('\n')
}

/** Pure: builds the full episode note markdown (frontmatter + title + description + transcript). */
export function renderEpisodeNote(input: EpisodeNoteInput): string {
  const lines = [
    buildFrontmatter(input),
    '',
    `# ${input.title}`,
    '',
    input.description,
    '',
    '## Transkript',
    '',
    stripHeadingAndDescription(input.transcriptMarkdown),
  ]
  return `${lines.join('\n').trimEnd()}\n`
}

/** "<yyyy-mm-dd> <title>.md" — title sanitized for a filename (umlauts kept). */
export function episodeNoteFilename(createdAt: string, title: string): string {
  const date = createdAt.slice(0, 10)
  const sanitized = title
    // Strips filesystem-hostile chars and control chars on purpose.
    // oxlint-disable-next-line no-control-regex -- control characters are exactly what is stripped here
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return `${date} ${sanitized}.md`
}

export interface FolderNoteEntry {
  file: string
  title: string
  date: string
  format: string
  minutes: number
}

/** Pure: regenerates the folder note from a directory listing, newest first. */
export function renderFolderNote(entries: FolderNoteEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  const lines = [
    '---',
    `title: ${FOLDER_NOTE_TITLE}`,
    'tags: [podcast]',
    '---',
    '',
    `# ${FOLDER_NOTE_TITLE}`,
    '',
    'Episoden der Brain-Podcast-Pipeline — automatisch generierte Transkript-Notizen.',
    '',
  ]
  for (const entry of sorted) {
    lines.push(`- [[${entry.file}|${entry.title}]] — ${entry.date} · ${entry.format} · ${entry.minutes} min`)
  }
  return `${lines.join('\n').trimEnd()}\n`
}

// ---------------------------------------------------------------------------
// Filesystem + git (best-effort)
// ---------------------------------------------------------------------------

/** Tolerant `key: value` frontmatter scan; kept local since each caller's needs are tiny and distinct. */
function parseFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return {}
  const frontmatter: Record<string, string> = {}
  for (const line of (match[1] ?? '').split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) frontmatter[key] = value
  }
  return frontmatter
}

async function collectFolderEntries(folderDir: string, folderNotePath: string): Promise<FolderNoteEntry[]> {
  let names: string[]
  try {
    names = await readdir(folderDir)
  } catch {
    return []
  }
  const entries: FolderNoteEntry[] = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.md')) continue
    const full = join(folderDir, name)
    if (full === folderNotePath) continue
    let raw: string
    try {
      raw = await readFile(full, 'utf8')
    } catch {
      continue
    }
    const frontmatter = parseFrontmatter(raw)
    const base = name.replace(/\.md$/i, '')
    entries.push({
      file: base,
      title: frontmatter.title ?? base,
      date: frontmatter.date ?? '',
      format: frontmatter.format ?? '',
      minutes: Number(frontmatter.minutes ?? '0') || 0,
    })
  }
  return entries
}

const DEFAULT_LOCK_DIR = join(homedir(), 'Library', 'Caches', 'brain-sync.lock')
const DEFAULT_LOCK_RETRY_ATTEMPTS = 6
const DEFAULT_LOCK_RETRY_DELAY_MS = 5000

/**
 * Acquire brain-sync's own mkdir lock (`~/SourceRoot/dotfiles/brain/brain-sync.sh`) before touching the vault's git state
 * — that job commits/pushes on its own 5-minute timer, and `mkdir` is the same atomic primitive it uses, so the two never
 * race for `.git/index.lock`. Retries a held lock a few times (mirrors brain-sync.sh's own tolerance) before giving up.
 * Returns whether THIS call created the lock — only the creator may remove it.
 */
async function acquireBrainSyncLock(
  lockDir: string,
  attempts: number,
  delayMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  // The default lock dir lives under ~/Library/Caches, which does not exist off macOS; the lock itself stays a plain mkdir.
  await mkdir(dirname(lockDir), { recursive: true })
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      await mkdir(lockDir)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (attempt === attempts) return false
      await sleep(delayMs)
    }
  }
  return false
}

/** Only removes the lock dir when `owned` — never clears a lock this call did not create. */
async function releaseBrainSyncLock(lockDir: string, owned: boolean): Promise<void> {
  if (!owned) return
  await rm(lockDir, { recursive: true, force: true }).catch(() => {})
}

interface GitOutcome {
  ok: boolean
  stdout: string
}

/** Runs one git command in `cwd` (argv, never a shell); `ok` is exit 0. */
async function git(cwd: string, args: string[]): Promise<GitOutcome & { exitCode: number; stderr: string }> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { ok: exitCode === 0, stdout, stderr, exitCode }
}

/** Runs one git step; logs stderr on a non-zero exit. */
async function gitStep(cwd: string, args: string[], jobId: string): Promise<boolean> {
  const out = await git(cwd, args)
  if (!out.ok) {
    log.warn('brain note git step failed', { args, exitCode: out.exitCode, stderr: out.stderr.slice(0, 500), jobId })
  }
  return out.ok
}

/** True when the note is tracked and neither it nor the folder note differs from HEAD: a resumed run with the same content. */
async function alreadyCommitted(cwd: string, notePath: string, folderNotePath: string): Promise<boolean> {
  const status = await git(cwd, ['status', '--porcelain', '--', notePath, folderNotePath])
  if (!status.ok || status.stdout.trim() !== '') return false
  return (await git(cwd, ['ls-files', '--error-unmatch', '--', notePath])).ok
}

/**
 * Write the episode note + regenerated folder note, then best-effort `git add` / `git commit` / `git push` in `brainDir`
 * — every step stops the chain on failure (logged), never pulls, never touches any other file. When the note is already
 * committed with identical content (a resumed run) the add/commit is skipped and only the push runs again.
 */
export async function writeEpisodeBrainNote(input: EpisodeNoteInput): Promise<BrainNoteResult> {
  const folderDir = join(input.brainDir, 'Areas', 'Podcasts')
  const notePath = join(folderDir, episodeNoteFilename(input.createdAt, input.title))
  const folderNotePath = join(folderDir, `${FOLDER_NOTE_TITLE}.md`)

  try {
    await mkdir(folderDir, { recursive: true })
    await writeFile(notePath, renderEpisodeNote(input), 'utf8')
    const entries = await collectFolderEntries(folderDir, folderNotePath)
    await writeFile(folderNotePath, renderFolderNote(entries), 'utf8')
  } catch (err) {
    log.warn('brain note write failed', { error: messageOf(err), jobId: input.jobId })
    return { path: notePath, committed: false, pushed: false }
  }

  const lockDir = input.lockDir ?? DEFAULT_LOCK_DIR
  let owned = false
  try {
    owned = await acquireBrainSyncLock(
      lockDir,
      input.lockRetryAttempts ?? DEFAULT_LOCK_RETRY_ATTEMPTS,
      input.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS,
      input.sleep ?? Bun.sleep,
    )
    if (!owned) {
      log.warn('brain note git chain skipped: brain-sync lock is busy', { jobId: input.jobId, lockDir })
      return { path: notePath, committed: false, pushed: false }
    }

    if (!(await alreadyCommitted(input.brainDir, notePath, folderNotePath))) {
      if (!(await gitStep(input.brainDir, ['add', '--', notePath, folderNotePath], input.jobId))) {
        return { path: notePath, committed: false, pushed: false }
      }
      const message = [
        '-m',
        `podcast: ${input.title}`,
        ...(input.effectKey ? ['-m', `Effect-Key: ${input.effectKey}`] : []),
      ]
      if (!(await gitStep(input.brainDir, ['commit', ...message, '--', notePath, folderNotePath], input.jobId))) {
        return { path: notePath, committed: false, pushed: false }
      }
    }
    const pushed = await gitStep(input.brainDir, ['push'], input.jobId)
    return { path: notePath, committed: true, pushed }
  } catch (err) {
    log.warn('brain note git chain failed', { error: messageOf(err), jobId: input.jobId })
    return { path: notePath, committed: false, pushed: false }
  } finally {
    await releaseBrainSyncLock(lockDir, owned)
  }
}
