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

/** Sums every `addUsage` of one step execution. */
export class UsageTotals {
  private total = emptyModelUsage()
  private byModel: Record<string, ModelUsage> = {}
  private routes = new Set<string>()

  add(usage: Usage) {
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

  snapshot(): StepUsage {
    return structuredClone({ ...this.total, byModel: this.byModel, route: this.route() })
  }
}
