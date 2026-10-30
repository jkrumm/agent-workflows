import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace'
import {
  type FingerprintInputs,
  type FingerprintSource,
  type Platform,
  type PlatformOptions,
  platformMiddleware,
  type UsageRow,
  type UsageTransport,
  UsageWriteError,
} from '../src/index.ts'
import { captureLogger, PG_URL } from '../../runtime/test/support/pg.ts'

export { captureLogger, freshSchema, inspector, PG_URL, testRuntime, until } from '../../runtime/test/support/pg.ts'

/** The usage database in memory: upserts on (source, source_id), can be down, can refuse rows, can hang. */
export class FakeUsage implements UsageTransport {
  readonly stored = new Map<string, UsageRow>()
  /** Accepted writes per source_id: a duplicate write shows here even though the upsert would hide it. */
  readonly accepted = new Map<string, number>()
  down = false
  /** Writes never answer (a wedged database); `inflight` counts the hanging ones. */
  hang = false
  inflight = 0
  /** Rows the database refuses (a constraint violation): the whole batch is refused, as a transaction is. */
  refuse: (row: UsageRow) => boolean = () => false
  /** Thrown for every write while set (e.g. an authentication failure). */
  failWith: Error | null = null
  /** Runs before a write is accepted (a test can inspect or change the journal mid-flush). */
  onPost: (rows: UsageRow[]) => Promise<void> = async () => {}
  failedPosts = 0
  posts = 0

  async write(rows: UsageRow[]): Promise<void> {
    this.posts++
    await this.onPost(rows)
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
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432')
    }
    if (rows.some(this.refuse)) throw new UsageWriteError('usage write: 23514 refused row', true, '23514')
    for (const r of rows) {
      this.stored.set(`${r.source}|${r.source_id}`, r)
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
    iuKey: 'personal',
    telemetry: { exporter: spans, scheduledDelayMillis: 50 },
    usage: { transport: null },
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
