import { defineWorkflowModule } from '../registry.ts'
import { createProsePolish } from '../prose-polish/index.ts'
import { createNarrative } from './index.ts'

export default defineWorkflowModule({
  id: 'narrative',
  // The polish child is a private instance: `prose-polish`'s own module registers the public one under the same id.
  create: (deps) => [
    createNarrative({ registry: deps.registry, polish: createProsePolish({ registry: deps.registry }).workflow }),
  ],
})
