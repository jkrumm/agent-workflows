import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InfraError, WorkflowError } from '@agent-workflows/runtime'
import type { ExcalidrawFile } from './schema.ts'
import { EXIT_DEADLINE, EXIT_ORPHANED } from './watchdog.ts'

/** A skeleton the library cannot convert is the agent's mistake (`ok: false`); a child that dies is the host's. */
export type Hydration = { ok: true; file: ExcalidrawFile } | { ok: false; error: string }

/**
 * Turns a skeleton into a hydrated v2 document. The default runs the pinned `@excalidraw/excalidraw` in a short-lived
 * child process (`hydrate-child.ts`); tests inject their own.
 */
export type Hydrate = (skeleton: unknown[], signal: AbortSignal) => Promise<Hydration>

/** The library converts 30 elements in about 30 ms after a 100 ms import; this only bounds a hung child. */
export const HYDRATE_TIMEOUT_MS = 30_000
/** A call waits this long for one of the {@link MAX_CONCURRENT_HYDRATIONS} slots before it gives up. */
export const QUEUE_WAIT_MS = 60_000
/** Children alive at once; the rest of the calls queue. Each holds the library and the fonts, about 150 MB. */
export const MAX_CONCURRENT_HYDRATIONS = 2
/** The child's own deadline is the host's timeout plus this, so it never fires before the host has acted. */
export const CHILD_DEADLINE_MARGIN_MS = 5_000
/** A 400-element document is about 0.4 MB; this bounds a child that floods its stdout. */
export const MAX_REPLY_BYTES = 32 * 1024 * 1024
/** The last of stderr that makes it into an error message; the rest is read and dropped. */
const STDERR_KEEP = 4 * 1024
/** The child only needs to find Bun's packages, a home and a temp dir; nothing else of the host's environment (secrets). */
const CHILD_ENV = ['PATH', 'HOME', 'TMPDIR'] as const

/** What the library writes as the document's origin is the shim's `location`; the app writes this. */
const SOURCE = 'https://excalidraw.com'
const CHILD = fileURLToPath(new URL('./hydrate-child.ts', import.meta.url))

type Reply = { ok: true; document: string } | { ok: false; error: string }

/** At most `limit` runs at once; the rest wait in order. A waiter whose signal aborts leaves the queue. */
export function limiter(limit: number) {
  let active = 0
  const waiting: (() => void)[] = []
  // A finishing run hands its slot to the next waiter without freeing it, so `active` never exceeds the limit.
  const release = () => {
    const next = waiting.shift()
    if (next) next()
    else active--
  }
  async function acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (active < limit) {
      active++
      return
    }
    let granted = false
    let grant!: () => void
    const turn = new Promise<void>((resolve) => {
      grant = () => {
        granted = true
        resolve()
      }
    })
    waiting.push(grant)
    let onAbort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      await Promise.race([turn, aborted])
    } catch (error) {
      // The abort won. The slot may have been handed over in the same tick: give it back, else leave the queue.
      if (granted) release()
      else waiting.splice(waiting.indexOf(grant), 1)
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
  return async function limited<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    await acquire(signal)
    // The slot is ours, but an abort may have landed between the hand-over and this resume: give it back, do not start.
    if (signal.aborted) {
      release()
      throw signal.reason
    }
    try {
      return await run()
    } finally {
      release()
    }
  }
}

/** The stream's text, or null once it is over `max` bytes: the caller kills the child. `keep: 'tail'` never gives up. */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  max: number,
  keep: 'all' | 'tail',
): Promise<string | null> {
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
    if (keep === 'all' && size > max) {
      reader.cancel().catch(() => {})
      return null
    }
    // A tail keeps the last `max` bytes: drop whole chunks from the front once they are not needed.
    while (keep === 'tail' && size - (chunks[0]?.byteLength ?? 0) >= max) size -= chunks.shift()?.byteLength ?? 0
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks))
  return keep === 'tail' ? text.slice(-max) : text
}

export type ChildOptions = {
  /** The child script (`bun <script>`: stdin `{ skeleton }`, stdout a {@link Reply}); default `hydrate-child.ts`. */
  script?: string
  /** Replaces the whole command, for tests that fake the child. */
  command?: string[]
  timeoutMs?: number
  queueWaitMs?: number
  maxReplyBytes?: number
  maxConcurrent?: number
  /** Told the child's PID once spawned (tests check it is gone afterwards). */
  onSpawn?: (pid: number) => void
}

