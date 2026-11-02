import { defineWorkflowModule } from '../registry.ts'
import { createEvalMine } from './index.ts'
import type { LabelCaller } from './label.ts'

/**
 * `agw eval mine review`. `eval.label` is another branch's capability: until it lands the host registry's types do not
 * name it, and a labelling run fails at the first call as an unknown capability (mining alone works).
 */
export default defineWorkflowModule({
  id: 'eval-mine',
  create: (deps) => [createEvalMine({ registry: deps.registry as unknown as LabelCaller })],
})
