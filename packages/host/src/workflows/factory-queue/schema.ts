import { factoryQueueInput, factoryQueueOutput } from '@agent-workflows/capabilities'
import { z } from 'zod'

/** The workflow's input: the queue is one property because the CLI reads exactly one property from stdin. */
export const FactoryQueueInput = z.object({
  queue: factoryQueueInput.describe(
    "A repo's open Issues with their priority, age and `after` edges, piped on stdin as JSON",
  ),
})

/** The answer: proposed `after` edges and an order for the queued Issues. Only Issues the request showed; the owner's priority stands. */
export const FactoryQueueOutput = factoryQueueOutput
export type FactoryQueueOutputValue = z.output<typeof FactoryQueueOutput>
