import type { HostWorkflow } from '../../operations.ts'
import type { WorkflowDeps } from '../index.ts'

/** The `check` workflows (concept §11 P1). Their agents live in `agents/check-<name>/`. */
export function createCheckWorkflows(_deps: WorkflowDeps): HostWorkflow[] {
  return []
}
