import { type Attributes, type Context, ROOT_CONTEXT, type Span, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { type ExportResult, ExportResultCode, W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter, TracerProvider } from '@opentelemetry/sdk-trace'
import type { Logger } from './log.ts'

const SERVICE_NAME = 'agw-gateway'

export interface RequestSpan {
  set(attributes: Attributes): void
  end(error: boolean): void
}

export interface Telemetry {
  /** One span per request; its parent is the inbound `traceparent`. */
  span(name: string, headers: Headers): RequestSpan
  shutdown(): Promise<void>
}

/** Export failures are logged, never thrown into a request. */
class LoggingExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly logger: Logger,
  ) {}

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.inner.export(spans, (result) => {
      if (result.code !== ExportResultCode.SUCCESS) {
        this.logger.warn('telemetry: span export failed', { spans: spans.length, error: result.error?.message })
      }
      done(result)
    })
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }
}

/** The exporter of the standard OTLP env, none without an endpoint (the default would retry localhost forever). */
function exporterFor(env: Record<string, string | undefined>): SpanExporter | null {
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  return endpoint ? new OTLPTraceExporter() : null
}

export function createTelemetry(options: {
  env: Record<string, string | undefined>
  logger: Logger
  /** Replaces the env's exporter (tests). */
  exporter?: SpanExporter
  /** Batch delay. Default 1000 ms. */
  scheduledDelayMillis?: number
}): Telemetry {
  const exporter = options.exporter ?? exporterFor(options.env)
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ 'service.name': SERVICE_NAME }),
    spanProcessors:
      exporter === null
        ? []
        : [
            new BatchSpanProcessor({
              exporter: new LoggingExporter(exporter, options.logger),
              scheduledDelayMillis: options.scheduledDelayMillis ?? 1000,
            }),
          ],
  })
  const tracer = provider.getTracer(SERVICE_NAME)
  const propagator = new W3CTraceContextPropagator()
  const parentOf = (headers: Headers): Context =>
    propagator.extract(ROOT_CONTEXT, headers, {
      keys: (carrier) => [...carrier.keys()],
      get: (carrier, key) => carrier.get(key) ?? undefined,
    })
  return {
    span(name, headers) {
      const span: Span = tracer.startSpan(name, { kind: SpanKind.SERVER }, parentOf(headers))
      return {
        set: (attributes) => void span.setAttributes(attributes),
        end(error) {
          if (error) span.setStatus({ code: SpanStatusCode.ERROR })
          span.end()
        },
      }
    },
    shutdown: () => provider.shutdown(),
  }
}
