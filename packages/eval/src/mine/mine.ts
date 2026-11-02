import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GtCandidate } from '../gt.ts'
import type { Exec } from '../harness/exec.ts'
import { type BlamedLine, blameRanges } from './blame.ts'
import { eligibleControls, type MineControl, pickControls } from './controls.ts'
import { type Git, gitIn, type LogCommit, readLog } from './git.ts'
import { removedLines } from './patch.ts'
import { discoverRepos, type MineRepo } from './repos.ts'
import { isBugFixSubject, isFixSubject, isReformatSubject } from './subjects.ts'
import {
  DEFAULT_CONTROLS,
  EXCLUDED_REPOS,
  MAX_CHANGED_LINES,
  MAX_INTRO_AGE_DAYS,
  MINER_VERSION,
  REFORMAT_MIN_FILES,
  REFORMAT_WHITESPACE_SHARE,
} from './version.ts'

/** Counts at every filter. Lines for the line-level steps, (fix, introducing commit) pairs from `blamedCommits` on. */
export type MineFunnel = {
  repos: number
  /** Repos whose history could not be read (no commits, git failed). */
  reposSkipped: number
  ownerCommits: number
  /** Fix commits by subject, before the exclusions. */
  fixCommits: number
  /** After dropping deps, ci, docs, release, style, lint, typo and format fixes. */
  afterMessageFilter: number
  /** Fixes with at least one removed or changed code line left after the cosmetic filter. */
  fixesWithRemovableLines: number
  removedLines: number
  droppedCosmeticLines: number
  /** Range batches `git blame` refused (a file that is gone or binary at the parent). */
  blameFailures: number
  blamedLines: number
  blamedCommits: number
  droppedReformat: number
  droppedMerge: number
  droppedNotOwner: number
  droppedTooOld: number
  droppedTooLarge: number
  droppedNoParent: number
  candidates: number
  /** Mass-reformat commits looked past, over all repos. */
  ignoredReformats: number
  controlsEligible: number
  controls: number
}

export interface MineOptions {
  /** The directory whose git-checkout children are mined (default `$HOME/SourceRoot` at the caller). */
  root: string
  exec: Exec
  /** Injected, so the age rules are testable. */
  now: Date
  seed: number
  controls?: number
  /** The owner's author emails (case-insensitive). No default: they are private and come from the caller. */
  ownerEmails: readonly string[]
  excludedRepos?: readonly string[]
  /** Where the ignore-revs files go (removed afterwards). Default: the OS temp dir. */
  tmpRoot?: string
}

export interface MineResult {
  candidates: GtCandidate[]
  controls: MineControl[]
  funnel: MineFunnel
  /** Repos whose history could not be mined, with the error. Any entry makes the result incomplete: do not store it. */
  skipped: { repo: string; error: string }[]
}

const emptyFunnel = (): MineFunnel => ({
  repos: 0,
  reposSkipped: 0,
  ownerCommits: 0,
  fixCommits: 0,
  afterMessageFilter: 0,
  fixesWithRemovableLines: 0,
  removedLines: 0,
  droppedCosmeticLines: 0,
  blameFailures: 0,
  blamedLines: 0,
  blamedCommits: 0,
  droppedReformat: 0,
  droppedMerge: 0,
  droppedNotOwner: 0,
  droppedTooOld: 0,
  droppedTooLarge: 0,
  droppedNoParent: 0,
  candidates: 0,
  ignoredReformats: 0,
  controlsEligible: 0,
  controls: 0,
})

const FIX_CONCURRENCY = 6

async function inOrder<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * Commits to look past when blaming: reformat subjects, and commits touching many files whose changed lines are
 * mostly whitespace (the `-w` numstat of the same history shows how much of a commit is whitespace).
 */
async function massReformats(git: Git, log: readonly LogCommit[]): Promise<Set<string>> {
  const ignored = new Set(log.filter((c) => isReformatSubject(c.subject)).map((c) => c.sha))
  const wide = log.filter((c) => c.files.length >= REFORMAT_MIN_FILES && c.changed > 0)
  if (wide.length === 0) return ignored
  const stripped = new Map((await readLog(git, { ignoreWhitespace: true })).map((c) => [c.sha, c.changed]))
  for (const c of wide) {
    const whitespace = c.changed - (stripped.get(c.sha) ?? c.changed)
    if (whitespace / c.changed >= REFORMAT_WHITESPACE_SHARE) ignored.add(c.sha)
  }
  return ignored
}

type RepoMined = { candidates: GtCandidate[]; controls: MineControl[]; funnel: MineFunnel }

