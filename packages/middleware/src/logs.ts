import { redactSecrets } from '@agent-workflows/capabilities'
import type { Logger } from '@agent-workflows/runtime'
import { type AnyValue, SeverityNumber } from '@opentelemetry/api'
import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode } from '@opentelemetry/core'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
  type ReadableLogRecord,
} from '@opentelemetry/sdk-logs'
import { errorMessage } from './db.ts'
import { resourceAttributes } from './resource.ts'

/** A shipped attribute value longer than this is cut: a log line is an event, not a payload. */
const MAX_VALUE_CHARS = 2000

export type LogShipperOptions = {
  env: Record<string, string | undefined>
  /** `service.name`, the same as the process's spans. */
  serviceName: string
  /** `service.version`, the deployed sha. */
  version: string
  /** `host.name`, the same as the process's spans (`AGW_MACHINE`). */
  machine?: string
  /** Replaces the env's OTLP exporter (tests). */
  exporter?: LogRecordExporter
  /** Batch delay. Default 1000 ms. */
  scheduledDelayMillis?: number
}

export type LogShipper = {
  /** `base` with every warn and error also sent as an OTLP log record; `base` still writes its own line first. */
  wrap(base: Logger): Logger
  /** Flushes and closes, bounded by the exporter's own timeout. Never throws. */
  shutdown(): Promise<void>
}

/** A failed export goes to stderr and nowhere else: shipping its own failure would loop. */
class StderrReportingExporter implements LogRecordExporter {
  constructor(private readonly inner: LogRecordExporter) {}

  export(logs: ReadableLogRecord[], done: (result: ExportResult) => void): void {
    this.inner.export(logs, (result) => {
      if (result.code !== ExportResultCode.SUCCESS) {
        const reason = result.error ? errorMessage(result.error) : 'unknown'
        console.error(`[agw-logs] log export failed (${logs.length} records): ${reason}`)
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

const cut = (text: string): string => (text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text)

function valueOf(value: unknown): AnyValue | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return cut(redactSecrets(value))
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Error) return cut(redactSecrets(`${value.name}: ${value.message}`))
  try {
    return cut(redactSecrets(JSON.stringify(value)))
  } catch {
    return undefined
  }
}

function attributesOf(meta: Record<string, unknown> | undefined): Record<string, AnyValue> {
  const out: Record<string, AnyValue> = {}
  if (typeof meta !== 'object' || meta === null) return out
  for (const [key, value] of Object.entries(meta)) {
    const converted = valueOf(value)
    if (converted !== undefined) out[key] = converted
  }
  return out
}

/**
 * Warn and error lines of a process as OTLP logs, so a failure is a row in ClickStack and not a line in a file nobody
 * reads. Off without an OTLP endpoint (`wrap` hands `base` back). The resource carries `service.name` and
 * `service.version`, the same as the spans.
 */
export function createLogShipper(options: LogShipperOptions): LogShipper {
  const exporter = options.exporter ?? exporterFor(options.env)
  if (exporter === null) return { wrap: (base) => base, shutdown: async () => {} }
  const provider = new LoggerProvider({
    resource: resourceFromAttributes(
      resourceAttributes({ serviceName: options.serviceName, version: options.version, machine: options.machine }),
    ),
    processors: [
      new BatchLogRecordProcessor({
        exporter: new StderrReportingExporter(exporter),
        scheduledDelayMillis: options.scheduledDelayMillis ?? 1000,
      }),
    ],
  })
  const logger = provider.getLogger('agw')
  const emit = (
    severityNumber: SeverityNumber,
    severityText: string,
    message: string,
    meta?: Record<string, unknown>,
  ) => {
    try {
      logger.emit({
        severityNumber,
        severityText,
        body: cut(redactSecrets(message)),
        attributes: attributesOf(meta),
      })
    } catch {
      // A log record that cannot be built never takes the caller down; the base logger already wrote the line.
    }
  }
  return {
    wrap: (base) => ({
      warn(message, meta) {
        base.warn(message, meta)
        emit(SeverityNumber.WARN, 'WARN', message, meta)
      },
      error(message, meta) {
        base.error(message, meta)
        emit(SeverityNumber.ERROR, 'ERROR', message, meta)
      },
    }),
    shutdown: () => provider.shutdown().catch(() => {}),
  }
}
