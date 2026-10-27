import type { Logger, Middleware, RunPostArgs, RunPreArgs, StepPostArgs, StepPreArgs } from '@agent-workflows/runtime'
import {
  type Attributes,
  type Context,
  DiagLogLevel,
  diag,
  type Link,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  type Tracer,
  trace,
} from '@opentelemetry/api'
import { type ExportResult, ExportResultCode } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BatchSpanProcessor,
  type IdGenerator,
  RandomIdGenerator,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace'
import { errorMessage } from './db.ts'
import { admissionSpanId, parseTraceparent, traceIdForRun } from './ids.ts'
import type { RunRecord } from './record.ts'

export type TelemetryOptions = {
  logger: Logger
  /** `service.name`. Default `agw`. */
  serviceName?: string
  /**
   * Default: OTLP http/protobuf configured only by the standard env (`OTEL_EXPORTER_OTLP_ENDPOINT`,
   * `OTEL_EXPORTER_OTLP_HEADERS`, `…_TRACES_…`); the receiver is deployment config, never code.
   */
  exporter?: SpanExporter
  /** Batch delay. Default 1000 ms. */
  scheduledDelayMillis?: number
  /** Spans buffered before the batch processor drops. Default 2048. */
  maxQueueSize?: number
  /** Upper bound on every flush (signal, crash, exit). Default 5000 ms. */
  flushTimeoutMs?: number
}

type OpenRun = { span: Span; traceId: string }

/** Hands the next span a chosen id (the admission span, a derived root trace); random otherwise. */
class RunIdGenerator implements IdGenerator {
  private readonly random = new RandomIdGenerator()
  nextTraceId: string | null = null
  nextSpanId: string | null = null

  generateTraceId(): string {
    const id = this.nextTraceId ?? this.random.generateTraceId()
    this.nextTraceId = null
    return id
  }

  generateSpanId(): string {
    const id = this.nextSpanId ?? this.random.generateSpanId()
    this.nextSpanId = null
    return id
  }
}

/** Counts every ended span, so a flush can tell exported, failed and dropped apart. */
class SpanCounter implements SpanProcessor {
  ended = 0
  onStart() {}
  onEnd(_span: ReadableSpan) {
    this.ended++
  }
  forceFlush() {
    return Promise.resolve()
  }
  shutdown() {
    return Promise.resolve()
  }
}

/** Wraps the real exporter: a failed export is logged with its span count, never silent. */
class LoggingExporter implements SpanExporter {
  exported = 0
  failed = 0

  constructor(
    private readonly inner: SpanExporter,
    private readonly logger: Logger,
  ) {}

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.inner.export(spans, (result) => {
      if (result.code === ExportResultCode.SUCCESS) this.exported += spans.length
      else {
        this.failed += spans.length
        this.logger.error('telemetry: span export failed', {
          spans: spans.length,
          error: result.error ? errorMessage(result.error) : 'unknown',
        })
      }
      done(result)
    })
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve()
  }
}

/**
 * OTel's diagnostics logger is process-global (`diag.setLogger`). It is installed once per process and forwards to
 * this sink; each `Telemetry` points the sink at its own logger when constructed and unhooks it at shutdown, so the
 * live instance (one per process is the intended shape) receives the diagnostics, never a stale first one.
 */
let diagSink: Logger | null = null
let diagInstalled = false

function routeDiag(logger: Logger) {
  diagSink = logger
  if (diagInstalled) return
  diagInstalled = true
  const log = (level: 'warn' | 'error') => (message: string) => diagSink?.[level](`telemetry: ${message}`)
  diag.setLogger(
    { error: log('error'), warn: log('warn'), info: () => {}, debug: () => {}, verbose: () => {} },
    { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true },
  )
}

