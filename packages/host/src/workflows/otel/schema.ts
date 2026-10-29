import { z } from 'zod'

export const ENVS = ['local', 'prod'] as const

const DURATION = /^[1-9]\d{0,2}[mhd]$/

/** `<from>/<to>`: two ISO-8601 instants, the first before the second. */
function absoluteWindow(value: string): { from: Date; to: Date } | null {
  const [from, to, ...rest] = value.split('/')
  if (!from || !to || rest.length) return null
  const a = new Date(from)
  const b = new Date(to)
  return Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || a >= b ? null : { from: a, to: b }
}

export const isWindow = (value: string) => DURATION.test(value) || absoluteWindow(value) !== null

export const OtelInput = z
  .object({
    investigation: z.string().min(3).describe('What to investigate: a service, an error, a trace id, a symptom'),
    env: z.enum(ENVS).default('prod').describe('Which ClickStack to query; fixed for the whole run'),
    since: z
      .string()
      .refine(isWindow, 'a duration like 30m, 2h or 3d (ending now), or <from>/<to> as ISO-8601 instants')
      .optional()
      .describe('The time window: a duration ending now, or an absolute <from>/<to>; default: the agent picks one'),
  })
  .strict()
export type OtelInputValue = z.output<typeof OtelInput>

export const Status = z.enum(['healthy', 'degraded', 'errors'])
export const Severity = z.enum(['info', 'warn', 'error'])

/** What the agent submits: agent-gateway's `OTEL_OUTPUT` without the fields code owns (environment, hyperdx). */
export const Draft = z.object({
  status: Status,
  timeRange: z.string().min(1),
  findings: z.array(
    z.object({
      service: z.string(),
      summary: z.string().min(1),
      severity: Severity,
      evidence: z.string().optional(),
    }),
  ),
  recommendations: z.array(z.string()).default([]),
})
export type Draft = z.output<typeof Draft>

/** One tool call of the run, from the gate's hook. `id` is `q<n>` in the order the calls were answered. */
export const Query = z.object({
  id: z.string(),
  tool: z.string().describe('The gate tool the agent called'),
  target: z.string().optional().describe('For hdx_query: the ClickStack tool it ran'),
  argsDigest: z.string(),
  ok: z.boolean().describe('The call worked and the tool did not report a failure'),
  error: z.string().optional(),
  rows: z.number().int().nonnegative().optional().describe('Rows in the answer, when it is a list or a table'),
  chars: z.number().int().nonnegative().describe('Size of the answer in characters, before any cut'),
})
export type Query = z.output<typeof Query>

export const Finding = z.object({
  service: z.string(),
  summary: z.string(),
  severity: Severity,
  evidence: z.string().optional(),
  unverified: z.boolean().describe('Its evidence cites no query of this run (kept, flagged)'),
})

/** agent-gateway's `OTEL_OUTPUT`, `hyperdx`'s free text typed, plus the run's queries and code-set warnings. */
export const OtelOutput = z.object({
  status: Status,
  environment: z.enum(ENVS),
  timeRange: z.string(),
  findings: z.array(Finding),
  recommendations: z.array(z.string()),
  hyperdx: z.object({ connected: z.boolean(), reason: z.string().optional() }),
  queries: z.array(Query),
  warnings: z.array(z.string()),
})
export type OtelResult = z.output<typeof OtelOutput>
