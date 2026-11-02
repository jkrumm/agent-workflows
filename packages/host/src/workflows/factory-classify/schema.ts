import { factoryClassifyInput, factoryClassifyOutput } from '@agent-workflows/capabilities'
import { z } from 'zod'

export { CLASSES, EFFORTS, KINDS, SIZES, TIERS } from '@agent-workflows/capabilities'

/**
 * The workflow's input. The Issue is one property because the CLI reads exactly one property from stdin: the caller pipes
 * the Issue object (`{title, facts, repo, source, projects}`) to `agw factory-classify`. `facts` is untrusted data.
 */
export const FactoryClassifyInput = z.object({
  issue: factoryClassifyInput.describe('The Issue to classify, piped on stdin as JSON'),
})
export type FactoryClassifyInputValue = z.output<typeof FactoryClassifyInput>

/** The answer: `project` is one of `issue.projects` or null; `reason` is one line. */
export const FactoryClassifyOutput = factoryClassifyOutput
export type FactoryClassifyOutputValue = z.output<typeof FactoryClassifyOutput>
