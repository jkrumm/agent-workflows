import { join } from 'node:path'
import { PlainCase, readCases } from '@agent-workflows/eval'
import type { Json } from '@agent-workflows/runtime'
import { defineWorkflowModule } from '../registry.ts'
import type { EvalCase, Suite } from '../suite.ts'
import { createFactoryHygiene } from './index.ts'

/** The eval set and the checkout it runs on are committed beside the module: public placeholder material (example-queue). */
export const CASES_PATH = join(import.meta.dir, 'eval', 'cases.jsonl')
export const FIXTURE_DIR = join(import.meta.dir, 'eval', 'fixture')
/** The `ref` of every case: the fixture is not a git checkout, so this is a placeholder sha. */
export const FIXTURE_REF = '3f9c2ab41d7e'

/** `PlainCase` lines whose `hygiene.cwd` and `ref` are filled at run time: `cwd` is the absolute path of this release. */
export const hygieneSuite: Suite = {
  read: (path): EvalCase[] =>
    readCases(path, PlainCase).map((c) => ({
      id: c.id,
      tree: null,
      setup: false,
      input: (_dir, args) => {
        const { hygiene } = c.input as { hygiene: Record<string, Json> }
        return { hygiene: { ...hygiene, cwd: FIXTURE_DIR, ref: FIXTURE_REF }, ...args }
      },
      reference: c.reference,
    })),
}

/** `suite`: the three cases of `eval/cases.jsonl` over `eval/fixture`; the guard bounds what the agent can say. */
export default defineWorkflowModule({
  id: 'factory-hygiene',
  create: () => [createFactoryHygiene()],
  suite: { read: () => hygieneSuite.read(CASES_PATH) },
})
