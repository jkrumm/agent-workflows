import { defineWorkflowModule } from '../../../../../src/workflows/registry.ts'
import { farWorkflow } from '../../shell.ts'

export default defineWorkflowModule({
  id: 'a',
  create: () => {
    throw new Error('create must never run for a foreign module')
  },
  foreign: () => [farWorkflow('shared')],
})
