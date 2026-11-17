import type { Attributes } from '@opentelemetry/api'

export type ResourceOptions = {
  /** `service.name`. */
  serviceName: string
  /** `service.version`: the deployed sha. Absent or `dev` is a process that no deploy started. */
  version?: string
  /** `host.name`: the machine (`AGW_MACHINE`, `mini` on the mini). Absent: the attribute is left off. */
  machine?: string
}

/**
 * The resource of a process's spans and logs, per the ClickStack telemetry contract: `service.namespace` is `agw`,
 * `deployment.environment.name` is `prod` for a deployed release and `dev` for a run no deploy started.
 */
export function resourceAttributes(options: ResourceOptions): Attributes {
  const deployed = options.version !== undefined && options.version !== '' && options.version !== 'dev'
  return {
    'service.name': options.serviceName,
    'service.namespace': 'agw',
    'deployment.environment.name': deployed ? 'prod' : 'dev',
    ...(options.version ? { 'service.version': options.version } : {}),
    ...(options.machine ? { 'host.name': options.machine } : {}),
  }
}
