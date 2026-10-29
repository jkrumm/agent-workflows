import { defineWorkflow } from '@agent-workflows/runtime'
import { z } from 'zod'
import { defineWorkflowModule } from '../../../../../src/workflows/registry.ts'

export default defineWorkflowModule({
  id: 'not-y',
  create: () => [
    {
      workflow: defineWorkflow({
        id: 'y',
        version: 'v1',
        input: z.object({}),
        output: z.object({}),
        run: async () => ({}),
      }),
      agents: [{ agent: 'y', route: 'alpha.agent' as never }],
    },
  ],
})
