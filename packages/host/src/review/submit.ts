// `agw review submit`: the reviewer's JSON reply in, REVIEW_OUTPUT v4 out. Code decides outcome, summary, ids and caps;
// the reply only proposes findings.
import { z } from 'zod'
import { type Anchoring, anchorFindings, anchorKey } from './anchor.ts'
import type { ReviewContext } from './context.ts'
import type { Finding, Job, NewFinding } from './ledger.ts'
import { MAX_ROUNDS, removeWorktree } from './prepare.ts'
import type { FileChange } from './route.ts'
import {
  type OutputFindingValue,
  type ReplyFindingValue,
  REVIEW_OUTPUT_VERSION,
  ReviewError,
  type ReviewerReplyValue,
  ReviewerReply,
  type ReviewOutputV4Value,
} from './schema.ts'

const DEFAULT_STEP_BACK =
  'Three rounds have not converged on this change. Step back and ask whether the approach itself is right before another fix.'

/** The one JSON object in the reply, fenced or wrapped in prose: from its first `{` to its last `}`. */
function parseReply(text: string): ReviewerReplyValue {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new ReviewError('the reply holds no JSON object')
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch (error) {
    throw new ReviewError(`the reply is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = ReviewerReply.safeParse(raw)
  if (!parsed.success)
    throw new ReviewError(`the reply does not match the reviewer schema: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

/** Lowercase, punctuation stripped, whitespace collapsed: two wordings of one message that differ only in those match. */
const normalizeMessage = (message: string): string =>
  message
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()

const repeatKey = (f: { file: string; class: string; message: string }) =>
  `${f.file}\0${f.class}\0${normalizeMessage(f.message)}`

function summarize(findings: { tag: string }[]): string {
  const count = (tag: string) => findings.filter((f) => f.tag === tag).length
  const important = count('important')
  const nits = count('nit')
  const pre = count('pre-existing')
  const parts = [
    ...(important ? [`${important} important`] : []),
    ...(nits ? [`${nits} ${nits === 1 ? 'nit' : 'nits'}`] : []),
    ...(pre ? [`${pre} pre-existing`] : []),
  ]
  return parts.length === 0 ? 'Nothing needs fixing.' : `${parts.join(', ')}.`
}

/**
 * A binary file has no diff lines to read, and a deleted file holds only removed lines (prepare lists those in
 * `deleted.txt`, not `stat.txt`): the reply may list either or leave it out, and a left-out one is never `unreviewed`.
 */
function optionalPaths(route: Job['route']): Set<string> {
  const changes = Array.isArray(route.changes) ? (route.changes as Partial<FileChange>[]) : []
  return new Set(changes.flatMap((c) => ((c.binary || c.deleted) && c.path ? [c.path] : [])))
}

const MAX_NAMED = 20
/** A refusal names the first paths only: a 977-file diff must not echo every path back into the caller's context. */
const named = (paths: string[]): string =>
  paths.length <= MAX_NAMED
    ? paths.join(', ')
    : `${paths.slice(0, MAX_NAMED).join(', ')} (+${paths.length - MAX_NAMED} more)`

/**
 * The reply's files against stat.txt. A path the reply echoes that stat.txt does not hold is an error (the reviewer read
 * another change); stat paths the reply leaves out are `unreviewed` and recorded, never an error, unless it echoes none
 * of the text files (a reply that read nothing is no review).
 */
function checkFiles(
  expected: string[],
  echoed: string[],
  optional: Set<string>,
): { problem: string } | { unreviewed: string[] } {
  const want = new Set(expected)
  const got = new Set(echoed)
  const extra = [...got].filter((p) => !want.has(p))
  const required = expected.filter((p) => !optional.has(p))
  const missing = required.filter((p) => !got.has(p))
  if (extra.length > 0) {
    return { problem: `the reply files are not all in stat.txt; re-ask the reviewer; extra: ${named(extra)}` }
  }
  if (required.length > 0 && missing.length === required.length) {
    return {
      problem: `the reply echoes none of the files in stat.txt; re-ask the reviewer; missing: ${named(missing)}`,
    }
  }
  return { unreviewed: missing }
}

function refuseState(job: Job, attempt: number): ReviewOutputV4Value | null {
  if (job.state === 'abandoned')
    throw new ReviewError(`job ${job.id} was abandoned (a later prepare restarted its round)`)
  if (job.state !== 'submitted') return null
  if (job.attempt === attempt && job.output) return job.output
  throw new ReviewError(`job ${job.id} is already submitted by attempt ${job.attempt}`)
}

export async function submit(
  ctx: ReviewContext,
  input: { jobId: string; attempt: number; reply: string; account?: string },
): Promise<ReviewOutputV4Value> {
  const { ledger } = ctx
  const known = await ledger.job(input.jobId)
  if (!known) throw new ReviewError(`unknown job ${input.jobId}`)
  const stored = refuseState(known, input.attempt)
  if (stored) return stored
  const reply = parseReply(input.reply)
  const checked = checkFiles(known.files, reply.files, optionalPaths(known.route))
  if ('problem' in checked) throw new ReviewError(checked.problem)

  const anchoring = await anchorFindings({ worktree: known.worktree, jobDir: known.jobDir, findings: reply.findings })
  const result = await ledger.transaction(async (client) => {
    await ledger.lockThread(client, known.thread)
    const job = await ledger.job(input.jobId, client, true)
    if (!job) throw new ReviewError(`unknown job ${input.jobId}`)
    const again = refuseState(job, input.attempt)
    if (again) return { output: again, fresh: false }
    const existing = await ledger.threadFindings(job.repo, job.thread, client)
    const account = job.account ?? input.account ?? null
    const priorFixRounds = await ledger.fixLoopRounds(job.repo, job.thread, client)
    const output = assemble({ ...job, account }, reply, existing, anchoring, priorFixRounds, checked.unreviewed)
    for (const f of output.newFindings) await ledger.insertFinding(client, f)
    for (const t of output.touched) await ledger.touchFinding(client, t.id, job.id, t.reopen)
    await ledger.markSubmitted(client, job.id, input.attempt, output.output, ctx.now(), account)
    return { output: output.output, fresh: true }
  })
  if (result.fresh) removeWorktree(ctx, known.jobDir, known.worktree)
  return result.output
}

const unreviewedNote = (unreviewed: string[]): string =>
  unreviewed.length === 0
    ? ''
    : ` ${unreviewed.length} ${unreviewed.length === 1 ? 'file' : 'files'} unreviewed (the next prepare on the thread reads ${unreviewed.length === 1 ? 'it' : 'them'}).`

/** The highest `<thread>-<n>` number the thread holds. */
const highestIndex = (existing: Finding[]): number =>
  existing.reduce((n, f) => {
    const m = /-(\d+)$/.exec(f.id)
    return m ? Math.max(n, Number(m[1])) : n
  }, 0)

/** `repeat`: already held or answered; `settled`: a repeat of a finding the owner closed (it is matched too). */
function repeatVerdict(input: {
  prior: Finding | undefined
  key: string
  matched: Set<string>
  seen: Set<string>
}): 'keep' | 'repeat' | 'settled' {
  const { prior } = input
  if (!prior) return input.seen.has(input.key) ? 'repeat' : 'keep'
  if (input.matched.has(prior.id)) return 'repeat'
  return prior.disposition !== 'open' && prior.disposition !== 'fixed' ? 'settled' : 'keep'
}

/** Only a known value goes into the output. */
function anchorFields(anchor: Anchoring | undefined): Pick<OutputFindingValue, 'lineValid' | 'anchored'> {
  return {
    ...(anchor?.lineValid != null ? { lineValid: anchor.lineValid } : {}),
    ...(anchor?.anchored != null ? { anchored: anchor.anchored } : {}),
  }
}

function outputFinding(input: {
  id: string
  f: ReplyFindingValue
  stillOpen: boolean
  anchor: Anchoring | undefined
}): OutputFindingValue {
  const { f, anchor } = input
  return {
    id: input.id,
    tag: f.tag,
    class: f.class,
    file: f.file,
    line: f.line,
    ...(f.existing ? { existing: f.existing } : {}),
    message: f.message,
    failureScenario: f.failureScenario,
    ...(f.fix ? { fix: f.fix } : {}),
    ...(f.otherInstances?.length ? { otherInstances: f.otherInstances } : {}),
    ...(f.votes ? { votes: f.votes } : {}),
    ...(input.stillOpen ? { stillOpen: true as const } : {}),
    ...anchorFields(anchor),
  }
}

function newFinding(job: Job, f: OutputFindingValue): NewFinding {
  return {
    id: f.id,
    repo: job.repo,
    thread: job.thread,
    jobId: job.id,
    lastJobId: job.id,
    round: job.round,
    tag: f.tag,
    class: f.class,
    file: f.file,
    line: f.line,
    existing: f.existing ?? null,
    message: f.message,
    failureScenario: f.failureScenario,
    fix: f.fix ?? null,
    otherInstances: f.otherInstances ?? [],
    votes: f.votes ?? null,
    lineValid: f.lineValid ?? null,
    anchored: f.anchored ?? null,
  }
}

function reviewOutput(input: {
  job: Job
  reply: ReviewerReplyValue
  kept: OutputFindingValue[]
  dropped: { repeats: number; nits: number }
  /** Submitted rounds in the thread's fix loop before this one. */
  priorFixRounds: number
  unreviewed: string[]
}): ReviewOutputV4Value {
  const { job, reply, kept, unreviewed } = input
  const important = kept.some((f) => f.tag === 'important')
  const stuck = important && input.priorFixRounds + 1 >= MAX_ROUNDS
  return {
    schemaVersion: REVIEW_OUTPUT_VERSION,
    jobId: job.id,
    thread: job.thread,
    round: job.round,
    tier: job.tier,
    seat: job.seat,
    rule: job.rule,
    account: job.account,
    intent: reply.intent,
    outcome: !important ? 'clean' : stuck ? 'needs-human' : 'actionable',
    summary: summarize(kept) + unreviewedNote(unreviewed),
    findings: kept,
    checked: reply.checked,
    ...(reply.criteria?.length ? { criteria: reply.criteria } : {}),
    stepBack: reply.stepBack?.trim() || (stuck ? DEFAULT_STEP_BACK : null),
    files: job.files,
    ...(unreviewed.length ? { unreviewed } : {}),
    dropped: input.dropped,
    base: job.base,
    diffBase: job.diffBase,
    head: job.head,
  }
}

function assemble(
  job: Job,
  reply: ReviewerReplyValue,
  existing: Finding[],
  anchoring: Map<string, Anchoring>,
  priorFixRounds: number,
  unreviewed: string[],
) {
  const byId = new Map(existing.map((f) => [f.id, f]))
  const byKey = new Map<string, Finding>()
  for (const f of existing) if (!byKey.has(repeatKey(f))) byKey.set(repeatKey(f), f)
  const seen = new Set<string>()
  let next = highestIndex(existing)
  const dropped = { repeats: 0, nits: 0 }
  const kept: OutputFindingValue[] = []
  const touched: { id: string; reopen: boolean }[] = []
  const matched = new Set<string>()
  const fresh: OutputFindingValue[] = []

  for (const f of reply.findings) {
    const key = repeatKey(f)
    const prior = (f.stillOpen && f.id ? byId.get(f.id) : undefined) ?? byKey.get(key)
    const verdict = repeatVerdict({ prior, key, matched, seen })
    if (verdict !== 'keep') {
      if (verdict === 'settled' && prior) matched.add(prior.id)
      dropped.repeats++
      continue
    }
    if (f.tag === 'nit' && kept.filter((k) => k.tag === 'nit').length >= job.reviewConfig.nits) {
      dropped.nits++
      continue
    }
    const out = outputFinding({
      id: prior ? prior.id : `${job.thread}-${++next}`,
      f,
      stillOpen: prior !== undefined,
      anchor: anchoring.get(anchorKey(f)),
    })
    kept.push(out)
    if (!prior) {
      fresh.push(out)
      seen.add(key)
      continue
    }
    matched.add(prior.id)
    touched.push({ id: prior.id, reopen: prior.disposition === 'fixed' })
  }

  return {
    output: reviewOutput({ job, reply, kept, dropped, priorFixRounds, unreviewed }),
    newFindings: fresh.map((f) => newFinding(job, f)),
    touched,
  }
}
