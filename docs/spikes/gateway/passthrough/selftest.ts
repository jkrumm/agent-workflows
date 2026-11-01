// Free, offline check of the proxy against a local fake upstream: wire-level body hash, header swap,
// unbuffered streaming, usage tee, gzip passthrough. No real upstream call, no key.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { RAW, sha256 } from "./common.ts";

const USAGE = { input_tokens: 11, cache_creation_input_tokens: 22, cache_read_input_tokens: 33, output_tokens: 7 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const fake = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const buf = new Uint8Array(await req.arrayBuffer());
    const hdr = Object.fromEntries(req.headers);
    const j = JSON.parse(new TextDecoder().decode(buf));
    const meta = {
      "x-fake-wire-sha": sha256(buf),
      "x-fake-saw-key": hdr["x-api-key"] ?? "",
      "x-fake-saw-names": Object.keys(hdr).join(","),
      "request-id": "req_fake",
      "anthropic-ratelimit-requests-limit": "4000",
    };
    if (j.stream) {
      const body = new ReadableStream({
        async start(c) {
          c.enqueue(sse("message_start", { type: "message_start", message: { usage: { ...USAGE, output_tokens: 1 } } }));
          await sleep(300);
          c.enqueue(sse("content_block_delta", { type: "content_block_delta", delta: { text: "ok" } }));
          await sleep(300);
          c.enqueue(sse("message_delta", { type: "message_delta", usage: { output_tokens: USAGE.output_tokens } }));
          c.enqueue(sse("message_stop", { type: "message_stop" }));
          c.close();
        },
      });
      return new Response(body, { headers: { ...meta, "content-type": "text/event-stream" } });
    }
    const json = JSON.stringify({ type: "message", usage: USAGE });
    if (hdr["x-fake-gzip"]) {
      return new Response(gzipSync(json), { headers: { ...meta, "content-type": "application/json", "content-encoding": "gzip" } });
    }
    return new Response(json, { headers: { ...meta, "content-type": "application/json" } });
  },
});

mkdirSync(RAW, { recursive: true });
const logPath = `${RAW}/selftest.jsonl`;
rmSync(logPath, { force: true });
const proc = Bun.spawn(["bun", `${import.meta.dir}/proxy.ts`], {
  stdout: "pipe",
  stderr: "inherit",
  env: { ...process.env, UPSTREAM_BASE: `http://127.0.0.1:${fake.port}`, PROXY_FAKE_KEY: "fake-iu-key", PROXY_LOG: logPath },
});
const reader = proc.stdout.getReader();
const port = JSON.parse(new TextDecoder().decode((await reader.read()).value)).listening;

const events = () => readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
async function logOf(ev: string, id: string) {
  for (let i = 0; i < 50; i++) {
    const e = events().find((x) => x.ev === ev && x.id === id);
    if (e) return e;
    await sleep(50);
  }
  throw new Error(`no ${ev} log for ${id}`);
}

const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) fails.push(name);
};

async function go(stream: boolean, extra: Record<string, string> = {}) {
  const id = crypto.randomUUID();
  const bytes = enc.encode(JSON.stringify({ model: "m", stream, pad: "é€ \u0000 spaced   json" }));
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}/anthropic/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "client-dummy", authorization: "Bearer client-dummy", "anthropic-beta": "a-1,b-2", "x-agw-run-id": id, ...extra },
    body: bytes,
  });
  let firstMs = 0;
  const parts: Uint8Array[] = [];
  const r = res.body!.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    firstMs ||= performance.now() - t0;
    parts.push(value);
  }
  return { id, res, text: new TextDecoder().decode(Buffer.concat(parts)), firstMs, totalMs: performance.now() - t0, sha: sha256(bytes) };
}

console.log("selftest: local fake upstream");
for (const stream of [false, true]) {
  const c = await go(stream);
  const req = await logOf("request", c.id);
  const use = await logOf("usage", c.id);
  const tag = stream ? "stream" : "json";
  check(`${tag}: client sha == proxy inbound == proxy sent == wire sha`, c.sha === req.inboundSha && c.sha === req.sentSha && c.sha === c.res.headers.get("x-fake-wire-sha"));
  check(`${tag}: key swapped, authorization dropped`, c.res.headers.get("x-fake-saw-key") === "fake-iu-key" && !c.res.headers.get("x-fake-saw-names")!.split(",").includes("authorization"));
  check(`${tag}: anthropic-beta + custom header forwarded`, c.res.headers.get("x-fake-saw-names")!.includes("anthropic-beta") && c.res.headers.get("x-fake-saw-names")!.includes("x-agw-run-id"));
  check(`${tag}: usage parsed`, JSON.stringify(use.usage) === JSON.stringify(USAGE), JSON.stringify(use.usage));
  check(`${tag}: request-id + ratelimit headers pass`, c.res.headers.has("request-id") && c.res.headers.has("anthropic-ratelimit-requests-limit"));
  if (stream) check("stream: unbuffered (first chunk well before last)", c.firstMs < 250 && c.totalMs > 550, `first ${c.firstMs.toFixed(0)} ms, total ${c.totalMs.toFixed(0)} ms`);
}
const g = await go(false, { "x-fake-gzip": "1" });
const gu = await logOf("usage", g.id);
check("gzip: client decodes, content-encoding passes", g.res.headers.get("content-encoding") === "gzip" && JSON.parse(g.text).usage.input_tokens === 11);
check("gzip: tee parsed usage from encoded body", JSON.stringify(gu.usage) === JSON.stringify(USAGE));

proc.kill();
fake.stop(true);
if (fails.length) {
  console.log(`selftest FAIL: ${fails.join("; ")}`);
  process.exit(1);
}
console.log("selftest PASS");