async function mineRepo(
  repo: MineRepo,
  options: Required<Pick<MineOptions, 'exec' | 'now'>> & {
    owners: ReadonlySet<string>
    tmpDir: string
  },
): Promise<RepoMined> {
  const git = gitIn(options.exec, repo.path)
  const funnel = emptyFunnel()
  const log = await readLog(git)
  const bySha = new Map(log.map((c) => [c.sha, c]))
  const ownerCommits = log.filter((c) => options.owners.has(c.email))
  const fixes = ownerCommits.filter((c) => isFixSubject(c.subject))
  const kept = fixes.filter((c) => isBugFixSubject(c.subject) && c.parents.length > 0)
  funnel.ownerCommits = ownerCommits.length
  funnel.fixCommits = fixes.length
  funnel.afterMessageFilter = kept.length

  const ignored = await massReformats(git, log)
  funnel.ignoredReformats = ignored.size
  let ignoreRevsFile: string | null = null
  if (ignored.size > 0) {
    ignoreRevsFile = join(options.tmpDir, `${repo.dir}.ignore-revs`)
    writeFileSync(ignoreRevsFile, `${[...ignored].join('\n')}\n`)
  }

  const blamedAny = new Set<string>()
  const candidates: GtCandidate[] = []
  const perFix = await inOrder(kept, FIX_CONCURRENCY, async (fix) => {
    const patch = removedLines(await git(['show', '-U0', '--format=', '--find-renames', fix.sha]))
    const lines: BlamedLine[] = []
    let failures = 0
    for (const removed of patch.files) {
      const blamed = await blameRanges(git, { parent: `${fix.sha}^`, removed, ignoreRevsFile })
      lines.push(...blamed.lines)
      failures += blamed.failed
    }
    return { fix, patch, lines, failures }
  })

  const ageWindow = MAX_INTRO_AGE_DAYS * 86_400
  for (const { fix, patch, lines, failures } of perFix) {
    funnel.removedLines += patch.removed
    funnel.droppedCosmeticLines += patch.cosmetic
    funnel.blameFailures += failures
    if (patch.files.length > 0) funnel.fixesWithRemovableLines++
    funnel.blamedLines += lines.length
    const byIntro = new Map<string, BlamedLine[]>()
    for (const line of lines) {
      blamedAny.add(line.sha)
      byIntro.set(line.sha, [...(byIntro.get(line.sha) ?? []), line])
    }
    for (const [sha, introLines] of byIntro) {
      funnel.blamedCommits++
      const intro = bySha.get(sha)
      if (ignored.has(sha)) funnel.droppedReformat++
      else if (!intro) funnel.droppedMerge++
      else if (!options.owners.has(intro.email)) funnel.droppedNotOwner++
      else if (intro.at < fix.at - ageWindow) funnel.droppedTooOld++
      else if (intro.changed > MAX_CHANGED_LINES) funnel.droppedTooLarge++
      else if (intro.parents.length === 0) funnel.droppedNoParent++
      else {
        const blamed = [
          ...new Map(introLines.map((l) => [`${l.file}\0${l.line}`, { file: l.file, line: l.line }])).values(),
        ].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
        candidates.push({
          id: `${repo.dir}-${fix.sha.slice(0, 10)}-${sha.slice(0, 10)}`,
          repo: repo.name,
          fixSha: fix.sha,
          fixSubject: fix.subject,
          fixDate: fix.iso,
          introSha: sha,
          introParent: intro.parents[0] as string,
          introSubject: intro.subject,
          introDate: intro.iso,
          blamed,
          introChangedLines: intro.changed,
          minerVersion: MINER_VERSION,
        })
      }
    }
  }
  funnel.candidates = candidates.length

  const controls = eligibleControls({ repo, ownerCommits, blamedAny, skip: ignored, now: options.now })
  return { candidates, controls, funnel }
}

/**
 * The ground-truth miner, steps 1 to 3 plus the clean controls (`docs/review-v2.md` §Ground truth): SZZ candidates of
 * the owner's fix history across every checkout under `root`, and the controls to pair them with. Pure over `exec`
 * (git), `now` and `seed`: the same history gives the same result. Reads only; the ignore-revs files go to a temp
 * directory it removes.
 */
export async function mine(options: MineOptions): Promise<MineResult> {
  const owners = new Set(options.ownerEmails.map((e) => e.toLowerCase()))
  const repos = discoverRepos(options.root, options.excludedRepos ?? EXCLUDED_REPOS)
  const funnel = emptyFunnel()
  funnel.repos = repos.length
  const tmpDir = mkdtempSync(join(options.tmpRoot ?? tmpdir(), 'agw-mine-'))
  const candidates: GtCandidate[] = []
  const eligible: MineControl[] = []
  const skipped: MineResult['skipped'] = []
  try {
    for (const repo of repos) {
      let mined: RepoMined
      try {
        mined = await mineRepo(repo, { exec: options.exec, now: options.now, owners, tmpDir })
      } catch (error) {
        funnel.reposSkipped++
        skipped.push({ repo: repo.name, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) })
        continue
      }
      candidates.push(...mined.candidates)
      eligible.push(...mined.controls)
      for (const key of Object.keys(funnel) as (keyof MineFunnel)[]) {
        if (key !== 'repos' && key !== 'reposSkipped' && key !== 'controlsEligible' && key !== 'controls') {
          funnel[key] += mined.funnel[key]
        }
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
  candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const controls = pickControls(eligible, { count: options.controls ?? DEFAULT_CONTROLS, seed: options.seed })
  funnel.controlsEligible = eligible.length
  funnel.controls = controls.length
  return { candidates, controls, funnel, skipped }
}
