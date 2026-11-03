import { defineWorkflowModule } from '../../../../../src/workflows/registry.ts'
import { farWorkflow } from '../../shell.ts'

export default defineWorkflowModule({
  id: 'far',
  create: () => {
    throw new Error('create must never run for a foreign module')
  },
  foreign: () => [farWorkflow('far')],
  suite: 'plain',
})
