import { casesPath, type MaterializeInput, PlainCase, readCases } from '@agent-workflows/eval'
import type { Json } from '@agent-workflows/runtime'

/** One recorded case, ready to replay: the tree to materialize, the workflow input on it, the expected result. */
export interface EvalCase {
  id: string
  /** Null: the case runs on no tree (a `PlainCase`); its `input` gets no directory. */
  tree: MaterializeInput | null
  /** The repo's own setup (`bun install`) before the run: check needs it, review reads the diff only. */
  setup: boolean
  /** The workflow input on the materialized tree; `args` (the arm's extra input) win over the recorded input. */
  input(dir: string, args: Record<string, Json>): Record<string, Json>
  reference: Json
}

/** A module's own case reader: the recorded `cases.jsonl` at `path` as replayable cases. */
export interface Suite {
  read(path: string): EvalCase[]
}

/** The suites `agw eval run|compare` know, by workflow id: a module's `suite`, `plain` or its own reader. */
export type Suites = ReadonlyMap<string, 'plain' | Suite>

/** `PlainCase` lines: no tree, the recorded input as is. */
export const plainSuite: Suite = {
  read: (path) =>
    readCases(path, PlainCase).map((c) => ({
      id: c.id,
      tree: null,
      setup: false,
      input: (_dir, args) => ({ ...(c.input as Record<string, Json>), ...args }),
      reference: c.reference,
    })),
}

/** The JSON object of the defined fields only: a case's optional input stays out rather than `undefined`. */
export const defined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Record<string, Json>

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
