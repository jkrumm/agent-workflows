// The telemetry module the platform middleware would own: one tracer provider per process,
// W3C traceparent in (env or HTTP header) and out (env or HTTP header), flush on exit and SIGTERM.
// Hand-composed from sdk-trace 3.x + an OTLP exporter; sdk-node is not needed (see REPORT.md).
import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  ROOT_CONTEXT,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter as ProtoExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPTraceExporter as JsonExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

export { SpanKind, SpanStatusCode, context, trace, ROOT_CONTEXT };
export type { Span, Context };

const DEFAULT_ENDPOINT = "http://localhost:4319"; // unauthed dev receiver; prod passes endpoint + headers via env

export interface Telemetry {
  tracer: Tracer;
  /** Context parented to an incoming traceparent (env or header), or ROOT_CONTEXT. */
  extract(carrier: Record<string, string | undefined>): Context;
  /** Writes traceparent into a header or env carrier for the given context (default: active). */
  inject<T extends Record<string, string>>(carrier: T, ctx?: Context): T;
  /** TRACEPARENT env for a child process, for the given context. */
  childEnv(ctx?: Context): Record<string, string>;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

let registered = false;

export function initTelemetry(opts: {
  serviceName: string;
  protocol?: "proto" | "json";
  endpoint?: string;
  scheduleDelayMs?: number;
  /** Extra resource attributes (probes tag runs with these). */
  resourceAttrs?: Record<string, string>;
  /** Install beforeExit/SIGTERM/SIGINT flush handlers. Default true; the flush probe turns it off to show the loss. */
  handlers?: boolean;
}): Telemetry {
  if (!registered) {
    // Bun implements AsyncLocalStorage, not async_hooks.createHook: this is the only usable context manager.
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new CompositePropagator({ propagators: [new W3CTraceContextPropagator()] }));
    registered = true;
  }

  const base = opts.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_ENDPOINT;
  const Exporter = opts.protocol === "json" ? JsonExporter : ProtoExporter;
  const exporter = new Exporter({ url: `${base}/v1/traces`, timeoutMillis: 5000 });
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ "service.name": opts.serviceName, ...opts.resourceAttrs }),
    spanProcessors: [new BatchSpanProcessor({ exporter, scheduledDelayMillis: opts.scheduleDelayMs ?? 1000 })],
  });
  const tracer = provider.getTracer("agw.middleware", "0.0.0");

  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    try {
      await Promise.race([provider.shutdown(), new Promise((r) => setTimeout(r, 8000).unref())]);
    } catch {
      // forceFlush/shutdown reject with an array of unresolved results; never let that mask the exit code
    }
  };
  // The batch timer is unref()'d, so an idle loop exits without flushing; Bun emits no exit hook for unhandled signals.
  if (opts.handlers !== false) {
    process.once("beforeExit", () => void shutdown());
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      process.once(sig, () => void shutdown().then(() => process.exit(0)));
    }
  }

  return {
    tracer,
    extract: (carrier) => propagation.extract(ROOT_CONTEXT, normalize(carrier)),
    inject: (carrier, ctx = context.active()) => {
      propagation.inject(ctx, carrier);
      return carrier;
    },
    childEnv: (ctx = context.active()) => {
      const h: Record<string, string> = {};
      propagation.inject(ctx, h);
      return h.traceparent ? { TRACEPARENT: h.traceparent } : {};
    },
    forceFlush: () => provider.forceFlush(),
    shutdown,
  };
}

/** Env var TRACEPARENT and HTTP `traceparent` normalise to the same carrier key. */
function normalize(c: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (key === "traceparent" || key === "tracestate") out[key] = v;
  }
  return out;
}

export async function withSpan<T>(
  tel: Telemetry,
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
  opts: { parent?: Context; kind?: SpanKind } = {},
): Promise<T> {
  const parent = opts.parent ?? context.active();
  const span = tel.tracer.startSpan(name, { kind: opts.kind ?? SpanKind.INTERNAL, attributes: attrs }, parent);
  try {
    return await context.with(trace.setSpan(parent, span), () => fn(span));
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    span.end();
  }
}
