import {
  type CallOptions,
  DEFAULT_REGISTER,
  MAX_BRIEF_FINDINGS,
  MAX_BRIEF_NOTES,
  MEDIUM_NOTE,
  type ProseCritiqueInput,
  type ProseCritiqueOutput,
  type ProseWriteInput,
  type ProseWriteOutput,
  type Usage,
} from '@agent-workflows/capabilities'
import { type Ctx, defineWorkflow } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import { keepGate } from '../prose/gate.ts'
import { detectFormat, detectLanguage, lintProse } from '../prose/lint.ts'
import { checkVoiceGuide } from '../prose/voice.ts'
import {
  ProsePolishInput,
  type ProsePolishInputValue,
  ProsePolishOutput,
  type ProsePolishOutputValue,
} from './schema.ts'

export const PROSE_POLISH_WORKFLOW_ID = 'prose-polish'
export const PROSE_POLISH_VERSION = '2026-10-29.2'

/** The two capabilities the polish calls; any registry that has `prose.critique` and `prose.write` fits. */
export type PolishCaller = {
  call(id: 'prose.critique', input: ProseCritiqueInput, options?: CallOptions): Promise<ProseCritiqueOutput>
} & {
  call(id: 'prose.write', input: ProseWriteInput, options?: CallOptions): Promise<ProseWriteOutput>
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
 * The polish itself, as steps of the calling run: `prose`'s lint and cross-lab review (the same modules and the
 * `prose.critique` capability), one rewrite on the `prose.write` seat, and the keep gate. A missing voice guide or a
 * failed reviewer or writer call fails the run before a bad page is kept; a writer that answers unusable content keeps
 * the original with the reason. Shared by the public `prose-polish` workflow and `narrative`'s polish child, which
 * reports a failure instead of failing.
 */
export async function polishDraft(
  ctx: Ctx,
  input: ProsePolishInputValue,
  deps: PolishDeps,
): Promise<ProsePolishOutputValue> {
  const { registry } = deps
  const env = deps.env ?? process.env
  const plan = await ctx.step('lint', () => {
    const language = input.language === 'auto' ? detectLanguage(input.text) : input.language
    return { language, format: detectFormat(input.text), findings: lintProse(input.text, language) }
  })
  // A missing voice guide fails before any spend: the writer would have nothing to write in.
  await ctx.step('voice', () => checkVoiceGuide(env))
  const register = input.register ?? DEFAULT_REGISTER[input.medium]
  const draft = {
    text: input.text,
    medium: input.medium,
    register,
    language: plan.language,
    draftFormat: plan.format,
    verdictFirst: input.verdictFirst,
    ...(input.brief ? { brief: input.brief } : {}),
    ...(input.context ? { context: input.context } : {}),
  }

  const reviewed = await ctx.step('review', async ({ addUsage, signal }) => {
    const tally = costTally()
    const review = await registry.call('prose.critique', draft, {
      addUsage: (usage) => {
        tally.add(usage)
        addUsage(usage)
      },
      signal,
    })
    return { ...review, cost: tally.total }
  })

  const written = await ctx.step('write', async ({ addUsage, signal }) => {
    const tally = costTally()
    // The writer's prompt lists the first MAX_BRIEF_* findings and notes and counts the rest: send exactly that, so a long
    // bad draft (more findings than the capability accepts) is never a failed run.
    const out = await registry.call(
      'prose.write',
      {
        ...draft,
        findings: plan.findings.slice(0, MAX_BRIEF_FINDINGS),
        findingsOmitted: Math.max(0, plan.findings.length - MAX_BRIEF_FINDINGS),
        notes: reviewed.notes.slice(0, MAX_BRIEF_NOTES),
        notesOmitted: Math.max(0, reviewed.notes.length - MAX_BRIEF_NOTES),
      },
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
}

/**
 * `prose-polish`: the full prose pass for callers with no Claude Code session (Hermes, `narrative`). Inside Claude Code
 * the rewrite runs in the calling session on Max (`prose` + `prose-gate`) and this workflow is not used.
 */
export function createProsePolish(deps: PolishDeps): HostWorkflow {
  const polish = defineWorkflow({
    id: PROSE_POLISH_WORKFLOW_ID,
    version: PROSE_POLISH_VERSION,
    input: ProsePolishInput,
    output: ProsePolishOutput,
    run: (ctx, input) => polishDraft(ctx, input, deps),
  })

  return {
    workflow: polish,
    summary:
      'Lint, cross-lab review, a rewrite on the prose.write seat and the keep gate, for callers with no Claude Code session',
    cli: { positional: ['text'], stdin: 'text', defaultFormat: 'json' },
  }
}
