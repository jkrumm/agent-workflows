import { defineWorkflowModule } from '@agent-workflows/host'
import { createAudioPing } from './index.ts'

export default defineWorkflowModule({ id: 'ping', create: () => [createAudioPing()] })
