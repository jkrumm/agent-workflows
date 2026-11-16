/** Longer than the runtime's body grace (30 s) plus the server's 5 s drain: past it, the process is stuck. */
export const HARD_EXIT_MS = 45_000

/** A repeat signal this soon after the first is the same stop arriving twice (a supervisor's TERM plus its wrapper's forward). */
export const REPEAT_GRACE_MS = 2_000

export interface LifecycleOptions {
  /** Stop accepting, close the runtime and the pools. */
  shutdown: () => Promise<void>
  backstopMs?: number
  repeatGraceMs?: number
  /** Default `Date.now`. */
  now?: () => number
  /** Default `process.exit`. */
  exit?: (code: number) => void
  proc?: Pick<NodeJS.Process, 'on'>
  log?: (message: string, meta?: unknown) => void
}

/**
 * The process's signal and crash policy. A first SIGTERM/SIGINT shuts down and exits 0; a repeat within `REPEAT_GRACE_MS` is the same stop
 * (launchd's TERM and the secrets-run wrapper's forward both reach the process) and is ignored; a later one exits at
 * once (1: an impatient Ctrl-C).
 * Once shutdown starts, an unref'd timer exits regardless if a close hangs. An uncaught exception shuts down the
 * same way (exit 1); an unhandled rejection is logged and the process keeps serving.
 */
export function installLifecycle(options: LifecycleOptions) {
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const proc = options.proc ?? process
  const log = options.log ?? ((message, meta) => console.error(`[agw-host] ${message}`, meta ?? ''))
  const now = options.now ?? Date.now
  let shuttingDown = false
  let beganAt = 0

  const begin = (reason: string, code: number) => {
    shuttingDown = true
    beganAt = now()
    log(`${reason}: shutting down`)
    setTimeout(() => {
      log('shutdown did not finish in time; exiting')
      exit(1)
    }, options.backstopMs ?? HARD_EXIT_MS).unref()
    options.shutdown().then(
      () => exit(code),
      (error: unknown) => {
        log('shutdown failed', error instanceof Error ? error.message : error)
        exit(1)
      },
    )
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    proc.on(signal, () => {
      if (shuttingDown) {
        if (now() - beganAt < (options.repeatGraceMs ?? REPEAT_GRACE_MS)) {
          log(`${signal} repeated during shutdown: ignored`)
          return
        }
        log(`${signal} during shutdown: exiting now`)
        exit(1)
        return
      }
      begin(signal, 0)
    })
  }
  proc.on('uncaughtException', (error: unknown) => {
    log('uncaughtException', error)
    if (!shuttingDown) begin('uncaughtException', 1)
  })
  proc.on('unhandledRejection', (reason: unknown) => {
    log('unhandledRejection (still serving)', reason)
  })
}
