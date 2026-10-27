import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace'
import { z } from 'zod'
import {
  ArgoPostError,
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
  /** Posts never answer (a wedged Argo); `inflight` counts the hanging ones. */
  hang = false
  inflight = 0
  /** Records Argo refuses with a 422: the whole batch is refused, as Argo does. */
  refuse: (record: ArgoUsageRecord) => boolean = () => false
  /** Thrown for every post while set (e.g. a 401 from a wrong secret). */
  failWith: Error | null = null
  /** Runs before a post is accepted (a test can inspect or change the journal mid-flush). */
  onPost: (records: ArgoUsageRecord[]) => Promise<void> = async () => {}
  failedPosts = 0
  posts = 0

  async post(records: ArgoUsageRecord[]): Promise<void> {
    this.posts++
    await this.onPost(records)
    if (this.failWith) {
      this.failedPosts++
      throw this.failWith
    }
    if (this.hang) {
      this.inflight++
      await new Promise(() => {})
    }
    await Bun.sleep(5)
    if (this.down) {
      this.failedPosts++
      throw new ArgoPostError('argo usage ingest: HTTP 503 down', false)
    }
    const parsed = ArgoBody.safeParse({ records })
    if (!parsed.success) throw new ArgoPostError(`argo usage ingest: HTTP 422 ${parsed.error.message}`, true)
    if (records.some(this.refuse)) throw new ArgoPostError('argo usage ingest: HTTP 422 refused record', true)
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
