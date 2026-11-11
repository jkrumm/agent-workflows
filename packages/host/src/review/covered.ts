// `agw review covered`: does every first-parent commit of a range sit under a submitted review at its required tier?
// The wave gate and the software factory read `covered`; the router is `routeRange`, never a second copy.
import type { ReviewContext } from './context.ts'
import type { Job } from './ledger.ts'
import { isAncestor, patchId, repoIdentity, resolveRoot, tryGit } from './repo.ts'
import { atLeast, maxTier, routeRange, type Tier } from './route.ts'
import { type CoveredOutputValue, ReviewError } from './schema.ts'
import { scopeProblem, splitRange } from './scope.ts'

const CANDIDATE_DAYS = 30
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export async function covered(ctx: ReviewContext, input: { cwd: string; range: string }): Promise<CoveredOutputValue> {
  const { git, ledger } = ctx
  const root = await resolveRoot(git, input.cwd)
  const repo = await repoIdentity(git, root)
  const halves = splitRange(input.range)
  const problem = scopeProblem(input.range)
  if (!halves || !halves.from || problem || input.range.includes('...')) {
    throw new ReviewError(`range must be <a>..<b>${problem ? `: ${problem}` : ''}`)
  }
  const listed = await tryGit(git, root, [
    'rev-list',
    '--first-parent',
    '--reverse',
    `${halves.from}..${halves.to || 'HEAD'}`,
  ])
  if (listed === null) throw new ReviewError(`"${input.range}" is not a range of commits in ${root}`)
  const shas = listed.split('\n').filter(Boolean)

  const since = new Date(ctx.now().getTime() - CANDIDATE_DAYS * 86_400_000)
  const candidates = await ledger.submittedSince(repo, since)
  const tiers = await ledger.threadTiers(repo, [...new Set(candidates.map((j) => j.thread))])
  const openImportant = await ledger.openImportant(repo, [...new Set(candidates.map((j) => j.thread))])
  const coverTier = (job: Job): Tier =>
    tiers
      .filter((t) => t.thread === job.thread && t.round <= job.round)
      .reduce<Tier>((tier, t) => maxTier(tier, t.tier), job.tier)

  const ancestry = new Map<string, Promise<boolean>>()
  const ancestor = (a: string, b: string) => {
    const key = `${a} ${b}`
    let hit = ancestry.get(key)
    if (!hit) {
      hit = a === b ? Promise.resolve(true) : isAncestor(git, root, a, b)
      ancestry.set(key, hit)
    }
    return hit
  }
  const exists = async (sha: string) => (await tryGit(git, root, ['cat-file', '-e', `${sha}^{commit}`])) !== null

  // The squash-merge of a reviewed change that was rebased: another tree, the same patch. Computed lazily, once per
  // job and once per commit, and only after the cheaper tests failed.
  const jobPatch = new Map<string, Promise<string | null>>()
  const commitPatch = new Map<string, Promise<string | null>>()
  const once = (cache: Map<string, Promise<string | null>>, key: string, make: () => Promise<string | null>) => {
    let hit = cache.get(key)
    if (!hit) {
      hit = make()
      cache.set(key, hit)
    }
    return hit
  }
  const samePatch = async (job: Job, parent: string, sha: string): Promise<boolean> => {
    if (!(await exists(job.head))) return false
    const wanted = await once(jobPatch, job.id, () => patchId(git, root, job.diffBase, job.head))
    if (!wanted) return false
    return wanted === (await once(commitPatch, sha, () => patchId(git, root, parent, sha)))
  }

  const commits: CoveredOutputValue['commits'] = []
  for (const sha of shas) {
    const parent = (await tryGit(git, root, ['rev-parse', '--verify', '--quiet', `${sha}^`]))?.trim() || null
    const [subject = '', tree = ''] = (await git(root, ['show', '-s', '--format=%s%n%T', sha])).split('\n')
    const required = await routeRange({ git, repo: root, base: parent ?? EMPTY_TREE, head: sha })
    if (required.tier === 'none' || !parent) {
      commits.push({ sha, subject, required: required.tier, rule: required.rule, coveredBy: null })
      continue
    }
    let coveredBy: string | null = null
    const blocking = new Set<string>()
    for (const job of candidates) {
      if (!atLeast(coverTier(job), required.tier)) continue
      if (!(await ancestor(job.base, parent))) continue
      const headCovers =
        job.headTree === tree ||
        (await ancestor(sha, job.head)) ||
        ((await exists(job.head)) &&
          (await routeRange({ git, repo: root, base: job.head, head: sha }).catch(() => null))?.tier === 'none') ||
        (await samePatch(job, parent, sha))
      if (!headCovers) continue
      const open = openImportant.get(job.thread)
      if (open) {
        for (const id of open) blocking.add(id)
        continue
      }
      coveredBy = job.id
      break
    }
    const reason = coveredBy === null && blocking.size > 0
    commits.push({
      sha,
      subject,
      required: required.tier,
      rule: required.rule,
      coveredBy,
      ...(reason ? { reason: 'open-important' as const, findings: [...blocking].sort() } : {}),
    })
  }
  const uncovered = commits.filter((c) => c.required !== 'none' && c.coveredBy === null).map((c) => c.sha)
  return { covered: uncovered.length === 0, commits, uncovered }
}
