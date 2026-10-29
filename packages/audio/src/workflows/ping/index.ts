import type { HostWorkflow } from '@agent-workflows/host'
import { defineWorkflow } from '@agent-workflows/runtime'
import { z } from 'zod'

/**
 * The audio process's smoke test: one code step, no model, no cost. `make verify` runs it as `agw audio ping` to prove
 * the process records a run end to end (HTTP, journal, run record) without spending anything.
 */
export function createAudioPing(): HostWorkflow {
  const workflow = defineWorkflow({
    id: 'audio.ping',
    version: '2026-10-29.1',
    input: z.object({}),
    output: z.object({ process: z.literal('audio'), pong: z.literal(true) }),
    async run(ctx) {
      return ctx.step('pong', () => ({ process: 'audio' as const, pong: true as const }))
    },
  })
  return { workflow, summary: 'Answer pong from the audio process; its end-to-end smoke test, no model, no cost' }
}
