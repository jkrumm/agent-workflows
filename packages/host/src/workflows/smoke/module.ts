import { gatewayTransports } from '@agent-workflows/capabilities'
import { defineWorkflowModule } from '../registry.ts'
import { createSmokePing } from './index.ts'
import { createSmokeRoute } from './route.ts'

/** `attempts: 1`: `smoke.route` is one billed call, so the transport does not retry it. */
export default defineWorkflowModule({
  id: 'smoke',
  create: (deps) => [
    createSmokePing(deps.registry),
    createSmokeRoute({ transports: gatewayTransports({ attempts: 1 }) }),
  ],
})
