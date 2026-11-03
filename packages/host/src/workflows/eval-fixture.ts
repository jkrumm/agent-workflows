import { WorkflowError } from '@agent-workflows/runtime'

/**
 * Refuses a fixture input for a run that is not an eval. A fixture replaces the live source a workflow reads (the
 * fleet, git, the journal) with made-up facts, so a prod run given one by hand would write fabricated results where
 * callers read real ones (`agw agents` serves the newest prod `overview` run). The step's attribution carries the
 * run's purpose; without one the run is refused too.
 */
export function requireEvalPurpose(callContext: { attribution?: { purpose: string } }, workflow: string): void {
  const purpose = callContext.attribution?.purpose
  if (purpose === 'eval') return
  throw new WorkflowError(
    'invalid_input',
    `${workflow}: fixture is an eval-only input, refused for a run with purpose "${purpose ?? 'unknown'}"`,
  )
}
