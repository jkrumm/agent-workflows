import { describe, expect, test } from 'bun:test'
import type { Logger } from '@agent-workflows/runtime'
import { SeverityNumber } from '@opentelemetry/api'
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs'
import { createLogShipper, Telemetry } from '../src/index.ts'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace'

const collector = (): LogRecordExporter & { records: ReadableLogRecord[] } => {
  const records: ReadableLogRecord[] = []
  return {
    records,
    export: (logs, done) => {
      records.push(...logs)
      done({ code: 0 })
    },
    shutdown: async () => {},
    forceFlush: async () => {},
  }
}

const quiet: Logger = { warn: () => {}, error: () => {} }

const OPTIONS = { env: {}, serviceName: 'agw-test', version: 'abc123def456', scheduledDelayMillis: 1 }

const sink = (): Logger & { lines: string[] } => {
  const lines: string[] = []
  return {
    lines,
    warn: (message) => void lines.push(`warn ${message}`),
    error: (message) => void lines.push(`error ${message}`),
  }
}

describe('createLogShipper', () => {
  test('warn and error go to the base logger and to OTLP with the resource, severity and fields', async () => {
    const exporter = collector()
    const shipper = createLogShipper({ ...OPTIONS, exporter })
    const base = sink()
    const logger = shipper.wrap(base)
    logger.warn('pool drained', { pool: 'iu', left: 0.5, nested: { a: 1 }, absent: undefined })
    logger.error('ledger write failed', { error: new Error('disk full') })
    await shipper.shutdown()
    expect(base.lines).toEqual(['warn pool drained', 'error ledger write failed'])
    const [warn, error] = exporter.records
    expect(warn?.body).toBe('pool drained')
    expect(warn?.severityNumber).toBe(SeverityNumber.WARN)
    expect(warn?.attributes).toEqual({ pool: 'iu', left: 0.5, nested: '{"a":1}' })
    expect(warn?.resource.attributes).toMatchObject({ 'service.name': 'agw-test', 'service.version': 'abc123def456' })
    expect(error?.severityNumber).toBe(SeverityNumber.ERROR)
    expect(error?.attributes.error).toBe('Error: disk full')
  })

  test('a secret in a message or a field never ships', async () => {
    const exporter = collector()
    const shipper = createLogShipper({ ...OPTIONS, exporter })
    shipper.wrap(sink()).error('call failed: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz0123', {
      detail: 'authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz0123',
    })
    await shipper.shutdown()
    expect(JSON.stringify(exporter.records.map((r) => [r.body, r.attributes]))).not.toContain(
      'abcdefghijklmnopqrstuvwxyz0123',
    )
  })

  test('a value past 2000 characters is cut', async () => {
    const exporter = collector()
    const shipper = createLogShipper({ ...OPTIONS, exporter })
    shipper.wrap(sink()).warn('big', { text: 'x'.repeat(5000) })
    await shipper.shutdown()
    expect(String(exporter.records[0]?.attributes.text).length).toBeLessThanOrEqual(2001)
  })

  test('without an OTLP endpoint the base logger comes back untouched', () => {
    const base = sink()
    const shipper = createLogShipper({ env: {}, serviceName: 'agw', version: 'dev' })
    expect(shipper.wrap(base)).toBe(base)
  })
})

describe('service.version', () => {
  const resourceOf = async (options: { version?: string }) => {
    const spans = new InMemorySpanExporter()
    const t = new Telemetry({ logger: quiet, exporter: spans, scheduledDelayMillis: 1, ...options })
    t.provider.getTracer('test').startSpan('s').end()
    await t.flush()
    const attributes = spans.getFinishedSpans()[0]?.resource.attributes
    await t.shutdown()
    return attributes
  }

  test('is on the span resource when given, absent when not', async () => {
    expect(await resourceOf({ version: 'abc123' })).toMatchObject({
      'service.name': 'agw',
      'service.version': 'abc123',
    })
    expect(await resourceOf({})).not.toHaveProperty('service.version')
  })
})
