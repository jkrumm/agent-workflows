import { defineWorkflow } from '@agent-workflows/runtime'
import { z } from 'zod'
import { defineWorkflowModule } from '../../../../../src/workflows/registry.ts'

export default defineWorkflowModule({
  id: 'ghost',
  create: () => [
    {
      workflow: defineWorkflow({
        id: 'ghost',
        version: 'v1',
        input: z.object({}),
        output: z.object({}),
        run: async () => ({}),
      }),
      agents: [{ agent: 'ghost', route: 'ghost.agent' as never }],
    },
  ],
})
