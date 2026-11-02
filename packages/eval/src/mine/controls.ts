import type { z } from 'zod'
import type { GtControlCase as GtControlCaseSchema } from '../gt.ts'
import type { LogCommit } from './git.ts'
import { seededShuffle, splitOf } from './split.ts'
import { isCodeFile, isWeakSubject } from './subjects.ts'
import { CONTROL_MIN_AGE_DAYS, MAX_CHANGED_LINES, MAX_WEAK_CONTROL_SHARE, MINER_VERSION } from './version.ts'

type GtControlCase = z.infer<typeof GtControlCaseSchema>

/** A control before its split: an owner commit no later fix blamed. */
export interface MineControl {
  id: string
  repo: string
  dir: string
  sha: string
  parent: string
  subject: string
}

/**
 * Owner commits that can be a clean control: at least 12 weeks old (a later fix had time to show), changing a code
 * file, reviewable in size, with a parent. `blamedAny` holds every commit any fix commit's blame landed on (taken
 * before the owner, age and size filters), so a control has no later fix on its lines at all, which includes the rule
 * "no fix within 12 weeks blames it". `skip` holds mass reformats.
 */
export function eligibleControls(options: {
  repo: { name: string; dir: string }
  ownerCommits: readonly LogCommit[]
  blamedAny: ReadonlySet<string>
  skip: ReadonlySet<string>
  now: Date
}): MineControl[] {
  const cutoff = options.now.getTime() / 1000 - CONTROL_MIN_AGE_DAYS * 86_400
  return options.ownerCommits
    .filter(
      (c) =>
        c.at <= cutoff &&
        c.parents.length > 0 &&
        c.changed <= MAX_CHANGED_LINES &&
        c.files.some(isCodeFile) &&
        !options.blamedAny.has(c.sha) &&
        !options.skip.has(c.sha),
    )
    .map((c) => ({
      id: `${options.repo.dir}-control-${c.sha.slice(0, 10)}`,
      repo: options.repo.name,
      dir: options.repo.dir,
      sha: c.sha,
      parent: c.parents[0] as string,
      subject: c.subject,
    }))
}

/**
 * Up to `count` controls by a seeded shuffle. A docs, test, refactor or chore control joins only while it keeps that
 * kind at most 15 % of the sample picked so far, so the share holds for the sample as returned, also when logic
 * commits run short.
 */
export function pickControls(
  eligible: readonly MineControl[],
  options: { count: number; seed: number },
): MineControl[] {
  const ordered = [...eligible].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const picked: MineControl[] = []
  let weak = 0
  for (const control of seededShuffle(ordered, options.seed)) {
    if (picked.length >= options.count) break
    if (isWeakSubject(control.subject)) {
      if ((weak + 1) / (picked.length + 1) > MAX_WEAK_CONTROL_SHARE) continue
      weak++
    }
    picked.push(control)
  }
  return picked
}

export const controlCase = (control: MineControl): GtControlCase => ({
  kind: 'control',
  id: control.id,
  split: splitOf(control.id),
  repo: control.repo,
  sha: control.sha,
  parent: control.parent,
  subject: control.subject,
  minerVersion: MINER_VERSION,
})
