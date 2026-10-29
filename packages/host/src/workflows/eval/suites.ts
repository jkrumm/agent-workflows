import { casesPath } from '@agent-workflows/eval'
import { type EvalCase, plainSuite, type Suites } from '../suite.ts'

export type { EvalCase, Suite, Suites } from '../suite.ts'

/** The suite ids, sorted: the `workflow` enum of `agw eval run|compare` (a zod enum needs one at least). */
export function suiteIds(suites: Suites): [string, ...string[]] {
  const ids = [...suites.keys()].sort()
  if (ids.length === 0) throw new Error('eval: no module declares a suite')
  return ids as [string, ...string[]]
}

/**
 * A case replays the way the harness replays it (`packages/eval/README.md` §How a case runs), read by the suite of
 * the workflow's module from `$AGW_EVAL_DIR/<workflow>/cases.jsonl`.
 */
export function readSuite(suites: Suites, workflow: string, env: Record<string, string | undefined>): EvalCase[] {
  const suite = suites.get(workflow)
  if (!suite) throw new Error(`no eval suite for "${workflow}"`)
  return (suite === 'plain' ? plainSuite : suite).read(casesPath(workflow, env))
}
