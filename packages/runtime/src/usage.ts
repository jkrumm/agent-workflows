import type { ModelUsage, StepUsage, TokenCounts, Usage } from './types.ts'

const zeroTokens = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })

function emptyModelUsage(): ModelUsage {
  return { tokens: zeroTokens(), cost: null, toolCalls: 0, unpricedCalls: 0 }
}

function addInto(target: ModelUsage, usage: Usage) {
  target.tokens.input += usage.tokens.input
  target.tokens.output += usage.tokens.output
  target.tokens.cacheRead += usage.tokens.cacheRead
  target.tokens.cacheWrite += usage.tokens.cacheWrite ?? 0
  target.tokens.reasoning += usage.tokens.reasoning
  if (usage.cost === undefined || usage.cost === null) target.unpricedCalls++
  else target.cost = (target.cost ?? 0) + usage.cost
  target.toolCalls += usage.toolCalls ?? 0
}

const hasReports = (usage: StepUsage) =>
  usage.unpricedCalls > 0 ||
  usage.toolCalls > 0 ||
  Object.keys(usage.byModel).length > 0 ||
  Object.values(usage.tokens).some((count) => count > 0)

/**
 * The cost a finished step records. A step that ended `done` with no report is free (0); one that failed or was
 * cancelled without a report may have sent a billed call whose usage never came back, so its cost is unknown (null),
 * as for a step cancelled by `cancelRunningSteps`. "No report" is read from the totals: a priced-zero report with
 * no tokens, calls or model is indistinguishable from none.
 */
export function recordedCost(status: 'done' | 'failed' | 'cancelled', usage: StepUsage): number | null {
  if (status === 'done' || usage.cost !== 0 || hasReports(usage)) return usage.cost
  return null
}

/** Sums every `addUsage` of one step execution. */
export class UsageTotals {
  private total = emptyModelUsage()
  private reports = 0
  private byModel: Record<string, ModelUsage> = {}
  private routes = new Set<string>()

  add(usage: Usage) {
    this.reports++
    addInto(this.total, usage)
    if (usage.route) this.routes.add(usage.route)
    if (!usage.model) return
    this.byModel[usage.model] ??= emptyModelUsage()
    addInto(this.byModel[usage.model] as ModelUsage, usage)
  }

  /** The single model when exactly one reported, else null. */
  model(): string | null {
    const models = Object.keys(this.byModel)
    return models.length === 1 ? (models[0] ?? null) : null
  }

  /** The single route when exactly one reported, else null. */
  route(): string | null {
    return this.routes.size === 1 ? ([...this.routes][0] ?? null) : null
  }

  /**
   * A step that reported nothing is free (cost 0) here; `recordedCost` makes it unknown when the step did not end
   * done. Null is a step whose every report was unpriced.
   * A model's own entry always has a report, so its null stays "unpriced".
   */
  snapshot(): StepUsage {
    const cost = this.reports === 0 ? 0 : this.total.cost
    return structuredClone({ ...this.total, cost, byModel: this.byModel, route: this.route() })
  }
}
