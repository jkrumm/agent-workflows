// Which OTel JS pieces work on Bun. Each probe emits one span named probe.<case> and reports how it ended.
// Needs SPIKE_INGEST_KEY (local ClickStack ingestion key) for the authed cases; they are skipped without it.
import { trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter as Grpc } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as Proto } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPTraceExporter as Json } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { Metadata, credentials } from "@grpc/grpc-js";

const key = process.env.SPIKE_INGEST_KEY;
const runTag = Date.now().toString(36);
const results: { case: string; outcome: string; ms: number }[] = [];

async function probe(name: string, make: () => { exporter: { export: Function; shutdown(): Promise<void> } }) {
  const t0 = Date.now();
  const { exporter } = make();
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ "service.name": "probe-packages", "probe.run": runTag, "probe.case": name }),
    spanProcessors: [new SimpleSpanProcessor(exporter as never)],
  });
  const span = provider.getTracer("probe").startSpan(`probe.${name}`);
  span.end();
  // SimpleSpanProcessor exports on end; surface the export result instead of hiding it
  const outcome = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve("HANG (no result in 8 s)"), 8000);
    (exporter as never as { export: Function }).export(
      [(span as never)],
      (r: { code: number; error?: Error }) => {
        clearTimeout(timer);
        resolve(r.code === 0 ? "ok" : `FAILED ${r.error?.message?.slice(0, 80) ?? r.code}`);
      },
    );
  });
  await provider.shutdown().catch(() => {});
  results.push({ case: name, outcome, ms: Date.now() - t0 });
}

await probe("http-proto-4319", () => ({ exporter: new Proto({ url: "http://localhost:4319/v1/traces" }) }));
await probe("http-json-4319", () => ({ exporter: new Json({ url: "http://localhost:4319/v1/traces" }) }));
await probe("http-proto-4318-nokey", () => ({ exporter: new Proto({ url: "http://localhost:4318/v1/traces" }) }));
if (key) {
  await probe("http-proto-4318-key", () => ({
    exporter: new Proto({ url: "http://localhost:4318/v1/traces", headers: { authorization: key } }),
  }));
  const md = new Metadata();
  md.set("authorization", key);
  await probe("grpc-4317-key", () => ({
    exporter: new Grpc({ url: "http://localhost:4317", credentials: credentials.createInsecure(), metadata: md }),
  }));
}
await probe("grpc-4317-nokey", () => ({
  exporter: new Grpc({ url: "http://localhost:4317", credentials: credentials.createInsecure() }),
}));

// sdk-node: construct, start, emit through the global API, shutdown. Env-driven (OTEL_EXPORTER_OTLP_*).
{
  const t0 = Date.now();
  let outcome = "ok";
  try {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4319";
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
    const sdk = new NodeSDK({
      serviceName: "probe-packages",
      resource: resourceFromAttributes({ "probe.run": runTag, "probe.case": "sdk-node" }),
    });
    sdk.start();
    trace.getTracer("probe").startSpan("probe.sdk-node").end();
    await Promise.race([sdk.shutdown(), new Promise((_, rej) => setTimeout(() => rej(new Error("shutdown timeout")), 8000))]);
  } catch (e) {
    outcome = `FAILED ${(e as Error).message}`;
  }
  results.push({ case: "sdk-node (import, start, span, shutdown)", outcome, ms: Date.now() - t0 });
}

console.log(`probe.run=${runTag}`);
console.table(results);
