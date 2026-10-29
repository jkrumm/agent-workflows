import { defineWorkflow } from '@agent-workflows/runtime'
import { z } from 'zod'
import { defineWorkflowModule } from '../../../../../src/workflows/registry.ts'

export default defineWorkflowModule({
  id: 'a',
  create: () => [
    {
      workflow: defineWorkflow({
        id: 'same',
        version: 'v1',
        input: z.object({}),
        output: z.object({}),
        run: async () => ({}),
      }),
      agents: [{ agent: 'same', route: 'alpha.agent' as never }],
    },
  ],
})
