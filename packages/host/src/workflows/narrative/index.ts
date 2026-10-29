import {
  type CallOptions,
  NARRATIVE_LIMITS,
  type NarrativeComposeInput,
  type NarrativeComposeOutput,
} from '@agent-workflows/capabilities'
import { resolveRoute } from '@agent-workflows/routes'
import { Cancelled, defineWorkflow, InfraError } from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'
import { type PolishCaller, polishDraft } from '../prose-polish/index.ts'
import { ProsePolishInput, ProsePolishOutput } from '../prose-polish/schema.ts'
import { defaultGatherPorts, type GatherPorts, gatherFacts } from './gather.ts'
import { NarrativeInput, NarrativeOutput, type NarrativeOutputValue, type NarrativeProseValue } from './schema.ts'
import {
  clampSections,
  headingLines,
  renderNarrativePage,
  sanitizeSections,
  splitFrontmatter,
  truncate,
} from './sections.ts'

export const NARRATIVE_WORKFLOW_ID = 'narrative'
export const NARRATIVE_VERSION = '2026-10-29.2'
/** `narrative`'s polish child: `prose-polish`'s steps, reporting a failure instead of failing. */
export const NARRATIVE_POLISH_ID = 'narrative-polish'

/** The one capability the workflow calls; any registry that has `narrative.compose` fits. */
export type NarrativeCaller = {
  call(id: 'narrative.compose', input: NarrativeComposeInput, options?: CallOptions): Promise<NarrativeComposeOutput>
}

export interface NarrativeDeps {
  registry: NarrativeCaller & PolishCaller
  /** Where the commits and the session tails are read from. Default: `git` and `~/.claude/projects`. */
  gather?: GatherPorts
  now?: () => Date
  /** Where `AGW_ROUTES` and `AGW_VOICE_PATH` are read from. Default `process.env`. */
  env?: Record<string, string | undefined>
}

const PolishAttempt = z.object({
  ok: z.boolean(),
  output: ProsePolishOutput.optional(),
  error: z.string().optional().describe('Why the polish failed, when it did'),
})

type Polish = { page: string; prose?: NarrativeProseValue }

const declined = (page: string, keptReason: string, costUsd: number | null): Polish => ({
  page,
  prose: { status: 'declined', kept: 'original', keptReason, costUsd },
})

/**
 * `narrative` (agent-gateway `narrative`): writes or revises ONE project's narrative page for the Obsidian vault: what
 * the project is, where it stands, how it got here, in business terms. Bounded gathering of commits and session
 * excerpts (code), one JSON-only call on the `narrative` route (`narrative.compose`), the section caps and the page
 * rendered in code, then the page body polished by the `prose-polish` child run (medium vault, frontmatter set aside).
 * A failed or declined polish degrades to the unpolished page and never fails the run. The workflow returns the page;
 * the caller writes it.
 */
