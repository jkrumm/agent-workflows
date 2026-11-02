import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type CaseItem,
  type Exec,
  evalDir,
  GT_DIR,
  GtBugCase,
  GtCandidate,
  GtCase,
  GtLabelRecord,
  type GtLocation,
  GtRejected,
  JudgeInput,
  JudgeOutput,
  type ManifestItem,
  type PackManifest,
  type PageItem,
  type PairItem,
  readCases,
  renderSession,
  sampleOf,
  samplePairs,
  shuffled,
} from '@agent-workflows/eval'
import type { z } from 'zod'
import { gitReader } from './code.ts'
import type { JudgeRunReader } from './judge-runs.ts'

export interface PackDeps {
  env: Record<string, string | undefined>
  exec: Exec
  /** Where `GtRepo` paths (`SourceRoot/<name>`) resolve. */
  home: string
  judgeRuns: JudgeRunReader
  now?: () => Date
}

export interface PackRequest {
  evalRuns: string[]
  cases: number
  rejected: number
  pairs: number
  seed: number
}

const CASE_RADIUS = 15
const PAIR_RADIUS = 10

const sessionDir = (env: PackDeps['env']) => join(evalDir(env), GT_DIR, 'owner')

/** The caller's input is wrong (a ground-truth file missing, malformed or empty): not an outage, not worth a retry. */
export class PackInputError extends Error {}

