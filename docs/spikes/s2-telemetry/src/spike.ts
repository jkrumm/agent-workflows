// Orchestrator: plays the caller (Claude Code / Hermes / a script) and drives both ingress paths.
//   caller span ──CLI (env TRACEPARENT)──▶ agw-cli run ──env──▶ leaf process
//                                                     └──HTTP header──▶ stub-gateway
//               ──HTTP (traceparent header)──▶ agw-host run (same fan-out)
import { writeFileSync } from "node:fs";
import { initTelemetry, withSpan, SpanKind } from "./telemetry.ts";
import { ensureOut, OUT, stopProc } from "./util.ts";

const here = import.meta.dir;
ensureOut();
const protocol = (process.env.SPIKE_PROTOCOL as "proto" | "json" | undefined) ?? "proto";
const tel = initTelemetry({ serviceName: "caller", protocol });

async function startChild(file: string, args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", `${here}/${file}`, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "inherit" });
  try {
    const { value } = await proc.stdout.getReader().read();
    const m = /LISTENING (\d+)/.exec(new TextDecoder().decode(value));
    if (!m) throw new Error(`${file} did not report a port`);
    return { proc, port: Number(m[1]) };
  } catch (err) {
    await stopProc(proc, 2000);
    throw err;
  }
}

let stub: Awaited<ReturnType<typeof startChild>> | undefined;
let host: Awaited<ReturnType<typeof startChild>> | undefined;
let traceId = "";
try {
  stub = await startChild("stub.ts", [], {});
  const stubUrl = `http://127.0.0.1:${stub.port}`;
  host = await startChild("agw-run.ts", ["--serve"], { STUB_URL: stubUrl });
  const hostPort = host.port;

  await withSpan(tel, "caller.invoke", { "caller.kind": "spike" }, async (root) => {
    traceId = root.spanContext().traceId;

    // CLI path: TRACEPARENT env into a child process, taken inside the caller.cli span so the run nests under it
    await withSpan(tel, "caller.cli", { "agw.transport": "cli" }, async () => {
      const cli = Bun.spawn(["bun", `${here}/agw-run.ts`], {
        env: { ...process.env, ...tel.childEnv(), STUB_URL: stubUrl },
        stdout: "inherit",
        stderr: "inherit",
      });
      try {
        const code = await Promise.race([cli.exited, Bun.sleep(60_000).then(() => "timeout" as const)]);
        if (code !== 0) throw new Error(`agw-run cli ended with ${code}`);
      } finally {
        if (cli.exitCode === null) await stopProc(cli, 2000);
      }
    }, { kind: SpanKind.CLIENT });

    // HTTP path: traceparent header
    await withSpan(tel, "caller.http", { "agw.transport": "http" }, async () => {
      const res = await fetch(`http://127.0.0.1:${hostPort}/run`, { method: "POST", headers: tel.inject({}), signal: AbortSignal.timeout(60_000) });
      console.log("http run:", await res.json());
    }, { kind: SpanKind.CLIENT });
  });
} finally {
  // Long-lived processes stop with SIGTERM (their handlers flush); SIGKILL if one has not exited within the bound.
  const ends = await Promise.all([host ? stopProc(host.proc) : "term", stub ? stopProc(stub.proc) : "term"]);
  if (ends.includes("killed")) console.error("a child ignored SIGTERM and was killed; its spans may be missing");
  await tel.shutdown();
}

writeFileSync(`${OUT}/trace-id.txt`, traceId);
console.log(`TRACE_ID ${traceId}`);
