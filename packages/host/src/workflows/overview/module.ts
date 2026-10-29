import { defineWorkflowModule } from '../registry.ts'
import { createOverview } from './index.ts'

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
          }),
        ]
      : [],
})
