import {
  type CallOptions,
  DEFAULT_REGISTER,
  MEDIUM_NOTE,
  type ProseFormat,
  type ProseLanguage,
  type ProseMedium,
  type ProseRegister,
  type Usage,
} from '@agent-workflows/capabilities'
import { defineWorkflow } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import { keepGate } from '../prose/gate.ts'
import { detectFormat, detectLanguage, type LintFinding, lintProse } from '../prose/lint.ts'
import { checkVoiceGuide } from '../prose/voice.ts'
import { ProsePolishInput, ProsePolishOutput, type ProsePolishOutputValue } from './schema.ts'

export const PROSE_POLISH_WORKFLOW_ID = 'prose-polish'
export const PROSE_POLISH_VERSION = '2026-10-29.1'

interface Review {
  scores: ProsePolishOutputValue['review']['scores']
  notes: ProsePolishOutputValue['review']['notes']
  visualSuggestions: ProsePolishOutputValue['visualSuggestions']
  model: string
}

interface Draft {
  text: string
  medium: ProseMedium
  register: ProseRegister
  language: ProseLanguage
  verdictFirst: boolean
  brief?: string
  context?: string
}

/** The two capabilities the polish calls; any registry that has `prose.critique` and `prose.write` fits. */
export type PolishCaller = {
  call(id: 'prose.critique', input: Draft & { draftFormat: ProseFormat }, options?: CallOptions): Promise<Review>
} & {
  call(
    id: 'prose.write',
    input: Draft & { draftFormat: ProseFormat; findings: LintFinding[]; notes: Review['notes'] },
    options?: CallOptions,
  ): Promise<{ text: string; model: string; failure?: string }>
}

export interface PolishDeps {
  registry: PolishCaller
  /** Where `AGW_VOICE_PATH` is read from. Default `process.env`. */
  env?: Record<string, string | undefined>
}

/** USD summed over the calls of one step as agent-gateway summed its two calls: unpriced calls count 0 unless none was priced. */
function costTally() {
  let total: number | null = null
  return {
    add(usage: Usage) {
      if (usage.cost !== null) total = (total ?? 0) + usage.cost
    },
    get total() {
      return total
    },
  }
}

/**
 * `prose-polish`: the full prose pass for callers with no Claude Code session (Hermes, `narrative`). `prose`'s lint and
 * cross-lab review (the same modules and the `prose.critique` capability), one rewrite on the `prose.write` seat, and the
 * keep gate. Inside Claude Code the rewrite runs in the calling session on Max (`prose` + `prose-gate`) and this
 * workflow is not used. A missing voice guide or a failed reviewer or writer call fails the run before a bad page is
 * kept; a writer that answers unusable content keeps the original with the reason.
 */
export function createProsePolish(deps: PolishDeps): HostWorkflow {
  const { registry } = deps
  const env = deps.env ?? process.env

  const polish = defineWorkflow({
    id: PROSE_POLISH_WORKFLOW_ID,
    version: PROSE_POLISH_VERSION,
    input: ProsePolishInput,
    output: ProsePolishOutput,
    async run(ctx, input) {
      const plan = await ctx.step('lint', () => {
        const language = input.language === 'auto' ? detectLanguage(input.text) : input.language
        return { language, format: detectFormat(input.text), findings: lintProse(input.text, language) }
      })
      // A missing voice guide fails before any spend: the writer would have nothing to write in.
      await ctx.step('voice', () => checkVoiceGuide(env))
      const register = input.register ?? DEFAULT_REGISTER[input.medium]
      const draft: Draft = {
        text: input.text,
        medium: input.medium,
        register,
        language: plan.language,
        verdictFirst: input.verdictFirst,
        ...(input.brief ? { brief: input.brief } : {}),
        ...(input.context ? { context: input.context } : {}),
      }

      const reviewed = await ctx.step('review', async ({ addUsage, signal }) => {
        const tally = costTally()
        const review = await registry.call(
          'prose.critique',
          { ...draft, draftFormat: plan.format },
          {
            addUsage: (usage) => {
              tally.add(usage)
              addUsage(usage)
            },
            signal,
          },
        )
        return { ...review, cost: tally.total }
      })

      const written = await ctx.step('write', async ({ addUsage, signal }) => {
        const tally = costTally()
        const out = await registry.call(
          'prose.write',
          { ...draft, draftFormat: plan.format, findings: plan.findings, notes: reviewed.notes },
          {
            addUsage: (usage) => {
              tally.add(usage)
              addUsage(usage)
            },
            signal,
          },
        )
        return { ...out, cost: tally.total }
      })

      const verdict = await ctx.step('gate', () => {
        if (written.failure) {
          return { kept: 'original' as const, text: input.text, reason: written.failure, after: plan.findings }
        }
        const gated = keepGate({ original: input.text, rewrite: written.text, language: plan.language })
        return {
          kept: gated.kept,
          text: gated.text,
          ...(gated.reason ? { reason: gated.reason } : {}),
          after: gated.kept === 'rewrite' ? gated.after : gated.before,
        }
      })

      const cost = reviewed.cost === null && written.cost === null ? null : (reviewed.cost ?? 0) + (written.cost ?? 0)
      return {
        kept: verdict.kept,
        text: verdict.text,
        ...(verdict.reason ? { reason: verdict.reason } : {}),
        language: plan.language,
        format: plan.format,
        mediumNote: MEDIUM_NOTE[input.medium],
        lint: { before: plan.findings.length, after: verdict.after.length, findings: verdict.after },
        review: { scores: reviewed.scores, notes: reviewed.notes },
        visualSuggestions: reviewed.visualSuggestions,
        models: { writer: written.model, reviewer: reviewed.model },
        cost,
      }
    },
  })

  return {
    workflow: polish,
    summary:
      'Lint, cross-lab review, a rewrite on the prose.write seat and the keep gate, for callers with no Claude Code session',
    cli: { positional: ['text'], stdin: 'text', defaultFormat: 'json' },
  }
}
