import { defineWorkflow } from '@agent-workflows/runtime'
import { z } from 'zod'
import { defineWorkflowModule } from '../../../../../../src/workflows/registry.ts'

export default defineWorkflowModule({
  id: 'alpha',
  create: () => [
    {
      workflow: defineWorkflow({
        id: 'alpha',
        version: 'v1',
        input: z.object({}),
        output: z.object({}),
        run: async () => ({}),
      }),
      agents: [{ agent: 'alpha', route: 'alpha.agent' as never }],
    },
  ],
  suite: 'plain',
})
