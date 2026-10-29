import type { Logger } from '../../../../runtime/src/index.ts'

// The room's log: the legacy modules log fallbacks and repairs as they happen. One sink per process, set by the
// workflow's factory from its deps; the default writes JSON lines to stderr. Nothing here is model-visible.

let sink: Logger = {
  warn: (message, meta) => console.warn(JSON.stringify({ level: 'warn', scope: 'podcast', message, ...meta })),
  error: (message, meta) => console.error(JSON.stringify({ level: 'error', scope: 'podcast', message, ...meta })),
}

export function setPodcastLogger(logger: Logger) {
  sink = logger
}

export const log = {
  /** Informational lines go to `warn` with `info: true`: the platform `Logger` has no info level. */
  info: (message: string, meta?: Record<string, unknown>) => sink.warn(message, { ...meta, info: true }),
  warn: (message: string, meta?: Record<string, unknown>) => sink.warn(message, meta),
  error: (message: string, meta?: Record<string, unknown>) => sink.error(message, meta),
}
