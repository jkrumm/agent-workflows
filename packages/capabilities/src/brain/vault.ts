import { constants, type Dirent } from 'node:fs'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fail } from '../errors.ts'
import type { Env } from '../transports/config.ts'

/** The brain capabilities' dependencies. Every field defaults to production; tests inject a temp vault through `env`. */
export interface BrainDeps {
  /** Where `AGW_BRAIN_DIR` is read, on each call. Default `process.env`. */
  env?: Env
}

/** The directories of the vault an agent may search and read, lower case: names are compared case-insensitively. */
const ROOT_DIRS = ['wiki', 'areas', 'projects'] as const
/** The listing stops here: a runaway tree must not hold a call. */
export const MAX_NOTES = 20_000
/** A note is read up to this many bytes; the rest is a truncation. */
export const MAX_NOTE_BYTES = 1_000_000

export interface Vault {
  /** The vault's real path: every readable file's real path starts with it. */
  root: string
}

/** The canonical form of a path the tools print: Unicode NFC, whatever form the file system stores. */
export const canonical = (path: string) => path.normalize('NFC')

/** The form two paths are compared in (lookup and grounding): NFC and case-folded. */
export const fold = (path: string) => path.normalize('NFC').toLowerCase()

/** The vault's root from `AGW_BRAIN_DIR` (default `~/SourceRoot/brain`), resolved; `NOT_CONFIGURED` when it is no directory. */
export async function openVault(deps: BrainDeps = {}): Promise<Vault> {
  const configured = (deps.env ?? process.env).AGW_BRAIN_DIR?.trim()
  const dir = configured || join(homedir(), 'SourceRoot', 'brain')
  try {
    const root = await realpath(dir)
    if ((await stat(root)).isDirectory()) return { root }
  } catch {
    // fall through: a missing or unreadable directory is the same answer
  }
  throw fail(
    'NOT_CONFIGURED',
    `brain unavailable: AGW_BRAIN_DIR (${configured ? 'set' : 'default'}) is not a directory`,
  )
}

const inside = (root: string, real: string) => real === root || real.startsWith(root + sep)
const posix = (path: string) => path.split(sep).join('/')

/**
 * Whether a vault-relative path (posix separators) may be searched and read: a `.md` file under `wiki/`, `Areas/` or
 * `Projects/`, or the root `index.md`; no dotdir or dotfile and no `node_modules` anywhere in it. A positive list, so
 * `Inbox/` and everything the vault adds later stay out until someone allows it here. Every comparison is
 * case-insensitive: the vault lives on a case-insensitive file system, where `INBOX` is `Inbox`, and `NODE_MODULES`
 * and `.MD` must not slip past a lower-case rule.
 */
export function readable(rel: string): boolean {
  const parts = rel.split('/')
  if (parts.some((p) => p === '' || p.startsWith('.') || p.toLowerCase() === 'node_modules')) return false
  const lower = rel.toLowerCase()
  if (!lower.endsWith('.md')) return false
  if (parts.length === 1) return lower === 'index.md'
  return (ROOT_DIRS as readonly string[]).includes((parts[0] as string).toLowerCase())
}

/**
 * A request path, vetted: `null` when it names something no vault-relative path can (empty, NUL, a backslash, an
 * absolute path, a `..` segment, not `.md`, outside the readable set). Percent escapes are not decoded: `%2e%2e` is a
 * file name, which does not exist.
 */
export function cleanPath(raw: string): string | null {
  if (!raw || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return null
  const parts = raw.split('/').filter((p) => p !== '.')
  if (parts.includes('..')) return null
  const rel = parts.join('/')
  return readable(rel) ? rel : null
}

export interface NoteFile {
  /** The canonical vault-relative path, from the real path of the file that was opened (NFC). */
  path: string
  text: string
  /** The note is longer than `MAX_NOTE_BYTES`: `text` is a prefix. */
  truncated: boolean
}

/**
 * Reads one note, or `null` (absence and refusal answer alike). The path is resolved with `realpath`; the real path
 * must be inside the vault and readable by the same rules (a symlink out, or into `Inbox/`, fails here). **TOCTOU:**
 * the file is then read through ONE descriptor, opened with `O_NOFOLLOW`, and that descriptor's `fstat` (device and
 * inode) must equal the `lstat` of the vetted real path, so a path swapped for a symlink or another file after the
 * check is refused rather than read. The path is never opened again.
 */
export async function readNote(vault: Vault, rel: string): Promise<NoteFile | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const real = await realpath(join(vault.root, rel))
    if (!inside(vault.root, real)) return null
    const realRel = posix(relative(vault.root, real))
    if (!readable(realRel)) return null
    const vetted = await lstat(real)
    if (!vetted.isFile()) return null
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== vetted.dev || opened.ino !== vetted.ino) return null
    const length = Math.min(opened.size, MAX_NOTE_BYTES)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return {
      path: canonical(realRel),
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: opened.size > MAX_NOTE_BYTES,
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export interface Listing {
  /** Vault-relative paths as the file system stores them, sorted by their canonical form. */
  notes: string[]
  /** The tree held more than `MAX_NOTES` notes: the listing stops short. */
  truncated: boolean
}

/**
 * Every readable note: the regular files under the readable directories, and the root `index.md`. A symlink is never
 * listed: one that leaves the vault is not readable, and one that stays inside is an alias of a note listed under its
 * own path (so a note appears once). A call lists once and reuses the result.
 */
export async function listNotes(vault: Vault): Promise<Listing> {
  const notes: string[] = []
  let truncated = false
  const visit = async (rel: string): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(join(vault.root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.toLowerCase() === 'node_modules') continue
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (rel === '' && !(ROOT_DIRS as readonly string[]).includes(entry.name.toLowerCase())) continue
        await visit(child)
      } else if (entry.isFile() && readable(child)) {
        if (notes.length >= MAX_NOTES) {
          truncated = true
          return
        }
        notes.push(child)
      }
    }
  }
  await visit('')
  return { notes: notes.sort((a, b) => canonical(a).localeCompare(canonical(b)) || a.localeCompare(b)), truncated }
}
