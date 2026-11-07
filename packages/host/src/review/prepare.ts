// `agw review prepare`: thread and round from the ledger, the route, the quota reading and the deep cap, a throwaway worktree
// at the head and the job dir the reviewer agent reads (`docs/spikes/review-v4/reviewer.md` §The job).
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { tail } from '../process.ts'
import { removeClone, removeEscapingSymlinks, sweepStaleClones } from './clone.ts'
import { jobsRoot, type QuotaReading, type ReviewContext } from './context.ts'
import { isAncestor, repoIdentity, type ResolvedScope, resolveRoot, resolveScope, threadId, tryGit } from './repo.ts'
import { routeRange, type Seat, type Tier } from './route.ts'
import type { PrepareInputValue, PrepareOutputValue } from './schema.ts'

export const MAX_ROUNDS = 3
/** A runaway guard far above a busy day (~15 deep reviews per account); the quota reading is only recorded. */
export const DEFAULT_DEEP_CAP = 60
const PRIOR_LIMIT = 20
const HISTORY_COMMITS = 15
const STALE_TREE_MS = 24 * 3_600_000
const STALE_JOB_MS = 14 * 24 * 3_600_000
const CLONE_TIMEOUT_MS = 120_000
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

export const newJobId = (): string => `rv_${[...randomBytes(20)].map((b) => BASE32[b % 32]).join('')}`

function deepCap(env: Record<string, string | undefined>): number {
  const raw = Number(env.AGW_REVIEW_DEEP_CAP)
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_DEEP_CAP
}

/** First 12 hex characters of the sha256 of the agent file `<dir>/<name>`; null when it cannot be read. */
function fingerprint(dir: string, name: string): string | null {
  try {
    return createHash('sha256')
      .update(readFileSync(join(dir, name)))
      .digest('hex')
      .slice(0, 12)
  } catch {
    return null
  }
}

/** The reviewer and verifier agent files in force at prepare, from `AGW_REVIEWER_AGENT_DIR` or `<HOME>/.claude/agents`. */
function promptFingerprints(env: Record<string, string | undefined>): {
  reviewerPrompt: string | null
  verifierPrompt: string | null
} {
  const dir = env.AGW_REVIEWER_AGENT_DIR || join(env.HOME || homedir(), '.claude', 'agents')
  return { reviewerPrompt: fingerprint(dir, 'reviewer.md'), verifierPrompt: fingerprint(dir, 'review-verifier.md') }
}

/** What the quota port said about the caller's account; recorded on the job, never a reason to hold it. */
interface QuotaRecord {
  ceiling: 'ok' | 'unknown' | 'unjudged'
  fiveHour: number | null
  sevenDay: number | null
}

async function readQuota(ctx: ReviewContext, account: string | null): Promise<QuotaRecord> {
  if (account === null) return { ceiling: 'unjudged', fiveHour: null, sevenDay: null }
  const reading: QuotaReading | null = ctx.quota ? await ctx.quota(account) : null
  const fiveHour = reading?.fiveHour ?? null
  const sevenDay = reading?.sevenDay ?? null
  return { ceiling: fiveHour === null && sevenDay === null ? 'unknown' : 'ok', fiveHour, sevenDay }
}

const utcMidnight = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

/** Best effort: job trees after 24 h, whole job dirs after 14 days, stale review clones. */
export function sweepJobs(ctx: ReviewContext): void {
  const root = jobsRoot(ctx)
  const now = ctx.now().getTime()
  try {
    sweepStaleClones(ctx.clonePorts)
  } catch {
    // next prepare
  }
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    try {
      const age = now - statSync(dir).mtimeMs
      if (age >= STALE_JOB_MS) rmSync(dir, { recursive: true, force: true })
      else if (age >= STALE_TREE_MS) rmSync(join(dir, 'tree'), { recursive: true, force: true })
    } catch {
      // another prepare's sweep won the race
    }
  }
}

/** The job's checkout: under the job dir, or the review clone of a pr/branch (under the clone root). */
export function removeWorktree(ctx: ReviewContext, jobDir: string, worktree: string): void {
  try {
    if (worktree.startsWith(`${jobDir}${sep}`)) rmSync(worktree, { recursive: true, force: true })
    else removeClone(ctx.clonePorts, worktree)
  } catch {
    // the sweep takes it
  }
}

