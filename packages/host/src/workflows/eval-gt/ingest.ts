import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gtPath, OwnerLabel, PackManifest, readCases, type SessionReport, scoreSession } from '@agent-workflows/eval'

export type IngestResult = {
  appended: number
  duplicates: number
  unknown: number
  report: SessionReport
}

export class IngestError extends Error {}

/** Every line as an `OwnerLabel`; one bad line refuses the whole file, naming the first ten. */
export function parseLabels(text: string): OwnerLabel[] {
  const labels: OwnerLabel[] = []
  const problems: string[] = []
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return
    try {
      const parsed = OwnerLabel.safeParse(JSON.parse(line))
      if (parsed.success) labels.push(parsed.data)
      else problems.push(`line ${index + 1}: ${parsed.error.issues[0]?.message ?? 'not an owner label'}`)
    } catch {
      problems.push(`line ${index + 1}: not JSON`)
    }
  })
  if (problems.length) {
    const more = problems.length > 10 ? ` (and ${problems.length - 10} more)` : ''
    throw new IngestError(`owner labels refused: ${problems.slice(0, 10).join('; ')}${more}`)
  }
  return labels
}

const keyOf = (l: OwnerLabel) => (l.kind === 'case' ? `case:${l.candidateId}` : `pair:${l.pairId}`)

/**
 * Appends the session's answers to `owner-labels.jsonl` and reports against the manifest. A line identical to one in
 * the file is not appended twice; an id answered again appends, and the later line wins when read. Labels naming no
 * item of the session are counted and left out.
 */
export function ingestLabels(env: Record<string, string | undefined>, text: string): IngestResult {
  const manifestPath = join(dirname(gtPath('owner-labels.jsonl', env)), 'owner', 'manifest.json')
  if (!existsSync(manifestPath)) throw new IngestError('no owner session: build one first with `agw eval gt pack`')
  const manifest = PackManifest.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
  const incoming = parseLabels(text)

  const known = new Set(manifest.items.map((i) => `${i.kind}:${i.id}`))
  const labelsPath = gtPath('owner-labels.jsonl', env)
  const existing = existsSync(labelsPath) ? readCases(labelsPath, OwnerLabel) : []
  const have = new Set(existing.map((l) => JSON.stringify(l)))

  const fresh: OwnerLabel[] = []
  let unknown = 0
  let duplicates = 0
  for (const label of incoming) {
    if (!known.has(keyOf(label))) unknown++
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
    unknown,
    report: scoreSession(manifest.items, [...existing, ...fresh]),
  }
}
