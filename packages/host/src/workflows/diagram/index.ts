import { type Ctx, defineWorkflow, type Json, type StepScope, WorkflowError } from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'
import type { WorkflowDeps } from '../index.ts'
import { bindingStubs, compactView, existingIds, keptElements, mergeExtension, parseExisting } from './document.ts'
import { type Hydrate, processHydrate } from './hydrate.ts'
import { diagramTask, reask } from './prompts.ts'
import { DiagramInput, type DiagramInputValue, DiagramOutput, type ExcalidrawFile } from './schema.ts'
import { diagramScorer } from './scorer.ts'
import { parseEnvelope, prepareSkeleton } from './skeleton.ts'

export const DIAGRAM_VERSION = '2026-10-29.1'

/** The agent's definition (`agents/diagram`). */
const AGENT = 'diagram'
/** One retry of the agent step: a flaky attempt (a died session, an idle kill) must not decide the run. */
const AGENT_ATTEMPTS = 2

export type DiagramOptions = {
  /** Skeleton → document; default the pinned `@excalidraw/excalidraw` in a child process (`hydrate.ts`). */
  hydrate?: Hydrate
  /** Wait before the agent step's second attempt. Default 1 s. */
  agentBackoffMs?: number
}

/** What a `hydrate` step journals: the finished document, or what is wrong with the agent's answer. */
const Hydrated = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    document: z.string(),
    elementCount: z.number().int(),
    viewport: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable(),
    rationale: z.string(),
  }),
  z.object({ ok: z.literal(false), errors: z.array(z.string()) }),
])
type Hydrated = z.output<typeof Hydrated>

/**
 * The agent's answer to a document: parse and check the envelope, split off the pseudo-elements, hydrate, and in extend
 * mode with `restoreCheckpoint` put the new elements on top of the kept ones. Wrong answers come back as `errors`
 * (for the re-ask); a hydration that cannot run throws.
 */
async function build(
  text: string,
  existing: ExcalidrawFile | null,
  hydrate: Hydrate,
  signal: AbortSignal,
): Promise<Hydrated> {
  const answer = parseEnvelope(text)
  if (!answer.ok) return { ok: false, errors: answer.errors }
  const checked = prepareSkeleton(answer.envelope.elements, existing ? existingIds(existing) : undefined)
  if (!checked.ok) return { ok: false, errors: checked.errors }
  const { drawn, viewport, deletedIds, restore } = checked.prepared

  const kept = existing && restore ? keptElements(existing, deletedIds) : []
  const stubs = bindingStubs(kept, drawn)
  const hydrated = await hydrate([...stubs, ...drawn], signal)
  if (!hydrated.ok) return { ok: false, errors: [`the skeleton could not be converted: ${hydrated.error}`] }

  const file: ExcalidrawFile =
    existing && restore
      ? {
          ...hydrated.file,
          elements: mergeExtension(kept, hydrated.file.elements, new Set(stubs.map((stub) => String(stub.id)))),
          appState: existing.appState,
          files: existing.files,
        }
      : hydrated.file
  return {
    ok: true,
    document: JSON.stringify(file, null, 2),
    elementCount: file.elements.filter((element) => element.isDeleted !== true).length,
    viewport,
    rationale: answer.envelope.rationale,
  }
}

/**
 * `diagram` (concept §11 P3b): an Excalidraw diagram from a brief. One agent drafts the skeleton, code checks and
 * hydrates it; the caller writes the file. Port of agent-gateway's `excalidraw_diagram`, whose hydration ran headless
 * Chrome against a CDN bundle: here the pinned library runs in a child process (`hydrate.ts`).
 */
export function createDiagramWorkflows(_deps?: WorkflowDeps, options: DiagramOptions = {}): HostWorkflow[] {
  const hydrate = options.hydrate ?? processHydrate

  async function run(ctx: Ctx, input: DiagramInputValue) {
    let existing: ExcalidrawFile | null = null
    if (input.mode === 'extend') {
      const parsed = parseExisting(input.existing ?? '')
      if (!parsed.ok) throw new WorkflowError('invalid_input', parsed.error)
      existing = parsed.file
    }
    const prompt = diagramTask(input, existing ? compactView(existing) : undefined)
    const text = await ctx.agent('agent', {
      agent: AGENT,
      prompt,
      output: z.string(),
      options: { output: 'text' },
      retry: { attempts: AGENT_ATTEMPTS, backoffMs: options.agentBackoffMs ?? 1_000 },
    })
    const hydrateAnswer =
      (answer: string) =>
      async ({ signal }: StepScope): Promise<Json> =>
        build(answer, existing, hydrate, signal)
    let result = Hydrated.parse(await ctx.step('hydrate', hydrateAnswer(text)))
    // One re-ask in the same session (concept §4: one re-ask, then invalid_output).
    if (!result.ok) {
      const again = await ctx.continue('diagram:reask', 'agent', reask(result.errors), { output: z.string() })
      result = Hydrated.parse(await ctx.step('hydrate:reask', hydrateAnswer(again)))
    }
    if (!result.ok)
      throw new WorkflowError(
        'invalid_output',
        `the diagram agent's answer was rejected twice: ${result.errors.join('; ')}`,
      )
    const { ok: _ok, ...output } = result
    return output
  }

  const diagram = defineWorkflow({
    id: 'diagram',
    version: DIAGRAM_VERSION,
    input: DiagramInput,
    output: DiagramOutput,
    scorer: diagramScorer,
    run,
  })
  return [
    {
      workflow: diagram,
      summary:
        'Draw an Excalidraw diagram from a brief; `--format plain > x.excalidraw` writes the document, --mode extend changes an existing one',
      cli: { positional: ['brief'], defaultFormat: 'json', plainField: 'document' },
      agents: [{ agent: AGENT, route: 'diagram.agent' }],
    },
  ]
}
