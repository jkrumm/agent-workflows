// Orchestrator: plays the caller (Claude Code / Hermes / a script) and drives both ingress paths.
//   caller span ──CLI (env TRACEPARENT)──▶ agw-cli run ──env──▶ leaf process
//                                                     └──HTTP header──▶ stub-gateway
//               ──HTTP (traceparent header)──▶ agw-host run (same fan-out)
import { writeFileSync } from "node:fs";
import { initTelemetry, withSpan, SpanKind } from "./telemetry.ts";

const here = import.meta.dir;
const protocol = (process.env.SPIKE_PROTOCOL as "proto" | "json" | undefined) ?? "proto";
const tel = initTelemetry({ serviceName: "caller", protocol });

async function startChild(file: string, args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", `${here}/${file}`, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  const m = /LISTENING (\d+)/.exec(new TextDecoder().decode(value));
  if (!m) throw new Error(`${file} did not report a port`);
  return { proc, port: Number(m[1]) };
}

const stub = await startChild("stub.ts", [], {});
const stubUrl = `http://127.0.0.1:${stub.port}`;
const host = await startChild("agw-run.ts", ["--serve"], { STUB_URL: stubUrl });

let traceId = "";
await withSpan(tel, "caller.invoke", { "caller.kind": "spike" }, async (root) => {
  traceId = root.spanContext().traceId;

  // CLI path: TRACEPARENT env into a child process, taken inside the caller.cli span so the run nests under it
  await withSpan(tel, "caller.cli", { "agw.transport": "cli" }, async () => {
    const cli = Bun.spawn(["bun", `${here}/agw-run.ts`], {
      env: { ...process.env, ...tel.childEnv(), STUB_URL: stubUrl },
      stdout: "inherit",
      stderr: "inherit",
    });
    await cli.exited;
  }, { kind: SpanKind.CLIENT });

  // HTTP path: traceparent header
  await withSpan(tel, "caller.http", { "agw.transport": "http" }, async () => {
    const res = await fetch(`http://127.0.0.1:${host.port}/run`, { method: "POST", headers: tel.inject({}) });
    console.log("http run:", await res.json());
  }, { kind: SpanKind.CLIENT });
});

// Long-lived processes stop with SIGTERM: their handlers must flush.
host.proc.kill("SIGTERM");
stub.proc.kill("SIGTERM");
await Promise.all([host.proc.exited, stub.proc.exited]);
await tel.shutdown();

writeFileSync(`${here}/../out/trace-id.txt`, traceId);
console.log(`TRACE_ID ${traceId}`);
