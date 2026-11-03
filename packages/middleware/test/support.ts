import type { ReadableSpan } from '@opentelemetry/sdk-trace'

export { captureLogger, freshSchema, inspector, PG_URL, testRuntime, until } from '../../runtime/test/support/pg.ts'

export function attr(span: ReadableSpan, key: string) {
  return span.attributes[key]
}

export function parentOf(span: ReadableSpan): string | undefined {
  return span.parentSpanContext?.spanId
}
