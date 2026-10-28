import { CheckCase, casesPath, type MaterializeInput, ReviewCase, readCases } from '@agent-workflows/eval'
import type { Json } from '@agent-workflows/runtime'
import { checkReference } from '../check/scorer.ts'
import { reviewReference } from '../review/scorer.ts'

/** The workflows `agw eval run|compare` know: a recorded case set (`$AGW_EVAL_DIR/<workflow>/cases.jsonl`) and a scorer. */
export const SUITE_IDS = ['review', 'check'] as const
export type SuiteId = (typeof SUITE_IDS)[number]

/** One recorded case, ready to replay: the tree to materialize, the workflow input on it, the expected result. */
export interface EvalCase {
  id: string
  tree: MaterializeInput
  /** The repo's own setup (`bun install`) before the run: check needs it, review reads the diff only. */
  setup: boolean
  /** The workflow input on the materialized tree; `args` (the arm's extra input) win over the recorded input. */
  input(dir: string, args: Record<string, Json>): Record<string, Json>
  reference: Json
}

const defined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Record<string, Json>

/**
 * A case replays the way the harness replays it (`packages/eval/README.md` §How a case runs): the recorded diff as
 * uncommitted changes on `baseSha`, reviewed at the recorded depth; a check case with its recorded commands.
 */
export function readSuite(workflow: SuiteId, env: Record<string, string | undefined>): EvalCase[] {
  const path = casesPath(workflow, env)
  if (workflow === 'review') {
    return readCases(path, ReviewCase).map((c) => ({
      id: c.id,
      tree: { repo: c.repo, baseSha: c.baseSha, patch: c.diff },
      setup: false,
      input: (dir, args) => ({
        ...defined({
          cwd: dir,
          scope: 'uncommitted',
          depth: c.legacy.depth ?? c.input.depth,
          context: c.input.context,
        }),
        ...args,
      }),
      reference: reviewReference(c.legacy),
    }))
  }
  return readCases(path, CheckCase).map((c) => ({
    id: c.id,
    tree: { repo: c.repo, baseSha: c.baseSha, ...(c.patch ? { patch: c.patch } : {}) },
    setup: true,
    input: (dir, args) => ({
      ...defined({ cwd: dir, commands: c.input.commands, stepTimeoutSeconds: c.input.stepTimeoutSeconds }),
      ...args,
    }),
    reference: checkReference(c.legacy),
  }))
}
