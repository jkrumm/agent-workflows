import { gatewayTransports } from '@agent-workflows/capabilities'
import { defineWorkflowModule } from '../registry.ts'
import { createSmokePing } from './index.ts'
import { createSmokeRoute } from './route.ts'

export default defineWorkflowModule({
  id: 'smoke',
  create: (deps) => [createSmokePing(deps.registry), createSmokeRoute({ transports: gatewayTransports() })],
})
