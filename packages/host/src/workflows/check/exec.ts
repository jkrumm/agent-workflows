/** What one command run reports; the output is a bounded tail, never the whole log. */
export interface ExecResult {
  /** `null` when a signal ended the process. 127 when it could not be started. */
  exitCode: number | null
  /** The last `tailChars` characters of stdout and stderr, as they arrived. */
  output: string
  /** Killed because nothing was written for `idleMs`. */
  idleKilled: boolean
  /** Killed because `wallMs` passed (helper probes only). */
  timedOut: boolean
  /** Killed because `signal` aborted. */
  aborted: boolean
}

export interface ExecRequest {
  argv: string[]
  cwd: string
  /** Idle watchdog: kill after this long without new output. Never a wall-clock cap on a validation step. */
  idleMs?: number
  /** Wall-clock cap, for helper subprocesses (git, `make -p`) only. */
  wallMs?: number
  signal?: AbortSignal
  /** Called on every chunk the command writes; feeds the runtime's step idle timer. */
  onOutput?: () => void
  /** Trailing characters kept in `output`. Default {@link DEFAULT_TAIL_CHARS}. */
  tailChars?: number
  /** `merge` (default) keeps stderr in `output`; `discard` drops it. */
  stderr?: 'merge' | 'discard'
}

/** The subprocess port of the check workflows: `Bun.spawn` in production, a script in tests. */
export interface Exec {
  run(request: ExecRequest): Promise<ExecResult>
  /** The path of an installed executable, or null. */
  which(command: string): string | null
}

export const DEFAULT_TAIL_CHARS = 20_000
const KILL_GRACE_MS = 5_000
/** Once the leader is gone the pipes close; a writer that survived the group kill must not wedge the step. */
const DRAIN_GRACE_MS = 5_000

/**
 * Runs `argv` in `cwd` in its own process group, with the host's environment (`PWD` pinned to `cwd`: `Bun.spawn`'s
 * `cwd` does not update it, and a recipe reading `$PWD` would validate the wrong tree). The group is killed on idle,
 * wall time or abort, so a recipe's backgrounded child cannot outlive the step.
 */
export const bunExec: Exec = {
  which: (command) => Bun.which(command),
  async run(request) {
    const { argv, cwd, idleMs, wallMs, signal, onOutput } = request
    const tailChars = request.tailChars ?? DEFAULT_TAIL_CHARS
    let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
    try {
      proc = Bun.spawn(argv, {
        cwd,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, PWD: cwd },
        detached: true,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { exitCode: 127, output: message, idleKilled: false, timedOut: false, aborted: false }
    }

    const killGroup = (code: 'SIGTERM' | 'SIGKILL') => {
      try {
        process.kill(-proc.pid, code)
      } catch {
        // the group is already gone
      }
    }
    const state = { idleKilled: false, timedOut: false, aborted: false }
    const stopped = () => state.idleKilled || state.timedOut || state.aborted
    let escalation: ReturnType<typeof setTimeout> | undefined
    const terminate = () => {
      killGroup('SIGTERM')
      escalation ??= setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
    }

    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      if (idleMs === undefined || stopped()) return
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        state.idleKilled = true
        terminate()
      }, idleMs)
    }
    arm()
    const wallTimer =
      wallMs === undefined
        ? undefined
        : setTimeout(() => {
            state.timedOut = true
            terminate()
          }, wallMs)
    const onAbort = () => {
      state.aborted = true
      terminate()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

    let tail = ''
    const drain = async (stream: ReadableStream<Uint8Array>, keep: boolean) => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return
          arm()
          onOutput?.()
          if (!keep) continue
          tail += decoder.decode(value, { stream: true })
          if (tail.length > tailChars) tail = tail.slice(-tailChars)
        }
      } finally {
        reader.releaseLock()
      }
    }

    let drained = false
    const drains = Promise.all([drain(proc.stdout, true), drain(proc.stderr, request.stderr !== 'discard')]).then(
      () => {
        drained = true
      },
    )
    drains.catch(() => {}) // a read that fails after the grace below must not go unhandled
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await proc.exited
      // The leader is gone but a recipe can leave an orphan holding the pipes: kill the group, then bound the wait.
      if (!drained) killGroup('SIGKILL')
      await Promise.race([
        drains,
        new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, DRAIN_GRACE_MS)
        }),
      ])
    } finally {
      clearTimeout(idleTimer)
      clearTimeout(wallTimer)
      clearTimeout(graceTimer)
      clearTimeout(escalation)
      signal?.removeEventListener('abort', onAbort)
      killGroup('SIGKILL')
    }
    return { exitCode: proc.exitCode, output: tail, ...state }
  },
}
