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
