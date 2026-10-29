import type { CallOptions } from '@agent-workflows/capabilities'
import { defineWorkflow } from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'

export const SMOKE_TEXT = 'The host answers a smoke test: one workflow, one code step, one capability call.'

/** The one capability the smoke workflow calls; any registry that has `llm.title` fits. */
export interface TitleCaller {
  call(id: 'llm.title', input: { text: string }, options?: CallOptions): Promise<{ title: string }>
}

/**
 * The smallest workflow that exercises the whole path: HTTP, journal, a capability call through the registry and
 * priced usage on the step (so the run reaches Argo). `make verify` and the live proof run it as `agw smoke ping`.
 */
export function createSmokePing(registry: TitleCaller): HostWorkflow {
  const workflow = defineWorkflow({
    id: 'smoke.ping',
    version: '2026-10-28.1',
    input: z.object({ text: z.string().min(1).default(SMOKE_TEXT).describe('The text to title') }),
    output: z.object({ title: z.string() }),
    async run(ctx, { text }) {
      const { title } = await ctx.step('title', ({ addUsage, signal }) =>
        registry.call('llm.title', { text }, { addUsage, signal }),
      )
      return { title }
    },
  })
  return {
    workflow,
    summary: 'Title a sentence through llm.title; the end-to-end smoke test',
    cli: { positional: ['text'] },
  }
}
