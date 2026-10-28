import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { type KeyAttempt, withAttemptKeys } from '../../attempt-keys.ts'
import { Citation, type Depth, Unverified } from './schema.ts'

/**
 * research-gateway's REST surface (`src/routes/research.ts`): `POST /research` answers a job id at once, `GET
 * /research/:jobId` the status and, once `done`, the report. Read-only use of a frozen service: nothing else of it is
 * called, and the comparison runs it as a separate eval instance, never the live service.
 */
export interface EngineClient {
  /** The job under the key (an existing one, any status but cancelled, or a new one) and its status. */
  submit(
    input: { query: string; depth: Depth; context?: string; idempotencyKey: string },
    signal: AbortSignal,
  ): Promise<{ jobId: string; status: EngineJob['status'] }>
  poll(jobId: string, signal: AbortSignal): Promise<EngineJob>
}

/** The engine's report, leniently: only what the comparison reads; anything else it adds is ignored. */
export const EngineReport = z.object({
  report: z.string(),
  citations: z.array(Citation).default([]),
  sources: z.array(z.string()).default([]),
  unverified: z.array(Unverified).default([]),
  status: z.enum(['ok', 'partial']).default('ok'),
  warnings: z.array(z.string()).default([]),
  grounding: z
    .object({
      pagesRetrieved: z.number().default(0),
      pagesFailed: z.number().default(0),
      citationsKept: z.number().default(0),
      citationsDropped: z.number().default(0),
    })
    .optional(),
  cost: z.object({ wallMs: z.number().optional(), totalUsd: z.number().nullable().optional() }).optional(),
})
export type EngineReport = z.output<typeof EngineReport>

export const EngineJob = z.object({
  status: z.enum(['queued', 'running', 'done', 'error', 'cancelled']),
  result: EngineReport.optional(),
  error: z.string().optional(),
})
export type EngineJob = z.output<typeof EngineJob>

export type EngineEndpoint = { url: string; token: string }

/**
 * Where the engine instance is: `AGW_RESEARCH_ENGINE_URL` and `AGW_RESEARCH_ENGINE_TOKEN`, else the untracked
 * `<stateDir>/research/engine.json` (`{"url", "token"}`, written by whoever starts the eval instance). Null: no
 * engine configured, and the engine and pilot arms fail with a typed reason.
 */
export function engineEndpoint(env: Record<string, string | undefined>, stateDir: string): EngineEndpoint | null {
  const url = env.AGW_RESEARCH_ENGINE_URL?.trim()
  const token = env.AGW_RESEARCH_ENGINE_TOKEN?.trim()
  if (url && token) return { url: url.replace(/\/+$/, ''), token }
  const path = join(stateDir, 'research', 'engine.json')
  if (!existsSync(path)) return null
  const parsed = z
    .object({ url: z.string().url(), token: z.string().min(1) })
    .parse(JSON.parse(readFileSync(path, 'utf8')))
  return { url: parsed.url.replace(/\/+$/, ''), token: parsed.token }
}

/** A plain HTTP request's hang guard (a non-LLM call): the job itself is polled, never bounded. */
const REQUEST_TIMEOUT_MS = 30_000

export function createEngineClient(endpoint: EngineEndpoint, fetchImpl: typeof fetch = fetch): EngineClient {
  const call = async (path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> => {
    const response = await fetchImpl(`${endpoint.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
    const text = await response.text()
    if (!response.ok)
      throw new Error(`engine ${init.method ?? 'GET'} ${path}: HTTP ${response.status} ${text.slice(0, 200)}`)
    return JSON.parse(text)
  }
  return {
    async submit(input, signal) {
      const body = await call('/research', { method: 'POST', body: JSON.stringify(input) }, signal)
      return z.object({ jobId: z.string().min(1), status: EngineJob.shape.status }).parse(body)
    },
    async poll(jobId, signal) {
      return EngineJob.parse(await call(`/research/${encodeURIComponent(jobId)}`, { method: 'GET' }, signal))
    },
  }
}

/** Resolves after `ms`, rejects at once on abort; the listener goes with the timer either way. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** A job the engine ended as `error` or `cancelled`: its id, and what it reported it cost (null: nothing). */
export class EngineJobFailed extends Error {
  override name = 'EngineJobFailed'
  constructor(
    readonly jobId: string,
    readonly costUsd: number | null,
    message: string,
  ) {
    super(message)
  }
}

/** A job of this call: started now, or adopted (already done under its key, so already paid for by whoever ran it). */
export type EngineRun = { jobId: string; report: EngineReport; adopted: boolean }

/**
 * Runs one job to its end under the shared key rule (`withAttemptKeys`): a key whose job is done is adopted, a key
 * whose job ended in error or was cancelled is stepped past, and a queued or running job is polled. The job has no
 * cap; a poll that fails transiently is retried on the next tick. The engine answers a submit with the job already
 * under the key and its status, which is what tells the cases apart.
 */
export async function runEngineJob(
  client: EngineClient,
  input: { query: string; depth: Depth; context?: string; idempotencyKey: string },
  options: { signal: AbortSignal; progress?: () => void; pollMs?: number; maxPollFailures?: number },
): Promise<EngineRun> {
  const { signal, pollMs = 2_000, maxPollFailures = 10 } = options
  return withAttemptKeys(input.idempotencyKey, async (key): Promise<KeyAttempt<EngineRun>> => {
    const submitted = await client.submit({ ...input, idempotencyKey: key }, signal)
    if (submitted.status === 'error' || submitted.status === 'cancelled') return { failedBefore: true }
    const adopted = submitted.status === 'done'
    const { jobId } = submitted
    let failures = 0
    for (let first = true; ; first = false) {
      if (!(first && adopted)) await sleep(pollMs, signal)
      let job: EngineJob
      try {
        job = await client.poll(jobId, signal)
      } catch (error) {
        if (signal.aborted || ++failures >= maxPollFailures) throw error
        continue
      }
      failures = 0
      options.progress?.()
      if (job.status === 'done') {
        if (!job.result) throw new Error(`engine job ${jobId} is done without a report`)
        return { value: { jobId, report: job.result, adopted } }
      }
      if (job.status === 'error' || job.status === 'cancelled') {
        const cost = job.result?.cost?.totalUsd
        throw new EngineJobFailed(
          jobId,
          typeof cost === 'number' ? cost : null,
          `engine job ${jobId} ${job.status}: ${job.error ?? 'no reason given'}`,
        )
      }
    }
  })
}