const MAX_ERROR_ATTRIBUTE = 500
const SECRETS: [RegExp, string][] = [
  [/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]'],
  [/\bsk-[\w-]{6,}/g, 'sk-[redacted]'],
  [/\b(api[_-]?key|key|token|secret|password)=[^\s&"',;]+/gi, '$1=[redacted]'],
]

/** Span text leaves the host: secrets-shaped substrings redacted, length capped. The journal keeps the original. */
export function redactForSpan(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement)
  return out.length > MAX_ERROR_ATTRIBUTE ? `${out.slice(0, MAX_ERROR_ATTRIBUTE)}…` : out
}

function remoteParent(traceId: string, spanId: string): Context {
  return trace.setSpanContext(ROOT_CONTEXT, { traceId, spanId, traceFlags: TraceFlags.SAMPLED, isRemote: true })
}

/** `${parentId}/${stepId}/${i}` (the runtime's child id) → the parent's fan-out step id. */
function fanOutStepOf(childId: string, parentId: string): string | null {
  if (!childId.startsWith(`${parentId}/`)) return null
  const rest = childId.slice(parentId.length + 1)
  const cut = rest.lastIndexOf('/')
  return cut > 0 ? rest.slice(0, cut) : null
}

/**
 * One span per run drive, one child span per step, tool calls as span events (S2 verdicts). The middleware hooks
 * do not wrap the bodies, so parents are explicit, never the active context.
 */
export class Telemetry {
  readonly provider: TracerProvider
  private readonly tracer: Tracer
  private readonly ids = new RunIdGenerator()
  private readonly counter = new SpanCounter()
  private readonly exporter: LoggingExporter
  private readonly logger: Logger
  private readonly flushTimeoutMs: number
  private readonly runs = new Map<string, OpenRun>()
  private readonly steps = new Map<string, Span>()
  private readonly pending = new Map<string, Attributes>()
  private reportedLoss = 0
  private closed: Promise<void> | null = null

  constructor(options: TelemetryOptions) {
    this.logger = options.logger
    this.flushTimeoutMs = options.flushTimeoutMs ?? 5000
    routeDiag(this.logger)
    this.exporter = new LoggingExporter(options.exporter ?? new OTLPTraceExporter(), this.logger)
    this.provider = new TracerProvider({
      resource: resourceFromAttributes({ 'service.name': options.serviceName ?? 'agw' }),
      idGenerator: this.ids,
      spanProcessors: [
        this.counter,
        new BatchSpanProcessor({
          exporter: this.exporter,
          scheduledDelayMillis: options.scheduledDelayMillis ?? 1000,
          maxQueueSize: options.maxQueueSize ?? 2048,
        }),
      ],
    })
    this.tracer = this.provider.getTracer('agw.middleware', '0.0.0')
  }

  middleware(): Middleware {
    return {
      name: 'telemetry',
      runPre: (args) => this.openRun(args),
      stepPre: (args) => this.openStep(args),
      toolPre: (event) => this.toolEvent('pre', event),
      toolPost: (event) => this.toolEvent('post', event),
      stepPost: (args) => this.closeStep(args),
      runPost: (args) => this.closeRun(args),
    }
  }

  /** Attributes for a run's span; held until the span opens when it is not open yet. */
  annotateRun(runId: string, attributes: Attributes) {
    const open = this.runs.get(runId)
    if (open) open.span.setAttributes(attributes)
    else this.pending.set(runId, { ...this.pending.get(runId), ...attributes })
  }

  /** The record's run-level facts onto the run span. */
  recordRun(record: RunRecord) {
    this.annotateRun(record.runId, {
      'agw.run.wall_ms': record.wallMs ?? undefined,
      'agw.tokens.input': record.tokens.input,
      'agw.tokens.output': record.tokens.output,
      'agw.tokens.cache_read': record.tokens.cacheRead,
      'agw.tokens.cache_write': record.tokens.cacheWrite,
      'agw.tokens.reasoning': record.tokens.reasoning,
      'agw.cost.usd': record.cost ?? undefined,
      'agw.cost.unpriced_calls': record.unpricedCalls,
      'agw.tool_calls': record.toolCalls,
    })
  }

  /** W3C `traceparent` of a running step's span (or the run's), for an outbound call such as the OpenCode host. */
  traceparent(runId: string, stepId?: string): string | null {
    const span = stepId ? this.steps.get(`${runId}:${stepId}`) : this.runs.get(runId)?.span
    if (!span) return null
    const { traceId, spanId } = span.spanContext()
    return `00-${traceId}-${spanId}-01`
  }

  /** Flushes, bounded; logs a timeout and any span lost since the last report (queue full or failed export). */
  async flush(): Promise<boolean> {
    const ended = this.counter.ended
    let timer: ReturnType<typeof setTimeout> | undefined
    const ok = await Promise.race([
      this.provider.forceFlush().then(
        () => true,
        (err: unknown) => {
          this.logger.error('telemetry: flush failed', { error: errorMessage(err) })
          return false
        },
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.flushTimeoutMs)
        timer.unref()
      }),
    ])
    clearTimeout(timer)
    const lost = ended - this.exporter.exported - this.exporter.failed - this.reportedLoss
    if (!ok) this.logger.error('telemetry: flush did not finish in time', { timeoutMs: this.flushTimeoutMs })
    else if (lost > 0) {
      this.reportedLoss += lost
      this.logger.error('telemetry: spans dropped before export', { dropped: lost })
    }
    return ok
  }

  /** Spans ended but neither exported nor reported lost. */
  unflushed(): number {
    return this.counter.ended - this.exporter.exported - this.exporter.failed - this.reportedLoss
  }

  /**
   * Ends every open span as `agw.suspended` (the run continues in the next process, which opens a linked span),
   * flushes and shuts the provider down, bounded. Idempotent.
   */
  shutdown(): Promise<void> {
    this.closed ??= (async () => {
      const now = new Date()
      for (const span of this.steps.values()) span.setAttribute('agw.suspended', true).end(now)
      for (const { span } of this.runs.values()) span.setAttribute('agw.suspended', true).end(now)
      this.steps.clear()
      this.runs.clear()
      await this.flush()
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        this.provider.shutdown().catch((err: unknown) => {
          this.logger.error('telemetry: shutdown failed', { error: errorMessage(err) })
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.flushTimeoutMs)
          timer.unref()
        }),
      ])
      clearTimeout(timer)
      if (diagSink === this.logger) diagSink = null
    })()
    return this.closed
  }

  /**
   * The middleware owns flush: without a handler spans are lost on exit and on SIGTERM (S2). Installs
   * - `beforeExit`: flush when spans are waiting;
   * - `exit`: cannot await, so it logs how many spans an explicit `process.exit` loses;
   * - `SIGTERM`, `SIGINT`: `onSignal` (the host's own shutdown, e.g. `runtime.close()`), then `shutdown()`, then
   *   the signal is re-raised with these handlers removed, so the process ends by the signal (exit 128+n);
   * - `uncaughtException`, `unhandledRejection`: log, `shutdown()`, exit 1.
   * Returns the uninstall function. Install once per process; other SIGTERM listeners would keep the re-raised
   * signal from ending the process, so a host shuts down through `onSignal` instead.
   */
  installFlush(options: { onSignal?: (signal: NodeJS.Signals) => Promise<void> } = {}): () => void {
    let ending = false
    const beforeExit = () => {
      if (this.unflushed() > 0) void this.flush()
    }
    const exit = (code: number) => {
      const lost = this.unflushed()
      if (lost > 0) this.logger.error('telemetry: process exits with unflushed spans', { spans: lost, code })
    }
    const onSignal = (signal: NodeJS.Signals) => {
      if (ending) return
      ending = true
      void (async () => {
        try {
          await options.onSignal?.(signal)
        } catch (err) {
          this.logger.error('telemetry: onSignal failed', { signal, error: errorMessage(err) })
        }
        await this.shutdown()
        uninstall()
        process.kill(process.pid, signal)
      })()
    }
    const onCrash = (kind: string) => (err: unknown) => {
      this.logger.error(`telemetry: ${kind}; flushing, then exit 1`, { error: errorMessage(err) })
      if (ending) return
      ending = true
      void this.shutdown().finally(() => process.exit(1))
    }
    const uncaught = onCrash('uncaughtException')
    const unhandled = onCrash('unhandledRejection')
    process.on('beforeExit', beforeExit)
    process.on('exit', exit)
    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)
    process.on('uncaughtException', uncaught)
    process.on('unhandledRejection', unhandled)
    const uninstall = () => {
      process.off('beforeExit', beforeExit)
      process.off('exit', exit)
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
      process.off('uncaughtException', uncaught)
      process.off('unhandledRejection', unhandled)
    }
    return uninstall
  }

  private openRun(args: RunPreArgs) {
    const traceId = traceIdForRun(args)
    let parent = ROOT_CONTEXT
    if (args.parentId) {
      const fanOut = fanOutStepOf(args.runId, args.parentId)
      const step = fanOut ? this.steps.get(`${args.parentId}:${fanOut}`) : undefined
      parent = step ? trace.setSpan(ROOT_CONTEXT, step) : remoteParent(traceId, admissionSpanId(args.parentId))
    } else {
      const caller = parseTraceparent(args.traceparent)
      if (caller) parent = remoteParent(caller.traceId, caller.spanId)
      else this.ids.nextTraceId = traceId
    }
    const links: Link[] = []
    if (args.resume) {
      links.push({
        context: { traceId, spanId: admissionSpanId(args.runId), traceFlags: TraceFlags.SAMPLED },
        attributes: { 'agw.link': 'admission' },
      })
    } else this.ids.nextSpanId = admissionSpanId(args.runId)
    const span = this.tracer.startSpan(
      `agw.run ${args.workflowId}`,
      {
        kind: SpanKind.INTERNAL,
        links,
        attributes: {
          'agw.workflow.id': args.workflowId,
          'agw.workflow.version': args.version,
          'agw.run.id': args.runId,
          'agw.run.root_id': args.rootId,
          'agw.run.parent_id': args.parentId ?? undefined,
          'agw.run.resumed': args.resume,
          'agw.purpose': args.purpose,
          ...this.pending.get(args.runId),
        },
      },
      parent,
    )
    this.ids.nextTraceId = null
    this.ids.nextSpanId = null
    this.pending.delete(args.runId)
    this.runs.get(args.runId)?.span.setAttribute('agw.superseded', true).end()
    this.runs.set(args.runId, { span, traceId })
  }

  private closeRun(args: RunPostArgs) {
    let open = this.runs.get(args.runId)
    if (!open) {
      // No span open here: runPost re-delivered by another process, a run cancelled while pending, or one refused
      // before this hook's runPre. A short span carries the outcome.
      const traceId = traceIdForRun(args)
      const span = this.tracer.startSpan(
        `agw.run ${args.workflowId}`,
        {
          kind: SpanKind.INTERNAL,
          startTime: args.finishedAt,
          links: [{ context: { traceId, spanId: admissionSpanId(args.runId), traceFlags: TraceFlags.SAMPLED } }],
          attributes: {
            'agw.workflow.id': args.workflowId,
            'agw.workflow.version': args.version,
            'agw.run.id': args.runId,
            'agw.run.root_id': args.rootId,
            'agw.run.parent_id': args.parentId ?? undefined,
            'agw.run.outcome_only': true,
            'agw.purpose': args.purpose,
          },
        },
        args.parentId ? remoteParent(traceId, admissionSpanId(args.parentId)) : this.callerOrRoot(args, traceId),
      )
      this.ids.nextTraceId = null
      open = { span, traceId }
    }
    this.endLeftoverSteps(args)
    const { span } = open
    span.setAttributes({ ...this.pending.get(args.runId), 'agw.run.status': args.status })
    if (args.error) {
      span.setAttributes({ 'agw.error.kind': args.error.kind, 'agw.error.message': redactForSpan(args.error.message) })
      if (args.status === 'failed') span.setStatus({ code: SpanStatusCode.ERROR, message: args.error.kind })
    }
    span.end(args.finishedAt)
    this.pending.delete(args.runId)
    this.runs.delete(args.runId)
  }

  /**
   * Steps the runtime ended without `stepPost` (a cancel cleanup ended them first, or an infra error left the run):
   * ended with the run, as `cancelled` or as an error, never as `agw.suspended` (the run did not move on).
   */
  private endLeftoverSteps(args: RunPostArgs) {
    const prefix = `${args.runId}:`
    for (const [key, span] of this.steps) {
      if (!key.startsWith(prefix)) continue
      this.steps.delete(key)
      if (args.status === 'cancelled') span.setAttribute('agw.step.status', 'cancelled')
      else {
        span.setAttribute('agw.step.status', 'error')
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'step ended without stepPost' })
      }
      span.end(args.finishedAt)
    }
  }

  private callerOrRoot(args: RunPostArgs, traceId: string): Context {
    const caller = parseTraceparent(args.traceparent)
    if (caller) return remoteParent(caller.traceId, caller.spanId)
    this.ids.nextTraceId = traceId
    return ROOT_CONTEXT
  }

  private openStep(args: StepPreArgs) {
    const run = this.runs.get(args.runId)
    if (!run) {
      this.logger.warn('telemetry: step without an open run span', { runId: args.runId, stepId: args.stepId })
      return
    }
    const span = this.tracer.startSpan(
      `agw.step ${args.stepId}`,
      {
        kind: SpanKind.INTERNAL,
        startTime: args.startedAt,
        attributes: {
          'agw.workflow.id': args.workflowId,
          'agw.run.id': args.runId,
          'agw.step.id': args.stepId,
          'agw.step.kind': args.kind,
          'agw.step.attempt': args.attempt,
          'agw.step.replay': args.replay,
        },
      },
      trace.setSpan(ROOT_CONTEXT, run.span),
    )
    this.steps.set(`${args.runId}:${args.stepId}`, span)
  }

  private toolEvent(
    phase: 'pre' | 'post',
    event: { runId: string; stepId: string; callId: string; tool: string; error?: string },
  ) {
    this.steps.get(`${event.runId}:${event.stepId}`)?.addEvent(`tool.${phase}`, {
      'agw.tool.name': event.tool,
      'agw.tool.call_id': event.callId,
      'agw.tool.error': event.error === undefined ? undefined : redactForSpan(event.error),
    })
  }

  private closeStep(args: StepPostArgs) {
    const key = `${args.runId}:${args.stepId}`
    const span = this.steps.get(key)
    if (!span) return
    this.steps.delete(key)
    const { usage } = args
    const models = Object.keys(usage.byModel)
    span.setAttributes({
      'agw.step.attempt': args.attempt,
      'agw.step.status': args.status,
      'agw.tokens.input': usage.tokens.input,
      'agw.tokens.output': usage.tokens.output,
      'agw.tokens.cache_read': usage.tokens.cacheRead,
      'agw.tokens.cache_write': usage.tokens.cacheWrite,
      'agw.tokens.reasoning': usage.tokens.reasoning,
      'agw.cost.usd': usage.cost ?? undefined,
      'agw.cost.unpriced_calls': usage.unpricedCalls,
      'agw.tool_calls': usage.toolCalls,
      'gen_ai.request.model': models.length === 1 ? models[0] : undefined,
    })
    const sessionId = (args.handle as { sessionId?: unknown } | null)?.sessionId
    if (typeof sessionId === 'string') span.setAttribute('opencode.session.id', sessionId)
    if (args.error) {
      span.setAttributes({ 'agw.error.kind': args.error.kind, 'agw.error.message': redactForSpan(args.error.message) })
      if (args.status === 'failed') span.setStatus({ code: SpanStatusCode.ERROR, message: args.error.kind })
    }
    span.end(args.finishedAt)
  }
}
