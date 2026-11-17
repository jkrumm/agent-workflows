import type { Attributes } from '@opentelemetry/api'

/**
 * The resource of the gateway's spans and logs, per the ClickStack telemetry contract (the middleware's copy, `packages/middleware/src/resource.ts`):
 * `service.namespace` is `agw`, `deployment.environment.name` is `prod` for a deployed release and `dev` for a run no deploy started.
 */
export function resourceAttributes(options: {
  serviceName: string
  /** The deployed sha; absent or `dev` is a process that no deploy started. */
  version?: string
  /** `host.name`: the machine (`AGW_MACHINE`). Absent: the attribute is left off. */
  machine?: string
}): Attributes {
  const deployed = options.version !== undefined && options.version !== '' && options.version !== 'dev'
  return {
    'service.name': options.serviceName,
    'service.namespace': 'agw',
    'deployment.environment.name': deployed ? 'prod' : 'dev',
    ...(options.version ? { 'service.version': options.version } : {}),
    ...(options.machine ? { 'host.name': options.machine } : {}),
  }
}
