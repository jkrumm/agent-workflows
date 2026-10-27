// Stands in for a gateway that reads traceparent: one server span per request, parented to the caller.
import { initTelemetry, withSpan, SpanKind } from "./telemetry.ts";

const tel = initTelemetry({ serviceName: "stub-gateway" });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const parent = tel.extract(Object.fromEntries(req.headers));
    await withSpan(tel, `http.server ${req.method} ${new URL(req.url).pathname}`, { "http.request.method": req.method }, async () => {
      await new Promise((r) => setTimeout(r, 5));
    }, { parent, kind: SpanKind.SERVER });
    return new Response("pong");
  },
});
console.log(`LISTENING ${server.port}`);
