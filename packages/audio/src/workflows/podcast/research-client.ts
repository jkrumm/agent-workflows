import type { ResearchAnswer, ResearchPort } from './ports.ts'

// The host's `research` workflow over its HTTP API (host `operations.ts`): `POST /workflows/research` starts a run under
// an `Idempotency-Key` and holds the request up to `Prefer: wait`; `POST /runs/{id}/wait` keeps waiting. The key makes
// the start re-attachable: a resumed or retried podcast step that asks the same question gets the run it already
// started (and paid for), never a second one. No time cap on the wait: a research run ends on its own (the host's
// watchdog turns a stalled one into a failure). A transient failure of a start or a wait (network, 5xx) is retried on
// the same key or run id; an abort of the podcast step cancels the host run. The bearer is the platform's API secret
// from the process env; the run carries the podcast's purpose.

/** One held request; the host answers before Bun's 255 s idle ceiling (`MAX_WAIT_S`). */
const WAIT_S = 240
/** Consecutive transient failures of one request before the tool reports an error (the run itself goes on). */
const TRANSIENT_ATTEMPTS = 5

export interface ResearchClientOptions {
  /** `AGW_URL` (the host's base URL). */
  url: string
  /** `AGW_API_SECRET`. */
  secret: string
  /** Becomes the research runs' `x-agw-purpose`. */
  purpose: string
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  /** Base of the 3x backoff between transient retries. Default 1000 ms. */
  backoffMs?: number
}

type RunState = {
  runId?: string
  status?: string
  output?: { report?: unknown; sources?: unknown }
  error?: { kind?: string; message?: string }
}

/** A failure worth repeating the same request for: the request is idempotent (a key, or a run id). */
class Transient extends Error {}

/** From the process env; null when the host's URL or secret is missing (the `research` tool is then absent). */
export function researchClientFromEnv(
  env: Record<string, string | undefined>,
  purpose: string,
): ResearchClientOptions | null {
  const url = env.AGW_URL?.trim().replace(/\/+$/, '')
  const secret = env.AGW_API_SECRET?.trim()
  return url && secret ? { url, secret, purpose } : null
}

const ENDED = new Set(['done', 'failed', 'cancelled'])

export function researchClient(options: ResearchClientOptions): ResearchPort {
  const doFetch = options.fetch ?? fetch
  const backoffMs = options.backoffMs ?? 1000
  const headers = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${options.secret}`,
    'content-type': 'application/json',
    prefer: `wait=${WAIT_S}`,
    'x-agw-purpose': options.purpose,
    ...extra,
  })

  async function post(path: string, body: unknown, signal: AbortSignal, extra?: Record<string, string>) {
    let res: Response
    try {
      res = await doFetch(`${options.url}${path}`, {
        method: 'POST',
        headers: headers(extra),
        body: JSON.stringify(body),
        signal,
      })
    } catch (err) {
      if (signal.aborted) throw err
      throw new Transient(err instanceof Error ? err.message : String(err))
    }
    const text = await res.text().catch(() => '')
    if (res.status >= 500 || res.status === 429) throw new Transient(`HTTP ${res.status} ${text.slice(0, 200)}`)
    if (!res.ok) throw new Error(`research ${path} failed HTTP ${res.status} ${text.slice(0, 300)}`)
    try {
      return JSON.parse(text) as RunState
    } catch {
      throw new Transient(`research ${path}: body is not JSON`)
    }
  }

  /** The same idempotent request until it answers, a non-transient error, or the attempts are spent. */
  async function retrying(signal: AbortSignal, request: () => Promise<RunState>): Promise<RunState> {
    for (let i = 1; ; i++) {
      try {
        return await request()
      } catch (err) {
        if (signal.aborted || !(err instanceof Transient) || i >= TRANSIENT_ATTEMPTS) throw err
        await new Promise((resolve) => setTimeout(resolve, backoffMs * 3 ** (i - 1)))
      }
    }
  }

  /** Best effort: the podcast step is ending, the host run must not go on paying. */
  async function cancel(runId: string) {
    await doFetch(`${options.url}/runs/${runId}/cancel`, {
      method: 'POST',
      headers: headers(),
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined)
  }

  return {
    async run(query, depth, { key, signal, progress }): Promise<ResearchAnswer> {
      let runId: string | undefined
      try {
        let state = await retrying(signal, () =>
          post('/workflows/research', { query, depth }, signal, { 'idempotency-key': key }),
        )
        runId = state.runId
        if (!runId) return { ok: false, error: 'error: research start returned no run id' }
        const id = runId
        while (!ENDED.has(state.status ?? '')) {
          progress()
          state = await retrying(signal, () => post(`/runs/${id}/wait`, {}, signal))
        }
        progress()
        if (state.status !== 'done') {
          return { ok: false, error: `error: research ${state.status}: ${state.error?.message ?? 'unknown error'}` }
        }
        const report = typeof state.output?.report === 'string' ? state.output.report : ''
        const sources = Array.isArray(state.output?.sources)
          ? state.output.sources.filter((s): s is string => typeof s === 'string')
          : []
        return { ok: true, report, sources, runId: id }
      } catch (err) {
        if (signal.aborted) {
          if (runId) await cancel(runId)
          throw err
        }
        return { ok: false, error: `error: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  }
}
