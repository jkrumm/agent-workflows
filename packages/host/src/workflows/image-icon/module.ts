// fallow-ignore-file unused-file -- discovered by `Bun.Glob('*/module.ts')` at boot, which static analysis cannot see.
import { join } from 'node:path'
import { PlainCase, readCases } from '@agent-workflows/eval'
import type { Json } from '@agent-workflows/runtime'
import { defineWorkflowModule } from '../registry.ts'
import type { EvalCase, Suite } from '../suite.ts'
import { createImageIconWorkflows } from './index.ts'

/** The eval set is committed beside the module: synthetic master images (`eval/generate.ts`) and `eval/cases.jsonl`. */
export const EVAL_DIR = join(import.meta.dir, 'eval')
export const CASES_PATH = join(EVAL_DIR, 'cases.jsonl')

/**
 * `PlainCase` lines whose `file` is a name in `eval/`: the workflow wants an absolute path, which depends on where the
 * release lives, so the reader makes it one. A `--args` file still wins.
 */
export const imageIconSuite: Suite = {
  path: () => CASES_PATH,
  read: (path): EvalCase[] =>
    readCases(path, PlainCase).map((c) => ({
      id: c.id,
      tree: null,
      setup: false,
      input: (_dir, args) => ({
        ...(c.input as Record<string, Json>),
        file: join(EVAL_DIR, String(c.input.file)),
        ...args,
      }),
      reference: c.reference,
    })),
}

export default defineWorkflowModule({
  id: 'image-icon',
  create: (deps) => createImageIconWorkflows(deps),
  suite: imageIconSuite,
})
