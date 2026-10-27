// The "agw" process under test. CLI mode: parent from env TRACEPARENT. --serve: parent from the HTTP traceparent header.
import { writeFileSync } from "node:fs";
import { initTelemetry } from "./telemetry.ts";
import { runWorkflow } from "./workflow.ts";

const here = import.meta.dir;
const serve = process.argv.includes("--serve");
const proto = (process.env.SPIKE_PROTOCOL as "proto" | "json" | undefined) ?? "proto";
const tel = initTelemetry({ serviceName: serve ? "agw-host" : "agw-cli", protocol: proto });
const stubUrl = process.env.STUB_URL!;
const leafCmd = ["bun", `${here}/leaf.ts`];

if (!serve) {
  // CLI path: TRACEPARENT env is the carrier.
  const run = await runWorkflow(tel, {
    parent: tel.extract({ traceparent: process.env.TRACEPARENT }),
    input: { question: "cli" },
    transport: "cli",
    stubUrl,
    leafCmd,
  });
  run.parentTraceparent = process.env.TRACEPARENT ?? null;
  writeFileSync(`${here}/../out/run-record.cli.json`, JSON.stringify(run, null, 2));
  await tel.shutdown();
} else {
  // HTTP path: long-lived server, stopped with SIGTERM (flush-on-signal is exercised by the orchestrator).
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const parent = tel.extract(Object.fromEntries(req.headers));
      const run = await runWorkflow(tel, {
        parent,
        input: { question: "http" },
        transport: "http",
        stubUrl,
        leafCmd,
      });
      run.parentTraceparent = req.headers.get("traceparent");
      writeFileSync(`${here}/../out/run-record.http.json`, JSON.stringify(run, null, 2));
      return Response.json({ runId: run.runId, traceId: run.traceId });
    },
  });
  console.log(`LISTENING ${server.port}`);
}
