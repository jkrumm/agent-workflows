import { WorkflowError } from './errors.ts'
import type { Verdict } from './types.ts'

/** A scorer's answer, checked: finite numbers, a boolean `pass`, a string `feedback` or none. Json-clean. */
export function checkVerdict(raw: unknown, where: string): Verdict {
  const bad = (why: string) => new WorkflowError('invalid_output', `${where}: the scorer returned ${why}`)
  if (raw === null || typeof raw !== 'object') throw bad('no object')
  const { scores, pass, feedback } = raw as Record<string, unknown>
  if (typeof pass !== 'boolean') throw bad('no boolean `pass`')
  if (scores === null || typeof scores !== 'object' || Array.isArray(scores)) throw bad('no `scores` object')
  const checked: Record<string, number> = {}
  for (const [name, value] of Object.entries(scores)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw bad(`a non-finite score "${name}"`)
    checked[name] = value
  }
  if (feedback !== undefined && typeof feedback !== 'string') throw bad('a non-string `feedback`')
  return { scores: checked, pass, ...(feedback === undefined ? {} : { feedback }) }
}
