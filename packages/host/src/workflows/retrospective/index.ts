import { type Ctx, defineWorkflow, StepFailed, WorkflowError } from '@agent-workflows/runtime'
import type { LearningsStore } from '../../learnings/index.ts'
import type { HostWorkflow } from '../../operations.ts'
import type { GhPort } from './gh.ts'
import type { TrackedPaths } from './tracked.ts'
import { issueFor } from './issue.ts'
import { checkAnalysis } from './normalize.ts'
import { JSON_ONLY_RETRY, retroPrompt } from './prompt.ts'
import type { JournalReader, SampledRun } from './sample.ts'
import { RETRO_ANALYSIS, RETRO_INPUT, RETRO_OUTPUT, type RetroAnalysis, type RetroOutput } from './schema.ts'

export const RETRO_WORKFLOW_ID = 'retrospective'
export const RETRO_AGENT = 'retrospective'
const DAY_MS = 86_400_000

export interface RetrospectiveDeps {
  journal: JournalReader
  learnings: LearningsStore
  /** The agent names a hosted workflow runs, or undefined for a workflow that runs none (or does not exist). */
  agentsOf(workflow: string): readonly string[] | undefined
  /** The GitHub port. A run with `fileIssues` fails fast without one. */
  gh?: GhPort
  /** The paths tracked in this repository (what the deploy ships); an issue may name only these. Read when issues are filed. */
  tracked?: () => Promise<TrackedPaths>
  now?: () => Date
}

const isInvalidOutput = (error: unknown) => error instanceof StepFailed && error.stepKind === 'invalid_output'

/** One agent step and one retry with a JSON-only directive, like `check`; two invalid answers fail the run. */
async function analyze(ctx: Ctx, prompt: string): Promise<RetroAnalysis> {
  const spec = { agent: RETRO_AGENT, output: RETRO_ANALYSIS, options: { output: 'json' } }
  try {
    return await ctx.agent('analyze', { ...spec, prompt })
  } catch (error) {
    if (!isInvalidOutput(error)) throw error
  }
  // `tail`: learned facts are inserted before the directive, which stays the last thing the agent reads.
  return ctx.agent('analyze-retry', { ...spec, prompt, tail: JSON_ONLY_RETRY })
}

/**
 * `retrospective` (concept §7 tier 2): looks back on one workflow's recent finished runs and proposes. Proposals are
 * never applied: they come back as typed output and, when asked, as GitHub issues; learned facts are stored as
 * `proposed` and take effect only when a human activates them. No agent step runs when there is nothing to read.
 */
export function createRetrospective(deps: RetrospectiveDeps): HostWorkflow {
  const now = deps.now ?? (() => new Date())
  const workflow = defineWorkflow({
    id: RETRO_WORKFLOW_ID,
    version: '2026-10-28.1',
    input: RETRO_INPUT,
    output: RETRO_OUTPUT,
    // The weekly schedule starts one run per workflow; the agent step is the only spend.
    concurrency: 2,
    async run(ctx, input): Promise<RetroOutput> {
      const agents = deps.agentsOf(input.workflow)
      if (!agents || agents.length === 0) {
        throw new WorkflowError('invalid_input', `${input.workflow} is not a workflow that runs agents`)
      }
      if (input.fileIssues && !(deps.gh && deps.tracked)) {
        throw new WorkflowError('invalid_input', 'fileIssues is on but this host has no issue repository configured')
      }
      const empty = {
        workflow: input.workflow,
        windowDays: input.window,
        sampled: 0,
        proposals: [],
        learnings: [],
        issues: [],
        dropped: [],
      }

      const runs: SampledRun[] = await ctx.step('sample', async () => {
        const since = new Date(now().getTime() - input.window * DAY_MS)
        return JSON.parse(
          JSON.stringify(await deps.journal.sample({ workflow: input.workflow, since, limit: input.sample })),
        )
      })
      if (runs.length === 0) return empty

      const analysis = await analyze(
        ctx,
        retroPrompt({ workflow: input.workflow, windowDays: input.window, agents, runs }),
      )
      const checked = checkAnalysis({
        analysis,
        sampled: new Set(runs.map((r) => r.runId)),
        agents,
      })

      // Proposed, never active: a retrospective cannot change an agent's behaviour by itself.
      const learnings = await ctx.effect('store-learnings', async () => {
        const stored: RetroOutput['learnings'] = []
        for (const l of checked.learnings) {
          const { learning, created } = await deps.learnings.add({
            agent: l.agent,
            fact: l.fact,
            source: ctx.runId,
            evidence: l.evidence,
          })
          stored.push({ ...l, learningId: created ? learning.id : null })
        }
        return stored
      })

      const issues: RetroOutput['issues'] = input.fileIssues
        ? await ctx.effect('file-issues', async () => {
            const { gh, tracked } = deps
            if (!gh || !tracked) throw new WorkflowError('invalid_input', 'no issue repository configured')
            const paths = await tracked()
            const filed: RetroOutput['issues'] = []
            const seen = new Set<string>()
            for (const proposal of checked.proposals) {
              const draft = issueFor({
                workflow: input.workflow,
                retroRunId: ctx.runId,
                proposal,
                agents,
                tracked: paths,
              })
              if (!draft.ok) {
                filed.push({ hash: draft.hash, status: 'refused', reason: draft.reason })
                continue
              }
              // Dedupe by the proposal hash in the issue body: a rerun, a resumed effect and a proposal repeated next
              // week all land here. The search index lags a new issue (gh.ts), so a repeat in that window can slip through.
              const existing = seen.has(draft.hash) ? { url: undefined } : await gh.findByHash(draft.hash)
              seen.add(draft.hash)
              if (existing) {
                filed.push({
                  hash: draft.hash,
                  title: draft.title,
                  status: 'duplicate',
                  ...(existing.url ? { url: existing.url } : {}),
                })
                continue
              }
              const created = await gh.create({ title: draft.title, body: draft.body })
              filed.push({ hash: draft.hash, title: draft.title, status: 'filed', url: created.url })
            }
            return filed
          })
        : []

      return {
        workflow: input.workflow,
        windowDays: input.window,
        sampled: runs.length,
        proposals: checked.proposals,
        learnings,
        issues,
        dropped: checked.dropped,
      }
    },
  })
  return {
    workflow,
    summary: 'Weekly look back on a workflow: proposals (never applied) and proposed learned facts',
    cli: { positional: ['workflow'], mutating: true },
    agents: [{ agent: RETRO_AGENT, route: 'retro.analyze' }],
  }
}
