import { join } from 'node:path'
import { defineWorkflowModule } from '../registry.ts'
import { plainSuite } from '../suite.ts'
import { createOverview } from './index.ts'

/**
 * The eval set, committed beside the module: synthetic fleets (placeholder project names, no real session text), each
 * run as the `fixture` input. A host without a fleet serves no `overview` and still lists the suite: the registry
 * allows a suite on a module that built nothing there.
 */
export const CASES_PATH = join(import.meta.dir, 'eval', 'cases.jsonl')

/** A host without a fleet (the audio process, a test host) serves no `overview`. */
export default defineWorkflowModule({
  id: 'overview',
  create: (deps) =>
    deps.fleet
      ? [
          createOverview({
            registry: deps.registry,
            fleet: deps.fleet.fleet,
            argo: deps.fleet.argo,
            purposeOf: deps.fleet.purposeOf,
            warn: (message, meta) => deps.logger?.warn(message, meta),
          }),
        ]
      : [],
  suite: { read: () => plainSuite.read(CASES_PATH) },
})