async function makeWorktree(ctx: ReviewContext, root: string, dir: string, head: string): Promise<void> {
  const run = async (cwd: string, args: string[]) => {
    const r = await ctx.exec(['git', ...args], { cwd, timeoutMs: CLONE_TIMEOUT_MS, env: { GIT_LFS_SKIP_SMUDGE: '1' } })
    if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${tail(r.stderr) || `exit ${r.code}`}`)
  }
  await run(root, ['clone', '--quiet', '--shared', '--no-checkout', '--', root, dir])
  await run(dir, ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', head])
  removeEscapingSymlinks(dir)
}

export async function prepare(ctx: ReviewContext, input: PrepareInputValue): Promise<PrepareOutputValue> {
  const root = await resolveRoot(ctx.git, input.cwd)
  const repo = await repoIdentity(ctx.git, root)
  const jobId = newJobId()
  sweepJobs(ctx)
  const resolved = await resolveScope(ctx, root, input, `review-v4:${jobId}`)
  mkdirSync(jobsRoot(ctx), { recursive: true })
  const jobDir = join(realpathSync(jobsRoot(ctx)), jobId)
  let ready = false
  try {
    const out = await prepareResolved(ctx, input, { root, repo, jobId, jobDir, resolved })
    ready = out.status === 'ready'
    return out
  } finally {
    if (!ready) {
      rmSync(jobDir, { recursive: true, force: true })
      if (resolved.clone) removeWorktree(ctx, jobDir, resolved.clone)
    }
  }
}

const THREAD_ID = /^[0-9a-f]{12}$/

/** `--thread` is a key, or the 12-hex id of a thread this repo already holds (what `status` prints): used as is. */
async function resolveThread(
  ledger: ReviewContext['ledger'],
  repo: string,
  given: string | undefined,
  defaultKey: string,
): Promise<{ thread: string; threadKey: unknown }> {
  const known = given && THREAD_ID.test(given) ? await ledger.threadJob(repo, given) : null
  if (known) return { thread: known.thread, threadKey: known.scope.threadKey }
  const key = given ?? defaultKey
  return { thread: threadId(repo, key), threadKey: key }
}

/** The quota reading (recorded) and the deep cap, the only hold: `reason` when the job is held. */
async function checkLimits(
  ctx: ReviewContext,
  at: { account: string | null; tier: Tier; thread: string },
): Promise<{ quota: QuotaRecord; reason?: string }> {
  const quota = await readQuota(ctx, at.account)
  if (at.tier !== 'deep') return { quota }
  const cap = deepCap(ctx.env)
  const today = await ctx.ledger.deepCount(at.account, utcMidnight(ctx.now()), at.thread)
  if (today < cap) return { quota }
  return {
    quota,
    reason: `held: ${at.account ?? 'no account'} at the deep cap, ${today}/${cap} deep reviews today (UTC)`,
  }
}

const scopeOf = (input: PrepareInputValue) =>
  input.pr !== undefined
    ? { pr: input.pr }
    : input.branch !== undefined
      ? { branch: input.branch }
      : { scope: input.scope ?? 'uncommitted' }

/** The files of the job dir the reviewer reads (diff, stat, intent, history, prior findings, REVIEW.md, job.json). */
async function writeJobDir(
  ctx: ReviewContext,
  job: {
    input: PrepareInputValue
    at: { repo: string; jobId: string; jobDir: string; resolved: ResolvedScope }
    thread: string
    round: number
    diffBase: string
    worktree: string
    files: string[]
    reviewMd: string | null
    route: { tier: Tier; seat: Seat | null }
  },
): Promise<void> {
  const { git, ledger } = ctx
  const { input, thread, files, worktree, diffBase } = job
  const { repo, jobId, jobDir, resolved } = job.at
  const { gitDir, base, head } = resolved
  const range = `${diffBase}..${head}`
  const paths = {
    diff: join(jobDir, 'diff.patch'),
    stat: join(jobDir, 'stat.txt'),
    intent: join(jobDir, 'intent.md'),
    history: join(jobDir, 'history.txt'),
    prior: join(jobDir, 'prior.json'),
    reviewMd: join(jobDir, 'REVIEW.md'),
    agentsMd: join(worktree, 'AGENTS.md'),
  }
  writeFileSync(paths.diff, await git(gitDir, ['-c', 'core.quotePath=false', 'diff', '-M', range]))
  writeFileSync(paths.stat, await git(gitDir, ['diff', '--numstat', '--no-renames', range]))
  const commits = resolved.snapshot
    ? ''
    : (await git(gitDir, ['log', '--format=### %s%n%n%b', `${base}..${head}`])).trim()
  const intent = [
    input.context?.trim() || '(no context given)',
    '',
    resolved.label,
    ...(commits ? ['', '## Commits', '', commits] : []),
  ].join('\n')
  writeFileSync(paths.intent, `${intent}\n`)
  const history =
    files.length === 0
      ? ''
      : await git(gitDir, [
          'log',
          '-n',
          String(HISTORY_COMMITS),
          '--format=--- %h %ad%n%s%n%n%b',
          '--date=short',
          base,
          '--',
          ...files,
        ])
  writeFileSync(paths.history, history)
  const prior = (await ledger.findingsOn(repo, files, PRIOR_LIMIT)).map((f) => ({
    id: f.id,
    thread: f.thread,
    sameThread: f.thread === thread,
    round: f.round,
    tag: f.tag,
    class: f.class,
    file: f.file,
    line: f.line,
    message: f.message,
    state: f.disposition,
    reason: f.reason,
  }))
  writeFileSync(paths.prior, `${JSON.stringify(prior, null, 1)}\n`)
  writeFileSync(paths.reviewMd, job.reviewMd ?? 'This repository has no REVIEW.md at the base of the change.\n')
  const { tier, seat } = job.route
  writeFileSync(
    join(jobDir, 'job.json'),
    `${JSON.stringify({ jobId, repo, thread, round: job.round, tier, seat, base, diffBase, head, worktree, files: paths }, null, 1)}\n`,
  )
}

async function prepareResolved(
  ctx: ReviewContext,
  input: PrepareInputValue,
  at: { root: string; repo: string; jobId: string; jobDir: string; resolved: ResolvedScope },
): Promise<PrepareOutputValue> {
  const { git, ledger } = ctx
  const { root, repo, jobId, jobDir, resolved } = at
  const { gitDir, base, head } = resolved
  const { thread, threadKey } = await resolveThread(ledger, repo, input.thread, resolved.key)
  const account = input.account ?? null
  const last = await ledger.lastSubmitted(repo, thread)
  const round = last ? last.round + 1 : 1
  const common = { thread, round, base, head, account }
  if (round > MAX_ROUNDS) {
    return {
      status: 'needs-human',
      reason: `${MAX_ROUNDS} rounds on thread ${thread}: step back and reconsider the approach`,
      ...common,
    }
  }

  const followsLast =
    last !== null &&
    (last.base === base || (await isAncestor(git, gitDir, last.head, head))) &&
    (await tryGit(git, gitDir, ['cat-file', '-e', `${last.head}^{commit}`])) !== null
  const diffBase = followsLast && last ? last.head : base
  const threadDeep = followsLast && (await ledger.threadTiers(repo, [thread])).some((t) => t.tier === 'deep')
  const decision = await routeRange({
    git,
    repo: gitDir,
    base: diffBase,
    head,
    min: input.min,
    configAt: base,
    threadDeep,
  })
  const { config, changes, warning: _warning, ...route } = decision
  const decided = { tier: route.tier, seat: route.seat, rule: route.rule, decidedBy: route.decidedBy, diffBase }
  if (route.tier === 'none') return { status: 'skipped', ...common, ...decided }

  const limits = await checkLimits(ctx, { account, tier: route.tier, thread })
  const { quota } = limits
  if (limits.reason) return { status: 'held', reason: limits.reason, ...common, ...decided, ceiling: quota.ceiling }

  const files = changes.map((c) => c.path)
  const reviewMd = await tryGit(git, gitDir, ['show', `${base}:REVIEW.md`])
  mkdirSync(jobDir, { recursive: true })
  const worktree = resolved.clone ?? join(jobDir, 'tree')
  if (!resolved.clone) await makeWorktree(ctx, root, worktree, head)
  const headTree = (await git(gitDir, ['rev-parse', `${head}^{tree}`])).trim()

  await writeJobDir(ctx, {
    input,
    at,
    thread,
    round,
    diffBase,
    worktree,
    files,
    reviewMd,
    route: { tier: route.tier, seat: route.seat },
  })

  await ledger.insertJob({
    // The app clock stamps both ends of a job's wall time (`submitted_at` comes from `ctx.now()` too); Postgres'
    // `now()` differs from it by milliseconds and would give a fast job a negative wall time.
    createdAt: ctx.now(),
    id: jobId,
    repo,
    root,
    thread,
    round,
    scope: {
      ...scopeOf(input),
      ...(input.thread ? { thread: input.thread } : {}),
      ...(typeof threadKey === 'string' ? { threadKey } : {}),
    },
    base,
    diffBase,
    head,
    headTree,
    tier: route.tier,
    seat: route.seat,
    rule: route.rule,
    decidedBy: route.decidedBy,
    route: { ...route, changes },
    account,
    transport: 'in-session',
    intent: input.context ?? '',
    reviewConfig: config,
    files,
    jobDir,
    worktree,
    ceiling: quota.ceiling,
    quotaFiveHour: quota.fiveHour,
    quotaSevenDay: quota.sevenDay,
    ...promptFingerprints(ctx.env),
  })
  return {
    status: 'ready',
    jobId,
    ...common,
    ...decided,
    jobDir,
    worktree,
    files,
    ceiling: quota.ceiling,
    prompt: `job=${jobDir} worktree=${worktree} tier=${route.tier} round=${round}`,
  }
}
