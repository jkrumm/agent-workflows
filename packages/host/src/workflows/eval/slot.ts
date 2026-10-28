import type { AnyWorkflow, Runtime } from '@agent-workflows/runtime'

/** What the eval workflows reach at run time: the runtime (set at boot, after it exists) and the workflows they replay. */
export type EvalRuntime = Pick<Runtime, 'start' | 'wait' | 'cancel' | 'scoreRun' | 'scoredRuns' | 'recentCost'>

export class EvalSlot {
  runtime: EvalRuntime | null = null
  readonly targets = new Map<string, AnyWorkflow>()

  get(): EvalRuntime {
    if (!this.runtime) throw new Error('eval workflows are not bound to a runtime (wireEval)')
    return this.runtime
  }

  target(id: string): AnyWorkflow {
    const workflow = this.targets.get(id)
    if (!workflow?.scorer) throw new Error(`workflow ${id} is not served here or has no scorer`)
    return workflow
  }
}
