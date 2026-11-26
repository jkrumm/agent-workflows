// `agw review covered`: does every first-parent commit of a range sit under a submitted review at its required tier?
// The wave gate and the software factory read `covered`; the router is `routeRange`, never a second copy.
//
// It answers from the ledger and from git, never from a model, and its cost is the number of git processes: the host runs
// it at load 30. So every question about history (is A an ancestor of B, does the reviewed head exist) is answered from one
// in-process commit graph, the commit facts come from one `git log`, and a git call per (commit, job) pair is made only
// for a job that touched the commit's files, after the free tests failed.
import type { ReviewContext } from './context.ts'
import type { Job } from './ledger.ts'
import { patchId, replayTree, repoIdentity, resolveRoot, tryGit } from './repo.ts'
import { atLeast, type GitRunner, maxTier, routeRange, type Tier } from './route.ts'
import { type CoveredOutputValue, ReviewError } from './schema.ts'
import { scopeProblem, splitRange } from './scope.ts'

const CANDIDATE_DAYS = 30
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
/** Commits routed at once: git processes in flight, not CPU. */
const CONCURRENCY = 4
const RELATED_LIMIT = 3
const FIELD = '\x1f'
const RECORD = '\x1e'

interface CommitFacts {
  sha: string
  parent: string | null
  tree: string
  subject: string
}

/** The commit graph of the range's head and the jobs' heads, with generation numbers to cut every ancestry walk short. */
interface Graph {
  has: (sha: string) => boolean
  /** `a` is `b` or an ancestor of `b`. A commit the graph does not hold is nobody's ancestor. */
  reaches: (a: string, b: string) => boolean
}

async function commitGraph(git: GitRunner, root: string, tip: string, heads: string[]): Promise<Graph> {
  // `--ignore-missing`: a job head that was a snapshot commit and has been collected is left out, never an error
  const out = await tryGit(git, root, ['rev-list', '--parents', '--topo-order', '--ignore-missing', tip, ...heads])
  if (out === null) throw new Error(`could not read the commit graph of ${root}`)
  const parents = new Map<string, string[]>()
  const order: string[] = []
  for (const line of out.split('\n')) {
    const [sha, ...rest] = line.split(' ')
    if (!sha) continue
    parents.set(sha, rest)
    order.push(sha)
  }
  // topo order lists a child before its parents: walking it backwards sees every parent first
  const generation = new Map<string, number>()
  for (let i = order.length - 1; i >= 0; i--) {
    const sha = order[i]!
    generation.set(sha, 1 + Math.max(0, ...(parents.get(sha) ?? []).map((p) => generation.get(p) ?? 0)))
  }
  const verdicts = new Map<string, boolean>()
  const reaches = (a: string, b: string): boolean => {
    if (a === b) return parents.has(a)
    const floor = generation.get(a)
    if (floor === undefined || !parents.has(b)) return false
    const key = `${a} ${b}`
    const known = verdicts.get(key)
    if (known !== undefined) return known
    const seen = new Set([b])
    const stack = [b]
    let found = false
    while (stack.length > 0 && !found) {
      for (const parent of parents.get(stack.pop()!) ?? []) {
        if (parent === a) {
          found = true
          break
        }
        if (seen.has(parent) || (generation.get(parent) ?? 0) <= floor) continue
        seen.add(parent)
        stack.push(parent)
      }
    }
    verdicts.set(key, found)
    return found
  }
  return { has: (sha) => parents.has(sha), reaches }
}

/** `items` through `work`, at most `limit` at a time; the results keep the order of `items`. */
async function pooled<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await work(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}

/** One promise per key: the same question is never put to git twice. */
function memo<T>(cache = new Map<string, Promise<T>>()) {
  return (key: string, make: () => Promise<T>): Promise<T> => {
    let hit = cache.get(key)
    if (!hit) {
      hit = make()
      cache.set(key, hit)
    }
    return hit
  }
}

