import { defineWorkflow } from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../operations.ts'
import { type Learning, LEARNING_STATUSES, type LearningsStore, MAX_FACT_CHARS } from './store.ts'

const LearningSchema = z.object({
  id: z.number().int(),
  agent: z.string(),
  fact: z.string(),
  source: z.string(),
  sources: z.array(z.string()),
  evidence: z.array(z.string()),
  weeks: z.array(z.string()),
  status: z.enum(LEARNING_STATUSES),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  activatedAt: z.string().nullable(),
  retiredAt: z.string().nullable(),
})

const VERSION = '2026-11-16.1'
const AGENT_NAME = z.string().regex(/^[a-z][a-z0-9-]*$/, 'an agent definition name, e.g. review-senior-dev')

/**
 * `agw learnings list|add|activate|retire|tidy` (concept §7): the per-agent learned facts. Each is a one-step workflow, so
 * the command appears in the generated CLI with the platform's contract, and a change to the store (who retired
 * what, when) leaves a run record. A retrospective proposes; a fact it proposes again in a later week activates (`tidy`
 * applies that rule, and the stale-fact retirement, to what is on file); a human can always activate or retire, and
 * retire reaches the next run of the agent at once.
 */
export function createLearningsWorkflows(store: LearningsStore): HostWorkflow[] {
  const one = z.object({ learning: LearningSchema })
  const toJson = (learning: Learning) => ({ ...learning })

  const list = defineWorkflow({
    id: 'learnings.list',
    version: VERSION,
    input: z.object({
      agent: AGENT_NAME.optional().describe('Only this agent'),
      status: z.enum(LEARNING_STATUSES).optional().describe('Only this status'),
      limit: z.number().int().min(1).max(500).default(100).describe('Newest first'),
    }),
    output: z.object({ learnings: z.array(LearningSchema) }),
    async run(ctx, input) {
      const learnings = await ctx.step('list', async () => (await store.list(input)).map(toJson))
      return { learnings }
    },
  })

  const add = defineWorkflow({
    id: 'learnings.add',
    version: VERSION,
    input: z.object({
      agent: AGENT_NAME.describe('The agent that reads the fact back on its next run'),
      fact: z.string().trim().min(1).max(MAX_FACT_CHARS).describe('One self-contained observation'),
      activate: z.boolean().default(false).describe('Read back from the next run on; default only proposes'),
    }),
    output: one,
    async run(ctx, input) {
      const learning = await ctx.step('add', async () =>
        toJson(
          (
            await store.add({
              agent: input.agent,
              fact: input.fact,
              source: 'manual',
              status: input.activate ? 'active' : 'proposed',
            })
          ).learning,
        ),
      )
      return { learning }
    },
  })

  const byId = (id: 'learnings.activate' | 'learnings.retire', act: (id: number) => Promise<Learning>) =>
    defineWorkflow({
      id,
      version: VERSION,
      input: z.object({ id: z.number().int().positive().describe('The learning id (`agw learnings list`)') }),
      output: one,
      async run(ctx, input) {
        const learning = await ctx.step('apply', async () => toJson(await act(input.id)))
        return { learning }
      },
    })

  const tidy = defineWorkflow({
    id: 'learnings.tidy',
    version: VERSION,
    input: z.object({}).strict(),
    output: z.object({
      merged: z.number().int().describe('Proposed duplicates folded into the fact they repeat'),
      activated: z.array(LearningSchema),
      retired: z.array(LearningSchema),
    }),
    async run(ctx) {
      return ctx.step('tidy', async () => {
        const report = await store.tidy()
        return { merged: report.merged, activated: report.activated.map(toJson), retired: report.retired.map(toJson) }
      })
    },
  })

  return [
    { workflow: list, summary: 'List the per-agent learned facts', cli: { defaultFormat: 'json' } },
    {
      workflow: add,
      summary: 'Propose (or with --activate, activate) a learned fact for an agent',
      cli: { mutating: true },
    },
    {
      workflow: byId('learnings.activate', (id) => store.activate(id)),
      summary: 'Activate a proposed fact: the agent reads it back from its next run',
      cli: { positional: ['id'], mutating: true },
    },
    {
      workflow: tidy,
      summary: 'Apply the learnings rule: fold repeated proposals, activate facts seen in two weeks, retire stale ones',
      cli: { mutating: true },
    },
    {
      workflow: byId('learnings.retire', (id) => store.retire(id)),
      summary: 'Retire a fact: effective on the next run of the agent',
      cli: { positional: ['id'], mutating: true },
    },
  ]
}
