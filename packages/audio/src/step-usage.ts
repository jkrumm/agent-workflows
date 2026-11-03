import type { Usage } from '@agent-workflows/runtime'
import type { UsagePort } from './usage.ts'

/**
 * The audio scope's call events as a run step's usage: the journal records the cost (and projects it to Argo). Shared by
 * every workflow that calls the lanes in-process (`podcast.produce`, `speech-roundtrip`).
 */
export function stepUsage(addUsage: (usage: Usage) => void): UsagePort {
  return {
    record(event) {
      if (event.kind !== 'call') return
      const notBilled = event.costSource === 'not-billed'
      addUsage({
        model: event.model,
        tokens: {
          input: event.inputTokens ?? 0,
          output: event.outputTokens ?? 0,
          cacheRead: event.cachedTokens ?? 0,
          reasoning: 0,
        },
        cost: notBilled ? 0 : event.costUsd,
        costSource: event.costSource === 'provider' || event.costSource === 'unknown' ? event.costSource : 'rate',
      })
    },
  }
}
