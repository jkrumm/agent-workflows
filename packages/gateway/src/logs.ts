import { type AnyValue, SeverityNumber } from '@opentelemetry/api'
import { type ExportResult, ExportResultCode } from '@opentelemetry/core'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
  type ReadableLogRecord,
} from '@opentelemetry/sdk-logs'
import { errorMessage, type Logger } from './log.ts'

const SERVICE_NAME = 'agw-gateway'
/** A shipped attribute value longer than this is cut: a log line is an event, not a payload. */
const MAX_VALUE_CHARS = 2000

export interface LogShipper {
  /** `base` with every warn and error also sent as an OTLP log record; `base` still writes its own line first. */
  wrap(base: Logger): Logger
  /** Flushes and closes. Never throws. */
  shutdown(): Promise<void>
}

/** A failed export goes to stderr and nowhere else: shipping its own failure would loop. */
class StderrReportingExporter implements LogRecordExporter {
  constructor(private readonly inner: LogRecordExporter) {}

  export(logs: ReadableLogRecord[], done: (result: ExportResult) => void): void {
    this.inner.export(logs, (result) => {
      if (result.code !== ExportResultCode.SUCCESS) {
        const reason = result.error ? errorMessage(result.error) : 'unknown'
        process.stderr.write(`agw-gateway: log export failed (${logs.length} records): ${reason}\n`)
      }
      done(result)
    })
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush()
  }
}

/** The exporter of the standard OTLP env; none without an endpoint, as for spans. */
function exporterFor(env: Record<string, string | undefined>): LogRecordExporter | null {
  const endpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  return endpoint ? new OTLPLogExporter() : null
}

/** The secret shapes a log field could carry by accident: bearer tokens, `sk-` keys and the password of a URL. */
const redact = (text: string): string =>
  text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, 'sk-[redacted]')
    .replace(/(\w+:\/\/[^\s:/@]+:)[^\s@]+@/g, '$1[redacted]@')

const cut = (text: string): string => (text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text)

function valueOf(value: unknown): AnyValue | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return cut(redact(value))
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Error) return cut(redact(`${value.name}: ${value.message}`))
  try {
    return cut(redact(JSON.stringify(value)))
  } catch {
    return undefined
  }
}

function attributesOf(fields: Record<string, unknown> | undefined): Record<string, AnyValue> {
  const out: Record<string, AnyValue> = {}
  if (fields === undefined) return out
  for (const [key, value] of Object.entries(fields)) {
    const converted = valueOf(value)
    if (converted !== undefined) out[key] = converted
  }
  return out
}

/**
 * Warn and error lines as OTLP logs, so `ledger write failed` is a row in ClickStack and not only a line in the
 * LaunchAgent's stderr file. Fields never carry a key or a connection string (`log.ts`); `redact` is the belt for the one that slips through. Off
 * without an OTLP endpoint (`wrap` hands `base` back). The resource carries `service.name` and `service.version`, as the
 * spans do.
 */
export function createLogShipper(options: {
  env: Record<string, string | undefined>
  version: string
  /** Replaces the env's exporter (tests). */
  exporter?: LogRecordExporter
  /** Batch delay. Default 1000 ms. */
  scheduledDelayMillis?: number
}): LogShipper {
  const exporter = options.exporter ?? exporterFor(options.env)
  if (exporter === null) return { wrap: (base) => base, shutdown: async () => {} }
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ 'service.name': SERVICE_NAME, 'service.version': options.version }),
    processors: [
      new BatchLogRecordProcessor({
        exporter: new StderrReportingExporter(exporter),
        scheduledDelayMillis: options.scheduledDelayMillis ?? 1000,
      }),
    ],
  })
  const logger = provider.getLogger(SERVICE_NAME)
  const emit = (
    severityNumber: SeverityNumber,
    severityText: string,
    message: string,
    fields?: Record<string, unknown>,
  ) => {
    try {
      logger.emit({ severityNumber, severityText, body: cut(redact(message)), attributes: attributesOf(fields) })
    } catch {
      // A record that cannot be built never takes the caller down; the base logger already wrote the line.
    }
  }
  return {
    wrap: (base) => ({
      info: (message, fields) => base.info(message, fields),
      warn(message, fields) {
        base.warn(message, fields)
        emit(SeverityNumber.WARN, 'WARN', message, fields)
      },
      error(message, fields) {
        base.error(message, fields)
        emit(SeverityNumber.ERROR, 'ERROR', message, fields)
      },
    }),
    shutdown: () => provider.shutdown().catch(() => {}),
  }
}
