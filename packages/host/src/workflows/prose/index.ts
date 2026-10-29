import type { CallOptions } from '@agent-workflows/capabilities'
import { defineWorkflow } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import { keepGate } from './gate.ts'
import { detectFormat, detectLanguage, lintProse } from './lint.ts'
import { buildReviewPrompt, buildWriterBrief, DEFAULT_REGISTER, fenceNonce, MEDIUM_NOTE } from './prompts.ts'
import {
  ProseGateInput,
  ProseGateOutput,
  ProseReviewInput,
  ProseReviewOutput,
  type ProseReviewOutputValue,
} from './schema.ts'
import { proseScorer } from './scorer.ts'
import { checkVoiceGuide } from './voice.ts'

export const PROSE_REVIEW_VERSION = '2026-10-29.1'
export const PROSE_GATE_VERSION = '2026-10-29.1'

type Review = ProseReviewOutputValue['review'] & Pick<ProseReviewOutputValue, 'visualSuggestions'> & { model: string }

/** The one capability the review calls; any registry that has `prose.critique` fits. */
export interface CritiqueCaller {
  call(id: 'prose.critique', input: { prompt: string; verdictFirst: boolean }, options?: CallOptions): Promise<Review>
}

/** What the module can be given beyond the host's shared deps. */
export interface ProseDeps {
  registry: CritiqueCaller
  /** Where `AGW_VOICE_PATH` is read from. Default `process.env`. */
  env?: Record<string, string | undefined>
}

const byRule = (findings: { rule: string }[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1
  return counts
}

/**
 * `prose` (concept §10): lint and one cross-lab review of a human-facing draft, answered with the brief the calling
 * session rewrites from. The rewrite is not a step: it runs in the caller's own session on Max. `rewrite.gate` decides
 * afterwards whether the rewrite may replace the draft. The pair is agent-gateway's `prose` job minus its writer.
 */
export function createProseWorkflows(deps: ProseDeps): HostWorkflow[] {
  const { registry } = deps
  const env = deps.env ?? process.env

  const review = defineWorkflow({
    id: 'prose',
    version: PROSE_REVIEW_VERSION,
    input: ProseReviewInput,
    output: ProseReviewOutput,
    scorer: proseScorer,
    async run(ctx, input) {
      const plan = await ctx.step('lint', () => {
        const language = input.language === 'auto' ? detectLanguage(input.text) : input.language
        const format = detectFormat(input.text)
        const findings = lintProse(input.text, language)
        return { language, format, findings, counts: byRule(findings) }
      })
      // A missing voice guide fails before any spend: the caller would have nothing to write in.
      const voicePath = await ctx.step('voice', () => checkVoiceGuide(env))
      const register = input.register ?? DEFAULT_REGISTER[input.medium]
      const args = {
        text: input.text,
        medium: input.medium,
        register,
        language: plan.language,
        format: plan.format,
        verdictFirst: input.verdictFirst,
        brief: input.brief,
        context: input.context,
        nonce: fenceNonce(input.text, input.brief, input.context),
      }
      const { model, ...reviewed } = await ctx.step('review', ({ addUsage, signal }) =>
        registry.call(
          'prose.critique',
          { prompt: buildReviewPrompt(args), verdictFirst: input.verdictFirst },
          { addUsage, signal },
        ),
      )
      return {
        language: plan.language,
        format: plan.format,
        mediumNote: MEDIUM_NOTE[input.medium],
        lint: { findings: plan.findings, counts: plan.counts },
        review: { scores: reviewed.scores, notes: reviewed.notes },
        visualSuggestions: reviewed.visualSuggestions,
        reviewer: model,
        voicePath,
        writerBrief: buildWriterBrief({ ...args, findings: plan.findings, notes: reviewed.notes, voicePath }),
      }
    },
  })

  const gate = defineWorkflow({
    id: 'rewrite.gate',
    version: PROSE_GATE_VERSION,
    input: ProseGateInput,
    output: ProseGateOutput,
    run(ctx, input) {
      return ctx.step('gate', () => {
        const verdict = keepGate({ original: input.original, rewrite: input.rewrite, language: input.language })
        const tally = (findings: { rule: string }[]) => ({ count: findings.length, byRule: byRule(findings) })
        return {
          kept: verdict.kept,
          ...(verdict.reason ? { reason: verdict.reason } : {}),
          language: verdict.language,
          format: verdict.format,
          lint: { before: tally(verdict.before), after: tally(verdict.after) },
        }
      })
    },
  })

  return [
    {
      workflow: review,
      summary: 'Lint and cross-lab review of a human-facing draft; answers the brief the calling session rewrites from',
      cli: { positional: ['text'], stdin: 'text', defaultFormat: 'json' },
    },
    {
      workflow: gate,
      summary:
        'Decide whether a rewrite may replace the draft: format, fences, URLs, wikilinks, lint (no model, cost 0)',
      cli: { stdin: 'rewrite', defaultFormat: 'json' },
    },
  ]
}
