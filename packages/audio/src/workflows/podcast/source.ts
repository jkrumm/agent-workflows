import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

// `sourcePaths`: the notes the owner names as an episode's source, read as legacy read them (audio-gateway
// `podcast-research.ts` `resolveInVault` / `readBrainNotes`): any non-hidden `.md` inside the vault, raw (frontmatter
// included), symlink-safe. Deliberately wider than the vault capability the research agent's tools use (`wiki/`,
// `Areas/`, `Projects/` only): the source is the caller's own choice of notes (an `Inbox/` draft included), the agent's
// reads are the model's. A note is never cut: one above the source limit fails the run with a clear error.

/** Legacy's limit on the whole source; a single note above it can never fit. */
export const SOURCE_NOTE_MAX_CHARS = 200_000

export interface SourceReader {
  /** The note's raw text; throws a message naming the path when it may not be read or is too long. */
  read(path: string): Promise<string>
}

/** `.md` only, no path segment starting with "." (no `.obsidian/`, no dotfile, no hidden directory). */
function allowed(rel: string): boolean {
  const segments = rel.split(/[\\/]/).filter(Boolean)
  if (segments.some((segment) => segment.startsWith('.'))) return false
  return rel.toLowerCase().endsWith('.md')
}

const escapes = (rel: string) => rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)

export function vaultSourceReader(vaultDir: string): SourceReader {
  return {
    async read(requested) {
      // The vault may store a name decomposed or composed; the caller's form is normalised, the file system matches.
      const path = requested.normalize('NFC')
      if (isAbsolute(path)) throw new Error(`"${requested}": the path must be relative to the vault`)
      const lexical = relative(vaultDir, resolve(vaultDir, path))
      if (escapes(lexical)) throw new Error(`"${requested}": the path escapes the vault`)
      if (!allowed(lexical)) throw new Error(`"${requested}": only markdown notes outside hidden directories`)
      let real: string
      let root: string
      try {
        root = await realpath(vaultDir)
        real = await realpath(resolve(vaultDir, path))
      } catch {
        throw new Error(`"${requested}": not found`)
      }
      // A symlink inside the vault that points out of it is refused like `..`.
      if (escapes(relative(root, real))) throw new Error(`"${requested}": the path escapes the vault`)
      if (!(await stat(real)).isFile()) throw new Error(`"${requested}": not a file`)
      const text = await readFile(real, 'utf8')
      if (text.length > SOURCE_NOTE_MAX_CHARS) {
        throw new Error(
          `"${requested}": the note has ${text.length} characters, above the ${SOURCE_NOTE_MAX_CHARS} limit`,
        )
      }
      return text
    },
  }
}
