import { defineWorkflowModule } from '../registry.ts'
import { createEvalMine } from './index.ts'

/** `agw eval mine review`: mining reads git; labelling calls `eval.label` through the host registry. */
export default defineWorkflowModule({
  id: 'eval-mine',
  create: (deps) => [createEvalMine({ registry: deps.registry })],
})
