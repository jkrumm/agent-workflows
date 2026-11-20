import { type MaterializeInput, PlainCase, readCases } from '@agent-workflows/eval'
import type { Json } from '@agent-workflows/runtime'

// What a workflow module's eval suite is made of. Neutral ground: a module imports it without reaching into `eval/`.

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
  /** What the run's summary folds this case by under the arm's `args` (research: its depth); `summary.groups` stays empty without one. */
  group?(args: Record<string, Json>): string | undefined
}

/** A module's own case reader: the cases file at `path` as replayable cases. */
export interface Suite {
  /** The id of the workflow the suite replays, when it is not the module's own (a suite whose cases replay a workflow of another id). */
  workflow?: string
  /** Where the cases live; default `$AGW_EVAL_DIR/<workflow>/cases.jsonl`. */
  path?(env: Record<string, string | undefined>): string
  read(path: string): EvalCase[]
}

/** The suites `agw eval run|compare` know, by workflow id: a module's `suite`, `plain` or its own reader. */
export type Suites = ReadonlyMap<string, 'plain' | Suite>

/** The workflow a suite id replays: the suite's own `workflow`, else the id itself. */
export const suiteWorkflow = (suites: Suites, id: string): string => {
  const suite = suites.get(id)
  return typeof suite === 'object' && suite.workflow ? suite.workflow : id
}

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

/**
 * `PlainCase` lines grouped by the input's `depth` (research): `agw eval run` reports every figure per depth as well
 * as overall. A case without a depth runs at the workflow's default, `standard`.
 */
export const depthSuite: Suite = {
  read: (path) =>
    plainSuite.read(path).map((c) => ({
      ...c,
      group: (args) => {
        const depth = c.input('', args).depth
        return typeof depth === 'string' ? depth : 'standard'
      },
    })),
}

/** The JSON object of the defined fields only: a case's optional input stays out rather than `undefined`. */
export const defined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Record<string, Json>
