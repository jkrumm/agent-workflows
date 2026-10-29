import { z } from 'zod'
import { defineCapability } from '../procedure.ts'
import { webUsage } from '../web/deps.ts'
import { type BrainDeps, canonical, listNotes, MAX_NOTES, openVault, readNote } from './vault.ts'

const MAX_TERMS = 8
const SNIPPET_CHARS = 200
// A note shows at most this many matching lines: the result lists notes, not every line of one.
const LINES_PER_NOTE = 3

export const searchInput = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('One or more words, case-insensitive; a line matches if it contains any of them'),
  maxResults: z.int().min(1).max(50).default(20).describe('Matching lines returned, at most'),
})

export const searchOutput = z.object({
  matches: z.array(
    z.object({
      path: z.string().describe('Canonical vault-relative path of the note'),
      line: z.int().describe('1-based line number in the file (frontmatter lines count)'),
      snippet: z.string().describe(`The line, cut to ${SNIPPET_CHARS} characters around the match`),
    }),
  ),
  notes: z.int().describe('Notes that contain at least one of the words'),
  truncated: z
    .boolean()
    .describe('More matching lines exist than were returned: over maxResults, or more than 3 lines in a note'),
  warnings: z.array(z.string()).describe('What cut the search short, e.g. a vault listing stopped at its cap'),
})

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The line (already trimmed) cut to a window around `at`, an offset into that same string. */
function snippetOf(text: string, at: number): string {
  if (text.length <= SNIPPET_CHARS) return text
  const start = Math.max(0, Math.min(at - Math.floor(SNIPPET_CHARS / 3), text.length - SNIPPET_CHARS))
  return `${start > 0 ? '…' : ''}${text.slice(start, start + SNIPPET_CHARS)}${start + SNIPPET_CHARS < text.length ? '…' : ''}`
}

export const createSearch = (deps: BrainDeps) =>
  defineCapability({
    id: 'brain.search',
    summary: "Search the vault's wiki/, Areas/, Projects/ and index.md for words; path, line and snippet, capped",
    input: searchInput,
    output: searchOutput,
    // `agw brain` is the workflow (`agw brain "<question>"`), and a command may not be the prefix of another.
    cli: { command: ['vault', 'search'], positional: ['query'], defaultFormat: 'json' },
    async handler({ query, maxResults }, ctx) {
      const vault = await openVault(deps)
      // A direct read sends nothing out and costs nothing: priced at $0, not unknown.
      ctx.addUsage(webUsage('brain-vault', 0))
      // One regex per word, tested on the very string it then slices: lower-casing a line can change its length.
      const terms = [...new Set(query.normalize('NFC').split(/\s+/).filter(Boolean))].slice(0, MAX_TERMS)
      const patterns = terms.map((t) => new RegExp(escapeRegex(t), 'i'))
      const listing = await listNotes(vault)
      const found: { path: string; hits: { line: number; snippet: string }[]; distinct: number; total: number }[] = []
      for (const rel of listing.notes) {
        ctx.signal.throwIfAborted()
        const note = await readNote(vault, rel)
        if (!note) continue // gone, refused or unreadable since the listing
        const text = note.text.normalize('NFC')
        const distinct = patterns.filter((p) => p.test(text)).length
        if (distinct === 0) continue
        const hits: { line: number; snippet: string }[] = []
        let total = 0
        for (const [i, raw] of text.split(/\r?\n/).entries()) {
          const line = raw.trim()
          const at = Math.min(...patterns.map((p) => line.search(p)).filter((x) => x >= 0))
          if (!Number.isFinite(at)) continue
          total++
          if (hits.length < LINES_PER_NOTE) hits.push({ line: i + 1, snippet: snippetOf(line, at) })
        }
        found.push({ path: note.path, hits, distinct, total })
      }
      // Notes that hold more of the words first, then the denser ones, then by path: the same query ranks the same.
      found.sort((a, b) => b.distinct - a.distinct || b.total - a.total || a.path.localeCompare(b.path))
      const all = found.flatMap((f) => f.hits.map((h) => ({ path: f.path, ...h })))
      const warnings = listing.truncated
        ? [`the vault listing stopped at ${MAX_NOTES} notes; later notes are not searched`]
        : []
      return {
        matches: all.slice(0, maxResults).map((m) => ({ ...m, path: canonical(m.path) })),
        notes: found.length,
        truncated: all.length > maxResults || found.some((f) => f.total > f.hits.length),
        warnings,
      }
    },
  })
