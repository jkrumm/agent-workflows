/** Longer than the runtime's body grace (30 s) plus the server's 5 s drain: past it, the process is stuck. */
export const HARD_EXIT_MS = 45_000

export interface LifecycleOptions {
  /** Stop accepting, close the runtime and the pools. */
  shutdown: () => Promise<void>
  backstopMs?: number
  /** Default `process.exit`. */
  exit?: (code: number) => void
  proc?: Pick<NodeJS.Process, 'on'>
  log?: (message: string, meta?: unknown) => void
}

/**
 * The process's signal and crash policy. A first SIGTERM/SIGINT shuts down and exits 0; a second one exits at once.
 * Once shutdown starts, an unref'd timer exits regardless if a close hangs. An uncaught exception shuts down the
 * same way (exit 1); an unhandled rejection is logged and the process keeps serving.
 */
export function installLifecycle(options: LifecycleOptions) {
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const proc = options.proc ?? process
  const log = options.log ?? ((message, meta) => console.error(`[agw-host] ${message}`, meta ?? ''))
  let shuttingDown = false

  const begin = (reason: string, code: number) => {
    shuttingDown = true
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
