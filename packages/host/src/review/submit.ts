// `agw review submit`: the reviewer's JSON reply in, REVIEW_OUTPUT v4 out. Code decides outcome, summary, ids and caps;
// the reply only proposes findings.
import { z } from 'zod'
import type { ReviewContext } from './context.ts'
import type { Finding, Job } from './ledger.ts'
import { removeWorktree } from './prepare.ts'
import {
  type OutputFindingValue,
  REVIEW_OUTPUT_VERSION,
  ReviewError,
  type ReviewerReplyValue,
  ReviewerReply,
  type ReviewOutputV4Value,
} from './schema.ts'

export const DEFAULT_STEP_BACK =
  'Three rounds have not converged on this change. Step back and ask whether the approach itself is right before another fix.'

/** The one JSON object in the reply, fenced or wrapped in prose: from its first `{` to its last `}`. */
export function parseReply(text: string): ReviewerReplyValue {
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
export const normalizeMessage = (message: string): string =>
  message
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()

const repeatKey = (f: { file: string; class: string; message: string }) =>
  `${f.file}\0${f.class}\0${normalizeMessage(f.message)}`

export function summarize(findings: { tag: string }[]): string {
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

function filesProblem(expected: string[], echoed: string[]): string | null {
  const want = new Set(expected)
  const got = new Set(echoed)
  const missing = [...want].filter((p) => !got.has(p))
  const extra = [...got].filter((p) => !want.has(p))
  if (missing.length === 0 && extra.length === 0) return null
  return [
    'the reply files do not match stat.txt; re-ask the reviewer for every file',
    ...(missing.length ? [`missing: ${missing.join(', ')}`] : []),
    ...(extra.length ? [`extra: ${extra.join(', ')}`] : []),
  ].join('; ')
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
  input: { jobId: string; attempt: number; reply: string },
): Promise<ReviewOutputV4Value> {
  const { ledger } = ctx
  const known = await ledger.job(input.jobId)
  if (!known) throw new ReviewError(`unknown job ${input.jobId}`)
  const stored = refuseState(known, input.attempt)
  if (stored) return stored
  const reply = parseReply(input.reply)
  const problem = filesProblem(known.files, reply.files)
  if (problem) throw new ReviewError(problem)

  const result = await ledger.transaction(async (client) => {
    await ledger.lockThread(client, known.thread)
    const job = await ledger.job(input.jobId, client, true)
    if (!job) throw new ReviewError(`unknown job ${input.jobId}`)
    const again = refuseState(job, input.attempt)
    if (again) return { output: again, fresh: false }
    const existing = await ledger.threadFindings(job.repo, job.thread, client)
    const output = assemble(job, reply, existing)
    for (const f of output.newFindings) await ledger.insertFinding(client, f)
    for (const id of output.stillOpen) await ledger.touchFinding(client, id, job.id)
    await ledger.markSubmitted(client, job.id, input.attempt, output.output, ctx.now())
    return { output: output.output, fresh: true }
  })
  if (result.fresh) removeWorktree(ctx, known.jobDir, known.worktree)
  return result.output
}

function assemble(job: Job, reply: ReviewerReplyValue, existing: Finding[]) {
  const byId = new Map(existing.map((f) => [f.id, f]))
  const seen = new Set(existing.map(repeatKey))
  let next = existing.reduce((n, f) => {
    const m = /-(\d+)$/.exec(f.id)
    return m ? Math.max(n, Number(m[1])) : n
  }, 0)
  let repeats = 0
  let nits = 0
  const cap = job.reviewConfig.nits
  const kept: OutputFindingValue[] = []
  const stillOpen: string[] = []
  const fresh: OutputFindingValue[] = []

  for (const f of reply.findings) {
    const prior = f.stillOpen && f.id && !stillOpen.includes(f.id) ? byId.get(f.id) : undefined
    if (!prior && seen.has(repeatKey(f))) {
      repeats++
      continue
    }
    if (f.tag === 'nit' && kept.filter((k) => k.tag === 'nit').length >= cap) {
      nits++
      continue
    }
    const out: OutputFindingValue = {
      id: prior ? prior.id : `${job.thread}-${++next}`,
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
      ...(prior ? { stillOpen: true as const } : {}),
    }
    kept.push(out)
    if (prior) stillOpen.push(prior.id)
    else {
      fresh.push(out)
      seen.add(repeatKey(f))
    }
  }

  const important = kept.some((f) => f.tag === 'important')
  const outcome = !important ? 'clean' : job.round >= 3 ? 'needs-human' : 'actionable'
  const stepBack = reply.stepBack?.trim() || (job.round >= 3 && important ? DEFAULT_STEP_BACK : null)
  const output: ReviewOutputV4Value = {
    schemaVersion: REVIEW_OUTPUT_VERSION,
    jobId: job.id,
    thread: job.thread,
    round: job.round,
    tier: job.tier,
    seat: job.seat,
    rule: job.rule,
    account: job.account,
    intent: reply.intent,
    outcome,
    summary: summarize(kept),
    findings: kept,
    checked: reply.checked,
    stepBack,
    files: job.files,
    dropped: { repeats, nits },
    base: job.base,
    diffBase: job.diffBase,
    head: job.head,
  }
  const newFindings = fresh.map((f) => ({
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
  }))
  return { output, newFindings, stillOpen }
}
