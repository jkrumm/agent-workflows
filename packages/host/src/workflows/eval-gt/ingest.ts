import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gtPath, OwnerLabel, PackManifest, readCases, type SessionReport, scoreSession } from '@agent-workflows/eval'

export type IngestResult = {
  appended: number
  duplicates: number
  /** Lines of another session (a page built earlier): left out. */
  otherSession: number
  /** Lines of this session naming no item of it: left out. */
  unknown: number
  report: SessionReport
}

export class IngestError extends Error {}

/** A line of the page's export: an `OwnerLabel` plus the session that showed it. */
type Exported = { sessionId: string; label: OwnerLabel }

/** Every line as an exported `OwnerLabel`; one bad line refuses the whole file, naming the first ten. */
export function parseLabels(text: string): Exported[] {
  const labels: Exported[] = []
  const problems: string[] = []
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      problems.push(`line ${index + 1}: not JSON`)
      return
    }
    const { sessionId, ...rest } = (raw ?? {}) as Record<string, unknown>
    if (typeof sessionId !== 'string' || sessionId === '') {
      problems.push(`line ${index + 1}: no sessionId`)
      return
    }
    const parsed = OwnerLabel.safeParse(rest)
    if (parsed.success) labels.push({ sessionId, label: parsed.data })
    else problems.push(`line ${index + 1}: ${parsed.error.issues[0]?.message ?? 'not an owner label'}`)
  })
  if (problems.length) {
    const more = problems.length > 10 ? ` (and ${problems.length - 10} more)` : ''
    throw new IngestError(`owner labels refused: ${problems.slice(0, 10).join('; ')}${more}`)
  }
  return labels
}

function readManifest(path: string) {
  try {
    return PackManifest.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    throw new IngestError(
      `owner/manifest.json is unreadable, build the session again: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const keyOf = (l: OwnerLabel) => (l.kind === 'case' ? `case:${l.candidateId}` : `pair:${l.pairId}`)

/**
 * Appends the session's answers to `owner-labels.jsonl` and reports against the manifest. A line identical to one in
 * the file is not appended twice; an id answered again appends, and the later line wins when read. Labels naming no
 * item of the session are counted and left out, as are lines another session's page exported.
 */
export function ingestLabels(env: Record<string, string | undefined>, text: string): IngestResult {
  const manifestPath = join(dirname(gtPath('owner-labels.jsonl', env)), 'owner', 'manifest.json')
  if (!existsSync(manifestPath)) throw new IngestError('no owner session: build one first with `agw eval gt pack`')
  const manifest = readManifest(manifestPath)
  const incoming = parseLabels(text)

  const known = new Set(manifest.items.map((i) => `${i.kind}:${i.id}`))
  const labelsPath = gtPath('owner-labels.jsonl', env)
  const existing = existsSync(labelsPath) ? readCases(labelsPath, OwnerLabel) : []
  const have = new Set(existing.map((l) => JSON.stringify(l)))

  const fresh: OwnerLabel[] = []
  let unknown = 0
  let duplicates = 0
  let otherSession = 0
  for (const { sessionId, label } of incoming) {
    if (sessionId !== manifest.sessionId) otherSession++
    else if (!known.has(keyOf(label))) unknown++
    else if (have.has(JSON.stringify(label))) duplicates++
    else {
      have.add(JSON.stringify(label))
      fresh.push(label)
    }
  }
  if (fresh.length) {
    mkdirSync(dirname(labelsPath), { recursive: true, mode: 0o700 })
    appendFileSync(labelsPath, `${fresh.map((l) => JSON.stringify(l)).join('\n')}\n`, { mode: 0o600 })
    chmodSync(labelsPath, 0o600)
  }
  return {
    appended: fresh.length,
    duplicates,
    otherSession,
    unknown,
    report: scoreSession(manifest.items, [...existing, ...fresh]),
  }
}
