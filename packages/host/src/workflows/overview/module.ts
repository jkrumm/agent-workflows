import { join } from 'node:path'
import { defineWorkflowModule } from '../registry.ts'
import { createOverview } from './index.ts'

/**
 * The eval set, committed beside the module: synthetic fleets (placeholder project names, no real session text), each
 * run as the `fixture` input. Not yet registered as the module's `suite`: `buildWorkflows` refuses a suite on a host
 * that serves no `overview` (no fleet), which `createWorkflows({ registry, toolGate })` is.
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
})
