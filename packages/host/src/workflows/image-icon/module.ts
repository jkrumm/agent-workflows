// fallow-ignore-file unused-file -- discovered by `Bun.Glob('*/module.ts')` at boot, which static analysis cannot see.
import { defineWorkflowModule } from '../registry.ts'
import { createImageIconWorkflows } from './index.ts'

export default defineWorkflowModule({ id: 'image-icon', create: (deps) => createImageIconWorkflows(deps) })
