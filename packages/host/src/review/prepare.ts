// `agw review prepare`: thread and round from the ledger, the route, the ceiling and the deep cap, a throwaway worktree
// at the head and the job dir the reviewer agent reads (`docs/spikes/review-v4/reviewer.md` §The job).
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tail } from '../process.ts'
import { removeClone, removeEscapingSymlinks, sweepStaleClones } from './clone.ts'
import { jobsRoot, type QuotaReading, type ReviewContext } from './context.ts'
import { isAncestor, repoIdentity, type ResolvedScope, resolveRoot, resolveScope, threadId, tryGit } from './repo.ts'
import { routeRange } from './route.ts'
import type { PrepareInputValue, PrepareOutputValue } from './schema.ts'

export const MAX_ROUNDS = 3
export const FIVE_HOUR_CEILING = 70
export const SEVEN_DAY_CEILING = 90
/** A runaway guard far above a busy day (~15 deep reviews per account); the quota ceiling is what paces review. */
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

/** The review ceiling: below 70 % of the 5-hour window and 90 % of the week (no 5-hour reading: the week alone). */
function judge(account: string, reading: QuotaReading | null): { ceiling: 'ok' | 'unknown' } | { held: string } {
  if (!reading || (reading.fiveHour === null && reading.sevenDay === null)) return { ceiling: 'unknown' }
  if (reading.fiveHour !== null && reading.fiveHour >= FIVE_HOUR_CEILING) {
    return { held: `held: ${account} at ${Math.round(reading.fiveHour)} % of its 5-hour window` }
  }
  if (reading.sevenDay !== null && reading.sevenDay >= SEVEN_DAY_CEILING) {
    return { held: `held: ${account} at ${Math.round(reading.sevenDay)} % of its 7-day window` }
  }
  return { ceiling: 'ok' }
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
  const decision = await routeRange({ git, repo: gitDir, base: diffBase, head, min: input.min, configAt: base })
  const { config, changes, warning: _warning, ...route } = decision
  const decided = { tier: route.tier, seat: route.seat, rule: route.rule, decidedBy: route.decidedBy, diffBase }
  if (route.tier === 'none') return { status: 'skipped', ...common, ...decided }

  let ceiling: 'ok' | 'unknown' | 'unjudged' = 'unjudged'
  if (account !== null) {
    const verdict = judge(account, ctx.quota ? await ctx.quota(account) : null)
    if ('held' in verdict) return { status: 'held', reason: verdict.held, ...common, ...decided, ceiling: 'held' }
    ceiling = verdict.ceiling
  }
  if (route.tier === 'deep') {
    const cap = deepCap(ctx.env)
    const today = await ledger.deepCount(account, utcMidnight(ctx.now()), thread)
    if (today >= cap) {
      return {
        status: 'held',
        reason: `held: ${account ?? 'no account'} at the deep cap, ${today}/${cap} deep reviews today (UTC)`,
        ...common,
        ...decided,
        ceiling,
      }
    }
  }

  const files = changes.map((c) => c.path)
  const reviewMd = await tryGit(git, gitDir, ['show', `${base}:REVIEW.md`])
  mkdirSync(jobDir, { recursive: true })
  const worktree = resolved.clone ?? join(jobDir, 'tree')
  if (!resolved.clone) await makeWorktree(ctx, root, worktree, head)
  const headTree = (await git(gitDir, ['rev-parse', `${head}^{tree}`])).trim()

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
  writeFileSync(paths.diff, await git(gitDir, ['diff', '-M', range]))
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
  writeFileSync(paths.reviewMd, reviewMd ?? 'This repository has no REVIEW.md at the base of the change.\n')
  const { tier } = route
  writeFileSync(
    join(jobDir, 'job.json'),
    `${JSON.stringify({ jobId, repo, thread, round, tier, seat: route.seat, base, diffBase, head, worktree, files: paths }, null, 1)}\n`,
  )

  const scope =
    input.pr !== undefined
      ? { pr: input.pr }
      : input.branch !== undefined
        ? { branch: input.branch }
        : { scope: input.scope ?? 'uncommitted' }
  await ledger.insertJob({
    id: jobId,
    repo,
    root,
    thread,
    round,
    scope: {
      ...scope,
      ...(input.thread ? { thread: input.thread } : {}),
      ...(typeof threadKey === 'string' ? { threadKey } : {}),
    },
    base,
    diffBase,
    head,
    headTree,
    tier,
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
  })
  return {
    status: 'ready',
    jobId,
    ...common,
    ...decided,
    jobDir,
    worktree,
    files,
    ceiling,
    prompt: `job=${jobDir} worktree=${worktree} tier=${tier} round=${round}`,
  }
}
