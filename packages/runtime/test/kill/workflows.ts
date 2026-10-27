// The kill-harness workflow: prepare → agent → (audit, v2-break only) → effect → fan-out of 3 → finish.
import { z } from 'zod'
import { defineWorkflow } from '../../src/index.ts'
import type { World } from './world.ts'

export type Variant = { version: string; withAudit: boolean; effectWindowMs: number; childMs: number }

export function killWorkflows(world: World | null, variant: Variant) {
  const w = () => {
    if (!world) throw new Error('this process only starts runs')
    return world
  }
  const child = defineWorkflow({
    id: 'kill.child',
    version: variant.version,
    input: z.object({ i: z.number() }),
    output: z.object({ child: z.number(), value: z.number() }),
    async run(ctx, { i }) {
      return ctx.step('work', async () => {
        await w().probe(ctx.runId, 'work', 'start')
        await Bun.sleep(variant.childMs)
        if (i === 1) throw new Error('child 1 fails by design')
        await w().probe(ctx.runId, 'work', 'end')
        return { child: i, value: i * 10 }
      })
    },
  })

  const main = defineWorkflow({
    id: 'kill.main',
    version: variant.version,
    input: z.object({}),
    output: z.object({
      version: z.string(),
      n: z.number(),
      answer: z.string(),
      children: z.array(z.object({ child: z.number(), value: z.number() }).nullable()),
    }),
    async run(ctx) {
      const prepared = await ctx.step('prepare', async () => {
        await w().probe(ctx.runId, 'prepare', 'start')
        const out = { n: 21 }
        await w().probe(ctx.runId, 'prepare', 'end')
        return out
      })
      const answer = await ctx.agent('agent', { agent: 'fake', prompt: 'think', output: z.string() })
      if (variant.withAudit) {
        await ctx.step('audit', async () => {
          await w().probe(ctx.runId, 'audit', 'start')
          await w().probe(ctx.runId, 'audit', 'end')
          return { audited: true }
        })
      }
      await ctx.effect('effect', async (key) => {
        await w().probe(ctx.runId, 'effect', 'start')
        const outcome = await w().effect(ctx.runId, key)
        await w().probe(ctx.runId, 'effect', 'committed')
        await Bun.sleep(variant.effectWindowMs) // the in-doubt window: committed outside, not yet journaled
        await w().probe(ctx.runId, 'effect', 'end')
        return { outcome }
      })
      const children = await ctx.workflow('fanout', child, [{ i: 0 }, { i: 1 }, { i: 2 }])
      return ctx.step('finish', async () => {
        await w().probe(ctx.runId, 'finish', 'start')
        const result = { version: variant.version, n: prepared.n * 2, answer, children }
        await w().probe(ctx.runId, 'finish', 'end')
        return result
      })
    },
  })
  return { main, child }
}
