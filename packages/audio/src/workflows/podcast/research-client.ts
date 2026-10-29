import type { ResearchAnswer, ResearchPort } from './ports.ts'

// The host's `research` workflow over its HTTP API (host `operations.ts`): `POST /workflows/research` starts a run and
// holds the request up to `Prefer: wait`, `POST /runs/{id}/wait` keeps waiting. No time cap: a research run ends on
// its own (done, failed or cancelled; the host's watchdog turns a stalled one into a failure), as legacy waited on
// research-gateway. The bearer is the platform's API secret from the process env; the run carries this run's purpose.

/** One held request; the host answers before Bun's 255 s idle ceiling (`MAX_WAIT_S`). */
const WAIT_S = 240
/** A run ends with its cost once its post hooks delivered; ask a few times more for it, then report it unpriced. */
const COST_POLLS = 3

export interface ResearchClientOptions {
  /** `AGW_URL` (the host's base URL). */
  url: string
  /** `AGW_API_SECRET`. */
  secret: string
  /** Becomes the research runs' `x-agw-purpose`. */
  purpose: string
  fetch?: (url: string, init: RequestInit) => Promise<Response>
}

type RunState = {
  runId?: string
  status?: string
  output?: { report?: unknown; sources?: unknown }
  error?: { kind?: string; message?: string }
  cost?: number | null
  costPending?: true
}

/** From the process env; null when the host's URL or secret is missing (the `research` tool is then absent). */
export function researchClientFromEnv(
  env: Record<string, string | undefined>,
  purpose: string,
): ResearchClientOptions | null {
  const url = env.AGW_URL?.trim().replace(/\/+$/, '')
  const secret = env.AGW_API_SECRET?.trim()
  return url && secret ? { url, secret, purpose } : null
}

export function researchClient(options: ResearchClientOptions): ResearchPort {
  const doFetch = options.fetch ?? fetch
  const headers = {
    authorization: `Bearer ${options.secret}`,
    'content-type': 'application/json',
    prefer: `wait=${WAIT_S}`,
    'x-agw-purpose': options.purpose,
  }
  async function post(path: string, body: unknown, signal: AbortSignal): Promise<RunState> {
    const res = await doFetch(`${options.url}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`research ${path} failed HTTP ${res.status} ${text.slice(0, 300)}`)
    return JSON.parse(text) as RunState
  }
  return {
    async run(query, depth, signal, progress): Promise<ResearchAnswer> {
      try {
        let state = await post('/workflows/research', { query, depth }, signal)
        const runId = state.runId
        if (!runId) return { ok: false, error: 'error: research start returned no run id' }
        for (let polls = 0; ; ) {
          progress()
          const ended = state.status === 'done' || state.status === 'failed' || state.status === 'cancelled'
          if (ended && (!state.costPending || polls >= COST_POLLS)) break
          if (ended) polls++
          state = await post(`/runs/${runId}/wait`, {}, signal)
        }
        if (state.status !== 'done') {
          return { ok: false, error: `error: research ${state.status}: ${state.error?.message ?? 'unknown error'}` }
        }
        const report = typeof state.output?.report === 'string' ? state.output.report : ''
        const sources = Array.isArray(state.output?.sources)
          ? state.output.sources.filter((s): s is string => typeof s === 'string')
          : []
        return { ok: true, report, sources, usd: typeof state.cost === 'number' ? state.cost : null, runId }
      } catch (err) {
        if (signal.aborted) throw err
        return { ok: false, error: `error: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  }
}
