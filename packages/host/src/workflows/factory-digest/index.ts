import { digestIsEmpty, digestQuiet, guardDigest } from '@agent-workflows/capabilities'
import { defineWorkflow } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import { FactoryDigestInput, FactoryDigestOutput } from './schema.ts'

const FACTORY_DIGEST_WORKFLOW_ID = 'factory.digest'
const FACTORY_DIGEST_VERSION = '2026-11-12.1'

/** The one capability the workflow calls; any registry that has `factory.digest` fits. */
export type DigestCaller = Pick<HostRegistry, 'call'>

/**
 * `factory.digest` (`agw factory digest`): software-factory asks, every few hours per project, for a short summary of what
 * closed and what is next. One journaled step, one tool-free `factory.digest` call on its route; the answer is held to
 * `guardDigest` after the step (a bullet that cites an Issue the request did not show is dropped, every list cut to its
 * bound), so a replay gets it too. A project with no Issue in any list gets the quiet answer without a call. A failed call
 * fails the run: the factory asks again on its next cycle.
 */
export function createFactoryDigest(deps: { registry: DigestCaller }): HostWorkflow {
  const workflow = defineWorkflow({
    id: FACTORY_DIGEST_WORKFLOW_ID,
    version: FACTORY_DIGEST_VERSION,
    input: FactoryDigestInput,
    output: FactoryDigestOutput,
    async run(ctx, { input }) {
      if (digestIsEmpty(input)) return digestQuiet()
      const answer = await ctx.step('digest', ({ callContext }) =>
        deps.registry.call('factory.digest', input, callContext),
      )
      return guardDigest(answer, input)
    },
  })
  return {
    workflow,
    summary:
      "Summarise a project's recently closed, running and queued Issues into a headline, shipped, next and risks; the request JSON comes on stdin or `--input <file>`",
    cli: { stdin: 'input', defaultFormat: 'json' },
  }
}