export function createNarrative(deps: NarrativeDeps): HostWorkflow[] {
  const { registry } = deps
  const ports = deps.gather ?? defaultGatherPorts()
  const now = deps.now ?? (() => new Date())
  const env = deps.env ?? process.env

  // The polish is a child run so its spend and journal are its own; a failure is its result, never the page's.
  const polishChild = defineWorkflow({
    id: NARRATIVE_POLISH_ID,
    version: NARRATIVE_VERSION,
    input: ProsePolishInput,
    output: PolishAttempt,
    async run(ctx, input) {
      try {
        return { ok: true, output: await polishDraft(ctx, input, { registry, env }) }
      } catch (error) {
        // A cancel, a shutdown and an infrastructure failure belong to the runtime, not to the page.
        if (error instanceof Cancelled || error instanceof InfraError || ctx.signal.aborted) throw error
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  const narrative = defineWorkflow({
    id: NARRATIVE_WORKFLOW_ID,
    version: NARRATIVE_VERSION,
    input: NarrativeInput,
    output: NarrativeOutput,
    async run(ctx, input): Promise<NarrativeOutputValue> {
      const { cwd, project, previousPage, since } = input
      const gathered = await ctx.step('gather', () => gatherFacts(ports, { cwd, since, now: now().getTime() }))
      const { commits, sessions, sinceUsed } = gathered
      const inputs = { commits: commits.count, sessions: sessions.count, sinceUsed }
      const unchanged = (reason: string, model: string): NarrativeOutputValue => ({
        project,
        changed: false,
        reason,
        summary: null,
        page: null,
        sections: null,
        inputs,
        model,
      })

      if (commits.count === 0 && sessions.count === 0) {
        return unchanged('no new commits or sessions', resolveRoute('narrative', env).model)
      }

      const composed = await ctx.step('compose', ({ addUsage, signal }) =>
        registry.call(
          'narrative.compose',
          {
            project,
            cwd,
            since,
            sinceUsed,
            previousPage,
            commitsText: commits.text,
            commitCount: commits.count,
            sessionsText: sessions.text,
            sessionCount: sessions.count,
          },
          { addUsage, signal },
        ),
      )
      if (!composed.changed || !composed.sections) {
        return unchanged(truncate(composed.reason, NARRATIVE_LIMITS.reasonChars), composed.model)
      }

      const clamped = clampSections(sanitizeSections(composed.sections))
      const rendered = await ctx.step('render', () =>
        renderNarrativePage({
          project,
          cwd,
          since,
          timestamp: now().toISOString().slice(0, 10),
          sections: clamped,
        }),
      )

      const polished: Polish = input.polish ? await polishPage(rendered) : { page: rendered }
      return {
        project,
        changed: true,
        reason: truncate(composed.reason, NARRATIVE_LIMITS.reasonChars),
        summary: composed.summary ? truncate(composed.summary, NARRATIVE_LIMITS.summaryChars) : null,
        page: polished.page,
        sections: clamped,
        ...(polished.prose ? { prose: polished.prose } : {}),
        inputs,
        model: composed.model,
      }

      /**
       * The polish stage: the page body through `prose-polish` (medium vault, language auto), the frontmatter
       * reattached verbatim. Any failure, a declined rewrite or an empty body returns the original page.
       */
      async function polishPage(page: string): Promise<Polish> {
        const { frontmatter, body } = splitFrontmatter(page)
        if (body.trim().length === 0) return declined(page, 'no body to polish', null)
        const original = body.trim()
        const headings = headingLines(original)
        const polishInput: z.input<typeof ProsePolishInput> = {
          text: original,
          medium: 'vault',
          verdictFirst: false,
          ...(headings.length > 0
            ? {
                brief:
                  "Keep the page's headings verbatim and in this order, none added, dropped or " +
                  `reworded:\n${headings.join('\n')}`,
              }
            : {}),
        }
        const [attempt] = await ctx.workflow('polish', polishChild, [polishInput])
        // A cancelled parent ends cancelled: the child came back empty because of it, which is not a failed polish.
        ctx.signal.throwIfAborted()
        const out = attempt?.output
        if (!attempt?.ok || !out) {
          // A failing polish (a reviewer or writer call that failed, a missing voice guide) leaves the page unpolished.
          return {
            page,
            prose: {
              status: 'errored',
              kept: 'original',
              keptReason: `prose failed: ${attempt?.error ?? 'the polish run did not finish'}`,
              costUsd: null,
            },
          }
        }
        if (out.kept === 'original') {
          return {
            page,
            prose: {
              status: 'declined',
              kept: 'original',
              ...(out.reason ? { keptReason: out.reason } : {}),
              costUsd: out.cost,
            },
          }
        }
        if (headingLines(out.text).join('\n') !== headings.join('\n')) {
          return declined(page, 'rewrite changed the page headings', out.cost)
        }
        return {
          page: `${frontmatter}${frontmatter ? '\n' : ''}${out.text}\n`,
          prose: { status: 'polished', kept: 'rewrite', costUsd: out.cost },
        }
      }
    },
  })

  return [
    {
      workflow: narrative,
      summary: "Write or revise one project's narrative page from its commits and session excerpts; returns the page",
      cli: { defaultFormat: 'json' },
    },
    { workflow: polishChild, internal: true },
  ]
}
