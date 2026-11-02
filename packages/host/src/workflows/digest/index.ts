import { defineWorkflow } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import { digestScorer } from './scorer.ts'
import { DigestInput, DigestOutput } from './schema.ts'

export const DIGEST_WORKFLOW_ID = 'digest'
export const DIGEST_VERSION = '2026-11-02.1'

/** The one capability the workflow calls; any registry that has `digest.items` fits. */
export type DigestCaller = Pick<HostRegistry, 'call'>

/**
 * `digest`: short texts for a batch of items. One journaled step, one tool-free `digest.items` call on its route; the
 * answer is schema-checked per item, so an item that fails comes back as `{id, error}` and the rest stand. The items are
 * fenced as data inside the capability. The journal keeps the step's result and usage (cost, tokens, model) and the run
 * its input and timings, so a resumed run reads the answer back and never asks twice.
 */
export function createDigest(deps: { registry: DigestCaller }): HostWorkflow {
  const workflow = defineWorkflow({
    id: DIGEST_WORKFLOW_ID,
    version: DIGEST_VERSION,
    input: DigestInput,
    output: DigestOutput,
    scorer: digestScorer,
    async run(ctx, input) {
      return ctx.step('digest', ({ callContext }) => deps.registry.call('digest.items', input, callContext))
    },
  })
  return {
    workflow,
    summary:
      'Short texts for a batch of up to 64 items (heading, session, reply, window): a short, a headline, an ask check or a paragraph by kind, in one call',
    cli: { stdin: 'items', defaultFormat: 'json' },
  }
}
