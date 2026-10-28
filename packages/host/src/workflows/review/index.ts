import type { HostWorkflow } from '../../operations.ts'
import type { WorkflowDeps } from '../index.ts'

/** The `review` workflows (concept §11 P1). Their agents live in `agents/review-<name>/`. */
export function createReviewWorkflows(_deps: WorkflowDeps): HostWorkflow[] {
  return []
}
