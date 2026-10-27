// The one operation set every candidate implements: schemas, x-cli blocks and a fake workflow engine.
// Nothing framework-specific lives here, so the per-framework files hold only wiring.
import { z } from 'zod'

export const Depth = z.enum(['quick', 'standard', 'deep']).describe('Search breadth')

export const Source = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('web') }),
    z.object({ kind: z.literal('brain'), path: z.string().describe('Vault-relative note path') }),
  ])
  .describe('Where the agent starts looking')

export const RunInput = z.object({
  question: z.string().min(3).max(2000).describe('The research question'),
  depth: Depth.default('standard'),
  profile: z.enum(['yolo', 'focused']).default('yolo').describe('D4: yolo unless a quality lever is wanted'),
  source: Source.optional(),
})

export const Report = z.object({
  title: z.string(),
  body: z.string().describe('Markdown report'),
})

export const Done = z.object({ status: z.literal('done'), runId: z.string(), result: Report })
export const Pending = z.object({
  status: z.literal('pending'),
  runId: z.string().describe('Durable run handle'),
  elapsedS: z.number().int().nonnegative(),
  resume: z.object({ command: z.string().describe('Exact command that resumes this run') }),
})
export const RunResponse = z.discriminatedUnion('status', [Done, Pending]).describe('Finished, or pending with a resume handle')

export const RunStatus = z.object({
  status: z.enum(['running', 'done', 'failed']),
  runId: z.string(),
  result: Report.optional(),
  error: z.string().optional(),
})

export const RunIdParam = z.object({ runId: z.string().min(1).describe('Run id returned by the run call') })

export const ProgressEvent = z.object({ phase: z.enum(['plan', 'agent', 'score', 'finish']), at: z.number() })

// Typed error: the run id is unknown. Each framework renders it in its own native error shape.
export const RunNotFound = z.object({ runId: z.string() })
export const ErrorBody = z.object({ error: z.object({ kind: z.literal('not_found'), message: z.string(), runId: z.string() }) })

// x-cli (concept §9): the generator needs a command path, positionals, mutating, and the job/resume contract.
export const XCliRun = {
  command: ['research', 'run'],
  positional: ['question'],
  mutating: true,
  defaultFormat: 'plain',
  plainField: 'result.body',
  job: {
    statusOperationId: 'runStatus',
    idField: 'runId',
    statusField: 'status',
    terminal: ['done', 'failed'],
    successStatus: 'done',
    resume: { command: ['research', 'wait'] },
  },
}
export const XCliStatus = { command: ['research', 'status'], positional: ['runId'], mutating: false, defaultFormat: 'plain', plainField: 'result.body' }

// ---- fake workflow engine -------------------------------------------------------------------------------
const DURATION_MS = { quick: 5, standard: 120, deep: 400 } as const
export const INLINE_BUDGET_MS = 60
type Input = z.output<typeof RunInput>
const runs = new Map<string, { input: Input; endsAt: number; startedAt: number }>()

export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run not found: ${runId}`)
  }
}

const report = (input: Input) => ({
  title: `Report: ${input.question.slice(0, 40)}`,
  body: `# ${input.question}\n\ndepth=${input.depth} profile=${input.profile}`,
})

export async function startRun(input: Input): Promise<z.infer<typeof RunResponse>> {
  const runId = crypto.randomUUID()
  const startedAt = Date.now()
  runs.set(runId, { input, startedAt, endsAt: startedAt + DURATION_MS[input.depth] })
  const wait = Math.min(DURATION_MS[input.depth], INLINE_BUDGET_MS)
  await new Promise((r) => setTimeout(r, wait))
  if (DURATION_MS[input.depth] <= INLINE_BUDGET_MS) return { status: 'done', runId, result: report(input) }
  return { status: 'pending', runId, elapsedS: 0, resume: { command: `agw research wait ${runId}` } }
}

export function getRun(runId: string): z.infer<typeof RunStatus> {
  const r = runs.get(runId)
  if (!r) throw new RunNotFoundError(runId)
  return Date.now() >= r.endsAt ? { status: 'done', runId, result: report(r.input) } : { status: 'running', runId }
}

export async function* progress(runId: string): AsyncGenerator<z.infer<typeof ProgressEvent>> {
  if (!runs.has(runId)) throw new RunNotFoundError(runId)
  for (const phase of ['plan', 'agent', 'score', 'finish'] as const) {
    yield { phase, at: Date.now() }
    await new Promise((r) => setTimeout(r, 5))
  }
}
