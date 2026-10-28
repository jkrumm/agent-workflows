import type { FingerprintSource } from '@agent-workflows/middleware'
import { learningsDigest } from './facts.ts'
import type { LearningsStore } from './store.ts'

/** The pseudo file an agent's active learnings enter the fingerprint as (concept §5: everything that changes behaviour). */
export const LEARNINGS_FINGERPRINT_FILE = 'learnings/active'

/**
 * Wraps the fingerprint source: each agent with active facts gets {@link LEARNINGS_FINGERPRINT_FILE} holding the digest
 * of its set, so activating or retiring a fact changes the fingerprint of every workflow that runs the agent, and an
 * agent without facts keeps the fingerprint it had before the store existed. Read at admission; a fact changed while a
 * run is in flight is picked up by the next run's fingerprint (the step itself reads at its prompt).
 */
export function withLearningsFingerprint(inner: FingerprintSource, store: LearningsStore): FingerprintSource {
  return {
    async inputs(workflow) {
      const base = await inner.inputs(workflow)
      const agents = await Promise.all(
        base.agents.map(async (agent) => {
          const digest = learningsDigest(await store.activeFor(agent.name))
          return digest ? { ...agent, files: { ...agent.files, [LEARNINGS_FINGERPRINT_FILE]: digest } } : agent
        }),
      )
      return { ...base, agents }
    },
  }
}
