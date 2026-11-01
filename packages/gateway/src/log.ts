export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

const line = (level: string, message: string, fields?: Record<string, unknown>): string =>
  `${JSON.stringify({ t: new Date().toISOString(), level, service: 'agw-gateway', message, ...fields })}\n`

/** One JSON line per event on stderr, which the LaunchAgent keeps. Fields never carry a key or a connection string. */
export const stderrLogger: Logger = {
  info: (message, fields) => void process.stderr.write(line('info', message, fields)),
  warn: (message, fields) => void process.stderr.write(line('warn', message, fields)),
  error: (message, fields) => void process.stderr.write(line('error', message, fields)),
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