/**
 * One child process per call: the DOM shim, the native canvas and its process-wide font registry live and die with it,
 * so a native crash or an OOM kill cannot take the host down and nothing accumulates in the host. A child is killed by
 * its PID on timeout or abort; a silent exit is seen at once (the pipes close). It runs from its package directory (no
 * `.env` or `bunfig.toml` of the host's cwd), with `NODE_ENV=production` (the library multiplies its measured widths by
 * 10 when it believes it runs under a test runner) and `PATH`, `HOME`, `TMPDIR` only; it ends itself after the timeout
 * plus a margin, and when its parent is gone (`watchdog.ts`).
 *
 * Errors, by who owns them: a conversion error is a `{ ok: false }` result (the agent's skeleton); a child that cannot
 * run (setup failed, crashed, was killed, flooded its output) is an `InfraError`, which the runtime does not retry as a
 * step but takes the run back for; a timeout, or a queue wait over {@link QUEUE_WAIT_MS}, is a `timeout` failure that is
 * not retried: the same skeleton would hang again.
 */
export function childHydrate(options: ChildOptions = {}): Hydrate {
  const script = options.script ?? CHILD
  const command = options.command ?? [process.execPath, script]
  const cwd = join(dirname(script), '..', '..', '..')
  const timeoutMs = options.timeoutMs ?? HYDRATE_TIMEOUT_MS
  const queueWaitMs = options.queueWaitMs ?? QUEUE_WAIT_MS
  const maxReply = options.maxReplyBytes ?? MAX_REPLY_BYTES
  const limited = limiter(options.maxConcurrent ?? MAX_CONCURRENT_HYDRATIONS)
  const env: Record<string, string> = {
    NODE_ENV: 'production',
    AGW_HYDRATE_DEADLINE_MS: String(timeoutMs + CHILD_DEADLINE_MARGIN_MS),
  }
  for (const key of CHILD_ENV) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }

  async function call(skeleton: unknown[], signal: AbortSignal): Promise<Hydration> {
    signal.throwIfAborted()
    const proc = Bun.spawn(command, {
      cwd,
      env,
      stdin: Buffer.from(JSON.stringify({ skeleton })),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    options.onSpawn?.(proc.pid)
    let killedFor: 'timeout' | 'abort' | 'output' | null = null
    const kill = (why: 'timeout' | 'abort' | 'output') => {
      killedFor ??= why
      proc.kill('SIGKILL')
    }
    const timer = setTimeout(() => kill('timeout'), timeoutMs)
    const onAbort = () => kill('abort')
    signal.addEventListener('abort', onAbort, { once: true })
    let out: string | null
    let err: string | null
    let code: number | null
    try {
      ;[out, err, code] = await Promise.all([
        readCapped(proc.stdout, maxReply, 'all').then((text) => {
          if (text === null) kill('output')
          return text
        }),
        readCapped(proc.stderr, STDERR_KEEP, 'tail'),
        proc.exited,
      ])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      proc.kill('SIGKILL') // a no-op for an exited child; covers an error while reading
    }
    if (killedFor === 'abort') throw signal.reason
    if (killedFor === 'timeout') throw new WorkflowError('timeout', `hydration timed out after ${timeoutMs} ms`)
    if (killedFor === 'output' || out === null)
      throw new InfraError(`hydration process wrote over ${maxReply} bytes to stdout`)
    if (code !== 0) {
      const why = code === EXIT_DEADLINE ? 'hit its own deadline' : code === EXIT_ORPHANED ? 'lost its parent' : null
      const tail = (err ?? '').trim()
      throw new InfraError(
        `hydration process ${why ?? proc.signalCode ?? `exited with ${code}`}${tail ? `: ${tail}` : ''}`,
      )
    }
    let reply: Reply
    let file: ExcalidrawFile
    try {
      reply = JSON.parse(out) as Reply
      if (!reply.ok) return { ok: false, error: reply.error }
      file = JSON.parse(reply.document) as ExcalidrawFile
    } catch {
      throw new InfraError(`hydration process answered something that is not a document: ${out.slice(0, 120)}`)
    }
    if (file?.type !== 'excalidraw' || file.version !== 2)
      throw new InfraError(`unexpected hydration output: type=${file?.type} version=${file?.version}`)
    return { ok: true, file: { ...file, source: SOURCE } }
  }

  return (skeleton, signal) => {
    // The wait for a slot counts against the call: a queue that does not move is a timeout, not a hang.
    const queued = AbortSignal.any([signal, AbortSignal.timeout(queueWaitMs)])
    return limited(queued, () => call(skeleton, signal)).catch((error: unknown) => {
      if (!signal.aborted && queued.aborted && error === queued.reason)
        throw new WorkflowError('timeout', `hydration waited over ${queueWaitMs} ms for a slot`)
      throw error
    })
  }
}

/** The host's hydrator: one shared queue, so the cap holds across all runs in the process. */
export const processHydrate: Hydrate = childHydrate()
