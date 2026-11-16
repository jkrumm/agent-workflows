import { describe, expect, test } from 'bun:test'
import { SeverityNumber } from '@opentelemetry/api'
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs'
import type { Logger } from '../src/log.ts'
import { createLogShipper } from '../src/logs.ts'

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

const sink = (): Logger & { lines: string[] } => {
  const lines: string[] = []
  return {
    lines,
    info: (message) => void lines.push(`info ${message}`),
    warn: (message) => void lines.push(`warn ${message}`),
    error: (message) => void lines.push(`error ${message}`),
  }
}

describe('createLogShipper', () => {
  test('warn and error ship with the gateway resource; info stays on stderr only', async () => {
    const exporter = collector()
    const shipper = createLogShipper({ env: {}, version: 'abc123', exporter, scheduledDelayMillis: 1 })
    const base = sink()
    const logger = shipper.wrap(base)
    logger.info('listening', { port: 7794 })
    logger.warn('telemetry: span export failed', { spans: 3 })
    logger.error('ledger write failed; the row is lost', { requestId: 'r1' })
    await shipper.shutdown()
    expect(base.lines).toEqual([
      'info listening',
      'warn telemetry: span export failed',
      'error ledger write failed; the row is lost',
    ])
    const records = exporter.records
    expect(records.map((r) => r.body)).toEqual([
      'telemetry: span export failed',
      'ledger write failed; the row is lost',
    ])
    expect(records.map((r) => r.severityNumber)).toEqual([SeverityNumber.WARN, SeverityNumber.ERROR])
    expect(records[0]?.attributes).toEqual({ spans: 3 })
    expect(records[0]?.resource.attributes).toMatchObject({
      'service.name': 'agw-gateway',
      'service.version': 'abc123',
    })
  })

  test('without an OTLP endpoint the base logger comes back untouched', () => {
    const base = sink()
    expect(createLogShipper({ env: {}, version: 'dev' }).wrap(base)).toBe(base)
  })
})
