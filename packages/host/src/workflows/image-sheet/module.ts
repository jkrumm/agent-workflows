import { defineWorkflowModule } from '../registry.ts'
import { createImageSheetWorkflows } from './index.ts'

export default defineWorkflowModule({
  id: 'image-sheet',
  create: () => createImageSheetWorkflows(),
})
