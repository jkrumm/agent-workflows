import { defineWorkflowModule } from '../registry.ts'
import { createSmokePing } from './index.ts'

export default defineWorkflowModule({ id: 'smoke', create: (deps) => [createSmokePing(deps.registry)] })
