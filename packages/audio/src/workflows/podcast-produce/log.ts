import type { Logger } from '../../../../runtime/src/index.ts'

// Production's log: the stages log fallbacks and best-effort failures as they happen. One sink per process, set by the
// workflow's factory from its deps; the default writes JSON lines to stderr.

let sink: Logger = {
  warn: (message, meta) => console.warn(JSON.stringify({ level: 'warn', scope: 'podcast.produce', message, ...meta })),
  error: (message, meta) =>
    console.error(JSON.stringify({ level: 'error', scope: 'podcast.produce', message, ...meta })),
}

export function setProduceLogger(logger: Logger) {
  sink = logger
}

export const log = {
  /** Informational lines go to `warn` with `info: true`: the platform `Logger` has no info level. */
  info: (message: string, meta?: Record<string, unknown>) => sink.warn(message, { ...meta, info: true }),
  warn: (message: string, meta?: Record<string, unknown>) => sink.warn(message, meta),
  error: (message: string, meta?: Record<string, unknown>) => sink.error(message, meta),
}

/** An error's message, for a log line or a result's `error` field. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
