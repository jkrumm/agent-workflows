import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace'
import { z } from 'zod'
import {
  type ArgoTransport,
  type ArgoUsageRecord,
  ArgoUsageRecordInput,
  type FingerprintInputs,
  type FingerprintSource,
  type Platform,
  type PlatformOptions,
  platformMiddleware,
} from '../src/index.ts'
import { captureLogger, PG_URL } from '../../runtime/test/support/pg.ts'

export { captureLogger, freshSchema, inspector, PG_URL, testRuntime, until } from '../../runtime/test/support/pg.ts'

const ArgoBody = z.object({ records: z.array(ArgoUsageRecordInput).min(1).max(1000) })

/** Argo's usage ingest in memory: validates like Argo, upserts on (source, source_id, machine), can be down. */
export class FakeArgo implements ArgoTransport {
  readonly stored = new Map<string, ArgoUsageRecord>()
  /** Accepted posts per source_id: a duplicate post shows here even though the upsert would hide it. */
  readonly accepted = new Map<string, number>()
  down = false
  failedPosts = 0
  posts = 0

  async post(records: ArgoUsageRecord[]): Promise<void> {
    this.posts++
    await Bun.sleep(5)
    if (this.down) {
      this.failedPosts++
      throw new Error('argo usage ingest: HTTP 503 down')
    }
    const parsed = ArgoBody.safeParse({ records })
    if (!parsed.success) throw new Error(`argo usage ingest: HTTP 422 ${parsed.error.message}`)
    for (const r of records) {
      this.stored.set(`${r.source}|${r.source_id}|${r.machine}`, r)
      this.accepted.set(r.source_id, (this.accepted.get(r.source_id) ?? 0) + 1)
    }
  }
}

/** A fingerprint source whose inputs a test can change between processes. */
export function fakeFingerprint(inputs: FingerprintInputs = defaultInputs()): FingerprintSource & {
  inputs: FingerprintSource['inputs']
  current: FingerprintInputs
} {
  const source = {
    current: inputs,
    inputs: async () => structuredClone(source.current),
  }
  return source
}

export function defaultInputs(): FingerprintInputs {
  return {
    agents: [{ name: 'brain', files: { 'AGENTS.md': '# brain' }, route: 'route-fp-1' }],
    opencodeVersion: '2.0.32',
  }
}

/** Keeps its spans across `shutdown()` (the in-memory exporter clears them), so a closed process can be inspected. */
class KeepingExporter extends InMemorySpanExporter {
  override shutdown(): Promise<void> {
    return Promise.resolve()
  }
}

export type TestPlatform = Platform & { spans: InMemorySpanExporter; logger: ReturnType<typeof captureLogger> }

export function testPlatform(
  schema: string,
  options: Partial<Omit<PlatformOptions, 'connectionString' | 'schema'>> = {},
): TestPlatform {
  const spans = new KeepingExporter()
  const logger = captureLogger()
  const platform = platformMiddleware({
    connectionString: PG_URL,
    schema,
    logger,
    fingerprint: fakeFingerprint(),
    telemetry: { exporter: spans, scheduledDelayMillis: 50 },
    argo: { transport: null },
    ...options,
  })
  return { ...platform, spans, logger }
}

export function attr(span: ReadableSpan, key: string) {
  return span.attributes[key]
}

export function parentOf(span: ReadableSpan): string | undefined {
  return span.parentSpanContext?.spanId
}