function readFile<T extends z.ZodType>(env: PackDeps['env'], file: string, schema: T): z.infer<T>[] {
  const path = join(evalDir(env), GT_DIR, file)
  if (!existsSync(path)) return []
  try {
    return readCases(path, schema)
  } catch (error) {
    throw new PackInputError(`${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const lineRange = (start: number, end: number) => (start === end ? `${start}` : `${start}-${end}`)

/** A candidate's claim: seat `a`'s when it found a defect, else seat `b`'s, else none (the blamed lines are the only lead). */
function claimOf(record: z.infer<typeof GtLabelRecord> | undefined) {
  for (const [name, seat] of [
    ['a', record?.a],
    ['b', record?.b],
  ] as const) {
    if (seat && 'defect' in seat && seat.defect && seat.location) {
      return { seat: name, location: seat.location, description: seat.description }
    }
  }
  return null
}

async function caseItems(deps: PackDeps, request: PackRequest, notes: string[]) {
  const cases = readFile(deps.env, 'cases.jsonl', GtCase).filter((c): c is GtBugCase => c.kind === 'bug')
  const rejected = readFile(deps.env, 'rejected.jsonl', GtRejected)
  const candidates = new Map(readFile(deps.env, 'candidates.jsonl', GtCandidate).map((c) => [c.id, c]))
  // The latest record of a candidate wins, as the miner resumes from the file's end.
  const records = new Map(readFile(deps.env, 'labels.jsonl', GtLabelRecord).map((r) => [r.candidateId, r]))

  const pickedCases = sampleOf(cases, request.cases, request.seed)
  const pickedRejected = sampleOf(rejected, request.rejected, request.seed + 2)
  if (pickedCases.length < request.cases) {
    const text = `${pickedCases.length} of ${request.cases} requested mined bug cases exist; all are shown`
    notes.push(`cases: ${text}`)
  }
  if (pickedRejected.length < request.rejected) {
    const text = `${pickedRejected.length} of ${request.rejected} requested dropped candidates exist; all are shown`
    notes.push(`rejected: ${text}`)
  }

  const items: { page: CaseItem; manifest: ManifestItem }[] = []
  for (const c of pickedCases) {
    const git = gitReader(deps.exec, join(deps.home, c.repo))
    const { location, description } = c.bug
    items.push({
      manifest: { kind: 'case', id: c.candidateId, truth: 'accepted', claimedBy: 'a' },
      page: {
        kind: 'case',
        id: c.candidateId,
        repo: c.repo,
        introSubject: c.subject,
        where: `${location.file}:${lineRange(location.startLine, location.endLine)}`,
        claim: description,
        fixSubject: c.bug.fixSubject,
        code: await git.postImage({
          sha: c.sha,
          file: location.file,
          start: location.startLine,
          end: location.endLine,
          radius: CASE_RADIUS,
        }),
        fixDiff: await git.fixDiff(c.bug.fixSha, location.file),
      },
    })
  }
  for (const r of pickedRejected) {
    const candidate = candidates.get(r.candidateId)
    if (!candidate) {
      notes.push(`rejected ${r.candidateId}: no candidate record, skipped`)
      continue
    }
    const git = gitReader(deps.exec, join(deps.home, candidate.repo))
    const claim = claimOf(records.get(r.candidateId))
    const blamed = candidate.blamed[0]
    const place =
      claim?.location ?? (blamed ? { file: blamed.file, startLine: blamed.line, endLine: blamed.line } : null)
    if (!place) continue
    const lines = claim ? null : candidate.blamed.filter((b) => b.file === place.file).map((b) => b.line)
    const start = lines ? Math.min(...lines) : place.startLine
    const end = lines ? Math.max(...lines) : place.endLine
    items.push({
      manifest: {
        kind: 'case',
        id: r.candidateId,
        truth: 'rejected',
        reason: r.reason,
        claimedBy: claim?.seat ?? 'none',
      },
      page: {
        kind: 'case',
        id: r.candidateId,
        repo: candidate.repo,
        introSubject: candidate.introSubject,
        where: `${place.file}:${lineRange(start, end)}`,
        // One form for every item: the page never says whether anyone claimed a defect (the manifest does).
        claim: claim ? claim.description : `Claim: the lines the fix changed (${place.file}:${lineRange(start, end)})`,
        fixSubject: candidate.fixSubject,
        code: await git.postImage({ sha: candidate.introSha, file: place.file, start, end, radius: CASE_RADIUS }),
        fixDiff: await git.fixDiff(candidate.fixSha, place.file),
      },
    })
  }
  return items
}

async function pairItems(deps: PackDeps, request: PackRequest, notes: string[]) {
  const cases = new Map(
    readFile(deps.env, 'cases.jsonl', GtCase).flatMap((c) => (c.kind === 'bug' ? [[c.id, c] as const] : [])),
  )
  type Pair = { item: PairItem; manifest: ManifestItem; caseSha: string; repo: string; location: GtLocation }
  const positives: Pair[] = []
  const negatives: Pair[] = []
  let unusable = 0
  let unknownCase = 0
  for (const run of await deps.judgeRuns.judgeRuns(request.evalRuns)) {
    const input = JudgeInput.safeParse(run.input)
    const output = JudgeOutput.safeParse(run.output)
    if (!input.success || !output.success || !input.data.bug) {
      unusable++
      continue
    }
    const known = cases.get(input.data.caseId)
    if (!known) {
      unknownCase++
      continue
    }
    const { bug, findings, preselected } = input.data
    const classes = new Map(output.data.findings.map((f) => [f.id, f.class]))
    for (const finding of findings) {
      const judgeClass = classes.get(finding.id)
      if (!judgeClass) continue
      const isMatch = judgeClass === 'match'
      // Only preselected non-matches: right file, plausible, wrong defect (the hard negatives the calibration needs).
      if (!isMatch && !preselected.includes(finding.id)) continue
      const id = `${known.id}:${run.runId}:${finding.id}`
      const pair: Pair = {
        caseSha: known.sha,
        repo: known.repo,
        location: bug.location,
        manifest: { kind: 'pair', id, caseId: known.id, judgeRunId: run.runId, findingId: finding.id, judgeClass },
        item: {
          kind: 'pair',
          id,
          bug: {
            where: `${bug.location.file}:${lineRange(bug.location.startLine, bug.location.endLine)}`,
            description: bug.description,
            code: '',
          },
          finding: {
            tag: finding.tag,
            where: finding.line
              ? `${finding.file}:${lineRange(finding.line, finding.endLine ?? finding.line)}`
              : finding.file,
            message: finding.message,
          },
        },
      }
      ;(isMatch ? positives : negatives).push(pair)
    }
  }
  if (unusable) notes.push(`${unusable} judge runs skipped: no known bug, or input/output not a judge call`)
  if (unknownCase) notes.push(`${unknownCase} judge runs skipped: their case is not in cases.jsonl`)

  const sample = samplePairs({ positives, negatives, total: request.pairs, seed: request.seed + 3 })
  if (sample.shortfall.positives > 0) {
    const text = `${positives.length} judge-positive pairs exist for a quota of ${Math.floor(request.pairs / 2)}; all are shown and judge-negative pairs fill the rest`
    notes.push(`pairs: ${text}`)
  }
  if (sample.shortfall.negatives > 0) {
    const text = `only ${sample.positives.length + sample.negatives.length} of ${request.pairs} requested pairs exist`
    notes.push(`pairs: ${text}`)
  }

  const out: { page: PageItem; manifest: ManifestItem }[] = []
  for (const pair of [...sample.positives, ...sample.negatives]) {
    const git = gitReader(deps.exec, join(deps.home, pair.repo))
    const { file, startLine, endLine } = pair.location
    pair.item.bug.code = await git.postImage({
      sha: pair.caseSha,
      file,
      start: startLine,
      end: endLine,
      radius: PAIR_RADIUS,
    })
    out.push({ page: pair.item, manifest: pair.manifest })
  }
  return out
}

/** Totals only: the page may say it holds fewer items than asked, never which kind of item is missing. */
function pageNotesOf(request: PackRequest, commitItems: number, findingItems: number): string[] {
  const out: string[] = []
  const commits = request.cases + request.rejected
  if (commitItems < commits) out.push(`Commit items: ${commitItems} of ${commits} requested exist; all are shown.`)
  if (findingItems < request.pairs)
    out.push(`Finding items: ${findingItems} of ${request.pairs} requested exist; all are shown.`)
  return out
}

export interface PackResult {
  sessionId: string
  dir: string
  html: string
  manifest: string
  counts: {
    cases: number
    rejected: number
    pairs: number
    pairsJudgePositive: number
    pairsJudgeNegative: number
    total: number
  }
  notes: string[]
}

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  chmodSync(dirname(path), 0o700)
  writeFileSync(path, content, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** Builds the owner session (`session.html` and `manifest.json` under `review-gt/owner/`); no model call, no spend. */
export async function buildPack(deps: PackDeps, request: PackRequest): Promise<PackResult> {
  const notes: string[] = []
  const cases = await caseItems(deps, request, notes)
  const pairs = await pairItems(deps, request, notes)
  const all = [...cases, ...pairs]
  if (all.length === 0)
    throw new PackInputError(
      `nothing to show: no cases, rejected candidates or judge pairs${notes.length ? ` (${notes.join('; ')})` : ''}`,
    )

  const ordered = shuffled(all, request.seed + 4)
  const sessionId = createHash('sha256')
    .update(ordered.map((i) => `${i.manifest.kind}:${i.manifest.id}`).join('\n'))
    .digest('hex')
    .slice(0, 16)
  const manifest: PackManifest = {
    sessionId,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    seed: request.seed,
    evalRuns: request.evalRuns,
    notes,
    items: ordered.map((i) => i.manifest),
  }
  const dir = sessionDir(deps.env)
  const html = renderSession({
    sessionId,
    items: ordered.map((i) => i.page),
    notes: pageNotesOf(request, cases.length, pairs.length),
  })
  write(join(dir, 'session.html'), html)
  write(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const judge = (c: string) =>
    pairs.filter((p) => p.manifest.kind === 'pair' && (p.manifest.judgeClass === 'match') === (c === 'positive')).length
  return {
    sessionId,
    dir,
    html: join(dir, 'session.html'),
    manifest: join(dir, 'manifest.json'),
    counts: {
      cases: cases.filter((c) => c.manifest.kind === 'case' && c.manifest.truth === 'accepted').length,
      rejected: cases.filter((c) => c.manifest.kind === 'case' && c.manifest.truth === 'rejected').length,
      pairs: pairs.length,
      pairsJudgePositive: judge('positive'),
      pairsJudgeNegative: judge('negative'),
      total: all.length,
    },
    notes,
  }
}