export async function covered(ctx: ReviewContext, input: { cwd: string; range: string }): Promise<CoveredOutputValue> {
  const { git, ledger } = ctx
  const root = await resolveRoot(git, input.cwd)
  const repo = await repoIdentity(git, root)
  const halves = splitRange(input.range)
  const problem = scopeProblem(input.range)
  if (!halves || !halves.from || problem || input.range.includes('...')) {
    throw new ReviewError(`range must be <a>..<b>${problem ? `: ${problem}` : ''}`)
  }
  const tip = halves.to || 'HEAD'
  // one process for every commit's parent, tree and subject (`%P` lists the first parent first, as `<sha>^` does)
  const listed = await tryGit(git, root, [
    '-c',
    'log.showSignature=false',
    'log',
    '--first-parent',
    '--reverse',
    `--format=%H${FIELD}%P${FIELD}%T${FIELD}%s${RECORD}`,
    `${halves.from}..${tip}`,
  ])
  if (listed === null) throw new ReviewError(`"${input.range}" is not a range of commits in ${root}`)
  const facts = listed
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record): CommitFacts => {
      const [sha = '', parents = '', tree = '', subject = ''] = record.split(FIELD)
      return { sha, parent: parents.split(' ')[0] || null, tree, subject }
    })

  const since = new Date(ctx.now().getTime() - CANDIDATE_DAYS * 86_400_000)
  const candidates = await ledger.submittedSince(repo, since)
  const threads = [...new Set(candidates.map((j) => j.thread))]
  const [tiers, openImportant] = await Promise.all([
    ledger.threadTiers(repo, threads),
    ledger.openImportant(repo, threads),
  ])
  const coverTier = (job: Job): Tier =>
    tiers
      .filter((t) => t.thread === job.thread && t.round <= job.round)
      .reduce<Tier>((tier, t) => maxTier(tier, t.tier), job.tier)

  // REVIEW.md of one revision is read once, whoever routes against it
  const reviewMd = memo<string>()
  const routingGit: GitRunner = (cwd, args) =>
    args[0] === 'show' && args[1]?.endsWith(':REVIEW.md') ? reviewMd(args[1], () => git(cwd, args)) : git(cwd, args)

  const graphOf = memo<Graph>()
  const graph = () => graphOf('graph', () => commitGraph(git, root, tip, [...new Set(candidates.map((j) => j.head))]))

  // A reviewed change that was rebased or replayed: another tree. Two shapes land it: a squash-merge (one commit that
  // carries the whole job's change) and a rebase-merge (one commit per job commit, every SHA new). Both are matched
  // first by equal patch-id, then by replaying the reviewed change onto the commit's parent. Computed lazily, once per
  // (base, head), and only for a job that touched the commit's files.
  const patchIds = memo<string | null>()
  const idOf = (base: string, head: string, options: { context?: 0 } = {}) =>
    patchIds(`${options.context ?? 'full'} ${base} ${head}`, () => patchId(git, root, base, head, options))
  const replays = memo<string | null>()
  const jobCommits = memo<[parent: string, sha: string][]>()
  // A multi-round thread chains: round N's diffBase is round N-1's head, so a squash of the whole branch equals no single
  // job's patch but the cumulative one, from the first round's diffBase to this job's head.
  const chainStart = (job: Job): string => {
    let start = job
    for (;;) {
      const prev = candidates
        .filter((j) => j.thread === start.thread && j.round < start.round && j.head === start.diffBase)
        .reduce<Job | null>((best, j) => (best && best.round > j.round ? best : j), null)
      if (!prev) return start.diffBase
      start = prev
    }
  }
  // The reviewed changes a commit can repeat, cheapest first: the job's whole diff, the thread's chain up to it, each
  // of its commits. A job head that no longer exists fails every git call on it: no match.
  const anyChange = async (job: Job, matches: (base: string, head: string) => Promise<boolean>): Promise<boolean> => {
    if (await matches(job.diffBase, job.head)) return true
    const first = chainStart(job)
    if (first !== job.diffBase && (await matches(first, job.head))) return true
    const commits = await jobCommits(job.id, async () => {
      // no merges, so each line is a commit and its one parent; with real SHAs a one-commit job is the same (base, head)
      // as its whole diff and is asked about once
      const range = `${job.diffBase}..${job.head}`
      const listed = await tryGit(git, root, ['rev-list', '--parents', '--reverse', '--no-merges', range])
      return (listed?.split('\n') ?? []).flatMap((line): [string, string][] => {
        const [sha, parent] = line.split(' ')
        return sha && parent ? [[parent, sha]] : []
      })
    })
    return (await pooled(commits, CONCURRENCY, ([base, head]) => matches(base, head))).includes(true)
  }
  const samePatch = async (job: Job, parent: string, sha: string): Promise<boolean> => {
    const mine = await idOf(parent, sha)
    if (!mine) return false // an empty or unreadable diff matches nothing, and no job's patch needs computing
    return anyChange(job, async (base, head) => (await idOf(base, head)) === mine)
  }
  // A master that changed a context line of the reviewed change alters its patch-id but not the change. Git's own merge
  // decides: the commit is covered when replaying the reviewed change onto its parent gives exactly its tree. The
  // context-free patch-id only spares a merge per (commit, job) pair for changes that cannot give that tree.
  const sameReplay = async (job: Job, parent: string, sha: string, tree: string): Promise<boolean> => {
    const mine = await idOf(parent, sha, { context: 0 })
    if (!mine || !(await graph()).has(job.head)) return false
    return anyChange(job, async (base, head) => {
      if ((await idOf(base, head, { context: 0 })) !== mine) return false
      const replayed = await replays(`${base} ${head} ${parent}`, () => replayTree(git, root, base, head, parent))
      return replayed === tree
    })
  }

  const examine = async (fact: CommitFacts): Promise<CoveredOutputValue['commits'][number]> => {
    const { sha, parent, tree, subject } = fact
    const required = await routeRange({ git: routingGit, repo: root, base: parent ?? EMPTY_TREE, head: sha })
    if (required.tier === 'none' || !parent) {
      return { sha, subject, required: required.tier, rule: required.rule, coveredBy: null }
    }
    const { reaches, has } = await graph()
    const touched = new Set(required.changes.map((c) => c.path))
    // a job with no recorded files is not known to be unrelated
    const overlaps = (job: Job) => job.files.length === 0 || job.files.some((f) => touched.has(f))

    // The commit's files a job's reply left out: a review that did not read them does not cover the commit
    const skipped = (job: Job) => (job.output?.unreviewed ?? []).filter((f) => touched.has(f))

    // J.base ≤ c^ and the thread's tier up to J.round reaches the required one
    const lineage = candidates.filter((job) => reaches(job.base, parent))
    const related = lineage.filter(overlaps)
    const atRequired = lineage.filter((job) => atLeast(coverTier(job), required.tier))
    const eligible = atRequired.filter((job) => skipped(job).length === 0)
    const atTier = eligible.some(overlaps)

    // The ways a job's head can cover the commit, cheapest first and each over every eligible job before the next one
    // starts: a covered commit is found by a free test and never pays for a git process per job.
    const ways: ((job: Job) => boolean | Promise<boolean>)[] = [
      (job) => job.headTree === tree || reaches(sha, job.head),
      (job) => overlaps(job) && samePatch(job, parent, sha),
      (job) => overlaps(job) && sameReplay(job, parent, sha, tree),
      async (job) =>
        overlaps(job) &&
        has(job.head) &&
        (await routeRange({ git: routingGit, repo: root, base: job.head, head: sha }).catch(() => null))?.tier ===
          'none',
    ]
    let coveredBy: string | null = null
    const blocking = new Set<string>()
    const settled = new Set<string>()
    for (const way of ways) {
      for (const job of eligible) {
        if (settled.has(job.id) || !(await way(job))) continue
        const open = openImportant.get(job.thread)
        if (open) {
          for (const id of open) blocking.add(id)
          settled.add(job.id) // it covers, but its thread blocks it: no other test can change that
          continue
        }
        coveredBy = job.id
        break
      }
      if (coveredBy !== null) break
    }
    const base = { sha, subject, required: required.tier, rule: required.rule, coveredBy }
    if (coveredBy !== null) return base
    if (blocking.size > 0) return { ...base, reason: 'open-important', findings: [...blocking].sort() }
    const left = [...new Set(atRequired.filter(overlaps).flatMap(skipped))].sort()
    if (left.length > 0) return { ...base, reason: 'unreviewed', unreviewed: left }
    const nearest = related.slice(-RELATED_LIMIT).map((j) => j.id)
    if (related.length === 0) return { ...base, reason: 'no-review' }
    return { ...base, reason: atTier ? 'stale' : 'tier-too-low', related: nearest }
  }

  const commits = await pooled(facts, CONCURRENCY, examine)
  const uncovered = commits.filter((c) => c.required !== 'none' && c.coveredBy === null)
  const state =
    uncovered.length === 0 ? 'covered' : uncovered.every((c) => c.reason === 'no-review') ? 'no-review' : 'uncovered'
  return { covered: uncovered.length === 0, state, commits, uncovered: uncovered.map((c) => c.sha) }
}
