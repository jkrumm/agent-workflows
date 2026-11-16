import { type Ctx, defineWorkflow, type Json, StepFailed, WorkflowError } from '@agent-workflows/runtime'
import type { LearningsStore } from '../../learnings/index.ts'
import type { HostWorkflow } from '../../operations.ts'
import { requireEvalPurpose } from '../eval-fixture.ts'
import type { TrackedPaths } from './tracked.ts'
import { checkAnalysis } from './normalize.ts'
import { SUBMIT_RESULT_RETRY, retroPrompt } from './prompt.ts'
import type { JournalReader, SampledRun } from './sample.ts'
import { retroScorer } from './scorer.ts'
import { MAX_SIGNALS_PER_RUN, rankProposals, signalFor } from './signal.ts'
import type { SignalPort } from './signals.ts'
import { RETRO_ANALYSIS, RETRO_INPUT, RETRO_OUTPUT, type RetroAnalysis, type RetroOutput } from './schema.ts'

export const RETRO_WORKFLOW_ID = 'retrospective'
export const RETRO_AGENT = 'retrospective'
const DAY_MS = 86_400_000

export interface RetrospectiveDeps {
  journal: JournalReader
  learnings: LearningsStore
  /** The agent names a hosted workflow runs, or undefined for a workflow that runs none (or does not exist). */
  agentsOf(workflow: string): readonly string[] | undefined
  /** The factory's signal port. A run with `fileSignals` fails fast without one. */
  signals?: SignalPort
  /** The paths tracked in this repository (what the deploy ships); a signal may name only these. Read when signals are filed. */
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
  return ctx.agent('analyze-retry', { ...spec, prompt, tail: SUBMIT_RESULT_RETRY })
}

/**
 * `retrospective` (concept §7 tier 2): looks back on one workflow's recent finished runs and proposes. Proposals are
 * never applied: they come back as typed output and, when asked, as factory signals (at most
 * {@link MAX_SIGNALS_PER_RUN}, the best-evidenced first; triage dedupes them and makes the Issue). Learned facts are
 * stored as `proposed`; one proposed again by another run in a later week is activated, one not seen again for four
 * weeks is retired (`learnings/store.ts`). No agent step runs when there is nothing to read.
 */
export function createRetrospective(deps: RetrospectiveDeps): HostWorkflow {
  const now = deps.now ?? (() => new Date())
  const workflow = defineWorkflow({
    id: RETRO_WORKFLOW_ID,
    version: '2026-11-16.1',
    scorer: retroScorer,
    input: RETRO_INPUT,
    output: RETRO_OUTPUT,
    // The weekly schedule starts one run per workflow; the agent step is the only spend.
    concurrency: 2,
    async run(ctx, input): Promise<RetroOutput> {
      const agents = deps.agentsOf(input.workflow)
      if (!agents || agents.length === 0) {
        throw new WorkflowError('invalid_input', `${input.workflow} is not a workflow that runs agents`)
      }
      const filing = input.fileSignals && !input.fixture
      if (filing && !(deps.signals && deps.tracked)) {
        throw new WorkflowError('invalid_input', 'fileSignals is on but this host has no signal port configured')
      }
      const empty = {
        workflow: input.workflow,
        windowDays: input.window,
        sampled: 0,
        proposals: [],
        learnings: [],
        tidy: { merged: 0, activated: [], retired: [] },
        signals: [],
        dropped: [],
      }

      // The journal's records are plain data, but `SampledRun` is an interface (`friction` is unknown): the round trip makes
      // that a fact for the step's Json result, and the type is put back on the way out.
      const sampled = await ctx.step('sample', async ({ callContext }): Promise<Json> => {
        if (input.fixture) {
          requireEvalPurpose(callContext, RETRO_WORKFLOW_ID)
          return input.fixture.runs
        }
        const since = new Date(now().getTime() - input.window * DAY_MS)
        const read = await deps.journal.sample({ workflow: input.workflow, since, limit: input.sample })
        return JSON.parse(JSON.stringify(read)) as Json
      })
      const runs = sampled as unknown as SampledRun[]
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

      // Proposed, not active: a fact becomes active when another run proposes it again in a later week (store.ts).
      const learnings = await ctx.effect('record-learnings', async () => {
        const stored: RetroOutput['learnings'] = []
        // An eval case stores nothing: its runs are made up, and a fact learned from them would reach a real agent.
        if (input.fixture) return checked.learnings.map((l) => ({ ...l, learningId: null, outcome: 'known' as const }))
        for (const l of checked.learnings) {
          const { learning, outcome } = await deps.learnings.add({
            agent: l.agent,
            fact: l.fact,
            source: ctx.runId,
            evidence: l.evidence,
            at: now(),
          })
          stored.push({ ...l, learningId: learning.id, outcome })
        }
        return stored
      })
      const tidy = await ctx.effect('tidy-learnings', async () => {
        if (input.fixture) return { merged: 0, activated: [], retired: [] }
        const report = await deps.learnings.tidy({ now: now() })
        return {
          merged: report.merged,
          activated: report.activated.map((l) => l.id),
          retired: report.retired.map((l) => l.id),
        }
      })

      const signals: RetroOutput['signals'] = filing
        ? await ctx.effect('file-signals', async () => {
            const { signals: port, tracked } = deps
            if (!port || !tracked) throw new WorkflowError('invalid_input', 'no signal port configured')
            const paths = await tracked()
            const filed: RetroOutput['signals'] = []
            const seen = new Set<string>()
            let budget = MAX_SIGNALS_PER_RUN
            for (const proposal of rankProposals(checked.proposals)) {
              const draft = signalFor({
                workflow: input.workflow,
                retroRunId: ctx.runId,
                sampled: runs.length,
                windowDays: input.window,
                proposal,
                agents,
                tracked: paths,
              })
              if (!draft.ok) {
                filed.push({ hash: draft.hash, status: 'refused', reason: draft.reason })
                continue
              }
              // Two proposals with one hash in a run collapse; a proposal made again next week is the factory triage's to dedupe.
              if (seen.has(draft.hash)) {
                filed.push({ hash: draft.hash, title: draft.title, status: 'duplicate' })
                continue
              }
              seen.add(draft.hash)
              if (budget === 0) {
                filed.push({ hash: draft.hash, title: draft.title, status: 'capped' })
                continue
              }
              budget--
              try {
                await port.file({ title: draft.title, text: draft.text })
                filed.push({ hash: draft.hash, title: draft.title, status: 'filed' })
              } catch (error) {
                filed.push({
                  hash: draft.hash,
                  title: draft.title,
                  status: 'failed',
                  reason: error instanceof Error ? error.message : String(error),
                })
              }
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
        tidy,
        signals,
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
