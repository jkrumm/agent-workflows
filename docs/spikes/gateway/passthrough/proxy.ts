// Spike: byte-exact passthrough proxy for POST /anthropic/v1/messages (docs/gateway.md §Shape).
// Request bytes are read once and the same buffer is sent upstream; only the auth header is swapped.
// The response streams through a tee: one branch to the caller untouched, one parsed for `usage`.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { HERE, resolveKey, sha256, spend } from "./common.ts";

const UPSTREAM = process.env.UPSTREAM_BASE ?? "https://api.anthropic.com"; // override only for the local selftest
const REAL = !process.env.UPSTREAM_BASE;
const LOG = process.env.PROXY_LOG ?? `${HERE}/results/raw/proxy.jsonl`;
mkdirSync(dirname(LOG), { recursive: true });
const KEY = process.env.PROXY_FAKE_KEY ?? resolveKey();

// Dropped by the brief: auth, host, content-length (recomputed). Hop-by-hop headers are not end-to-end (RFC 9110 §7.6.1).
const DROP = new Set(["authorization", "x-api-key", "host", "content-length"]);
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-connection"]);

const log = (o: Record<string, unknown>) => appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), ...o })}\n`);

function decode(buf: Uint8Array, enc: string | null): Uint8Array {
  switch ((enc ?? "").toLowerCase()) {
    case "":
    case "identity":
      return buf;
    case "gzip":
      return gunzipSync(buf);
    case "deflate":
      return inflateSync(buf);
    case "br":
      return brotliDecompressSync(buf);
    default:
      throw new Error(`unsupported content-encoding ${enc}`);
  }
}

// message_start: input / cache_creation / cache_read tokens. message_delta: output tokens.
class SseUsage {
  private buf = "";
  start: any = null;
  delta: any = null;
  events = 0;
  firstDeltaMs: number | null = null;
  constructor(private t0: number) {}
  push(text: string) {
    this.buf += text.replace(/\r\n/g, "\n");
    let i: number;
    while ((i = this.buf.indexOf("\n\n")) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      this.event(block);
    }
  }
  private event(block: string) {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    let d: any;
    try {
      d = JSON.parse(data);
    } catch {
      return;
    }
    this.events++;
    if (d.type === "message_start") this.start = d.message?.usage ?? null;
    else if (d.type === "message_delta") this.delta = d.usage ?? null;
    else if (d.type === "content_block_delta" && this.firstDeltaMs === null) this.firstDeltaMs = performance.now() - this.t0;
  }
  get usage() {
    if (!this.start) return null;
    return {
      input_tokens: this.start.input_tokens,
      cache_creation_input_tokens: this.start.cache_creation_input_tokens,
      cache_read_input_tokens: this.start.cache_read_input_tokens,
      output_tokens: this.delta?.output_tokens ?? this.start.output_tokens,
    };
  }
}

const pick = (u: any) => ({
  input_tokens: u.input_tokens,
  cache_creation_input_tokens: u.cache_creation_input_tokens,
  cache_read_input_tokens: u.cache_read_input_tokens,
  output_tokens: u.output_tokens,
});

async function tee(id: string, stream: ReadableStream<Uint8Array>, r: { sse: boolean; enc: string | null; t0: number; status: number }) {
  try {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    const chunks: Uint8Array[] = [];
    const live = r.sse && !r.enc ? new SseUsage(r.t0) : null;
    let firstChunkMs: number | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      firstChunkMs ??= performance.now() - r.t0;
      if (live) live.push(dec.decode(value, { stream: true }));
      else chunks.push(value);
    }
    let usage: unknown = null;
    let extra: Record<string, unknown> = {};
    if (live) {
      usage = live.usage;
      extra = { firstDeltaMs: live.firstDeltaMs, deltaUsage: live.delta, startUsage: live.start, events: live.events };
    } else {
      const text = new TextDecoder().decode(decode(Buffer.concat(chunks), r.enc));
      if (r.sse) {
        const s = new SseUsage(r.t0);
        s.push(`${text}\n\n`);
        usage = s.usage;
        extra = { deltaUsage: s.delta, startUsage: s.start, events: s.events };
      } else {
        const j = JSON.parse(text);
        usage = j.usage ? pick(j.usage) : null;
        extra = { usageRaw: j.usage ?? null, errorBody: r.status >= 400 ? text : undefined };
      }
    }
    log({ ev: "usage", id, status: r.status, usage, firstChunkMs, ...extra });
  } catch (e) {
    log({ ev: "tee-error", id, error: String(e) });
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/anthropic/v1/messages") return new Response("not found", { status: 404 });
    const t0 = performance.now();
    const body = await req.arrayBuffer(); // read once; this exact buffer goes upstream
    const id = req.headers.get("x-agw-run-id") ?? crypto.randomUUID();
    const inboundSha = sha256(body);

    const headers = new Headers();
    const dropped: string[] = [];
    for (const [k, v] of req.headers) {
      if (DROP.has(k) || HOP.has(k)) dropped.push(k);
      else headers.set(k, v);
    }
    headers.set("x-api-key", KEY);
    const forwarded = Object.fromEntries([...headers].map(([k, v]) => [k, k === "x-api-key" ? "<iu-key>" : v]));
    const sentSha = sha256(body);

    if (REAL) {
      try {
        spend();
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 503 });
      }
    }
    let up: Response;
    try {
      up = await fetch(`${UPSTREAM}/v1/messages${url.search}`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(60_000),
        // @ts-expect-error Bun option: keep content-encoding bytes as sent, never re-encode
        decompress: false,
      });
    } catch (e) {
      log({ ev: "request", id, inboundSha, sentSha, bytes: body.byteLength, forwarded, dropped, error: String(e) });
      return Response.json({ error: `upstream: ${String(e)}` }, { status: 502 });
    }
    const tHeadersMs = performance.now() - t0;
    log({ ev: "request", id, inboundSha, sentSha, bytes: body.byteLength, forwarded, dropped, upstreamStatus: up.status, tHeadersMs });

    const out = new Headers();
    for (const [k, v] of up.headers) if (!HOP.has(k)) out.set(k, v);
    if (!up.body) return new Response(null, { status: up.status, statusText: up.statusText, headers: out });
    const [toClient, toTee] = up.body.tee();
    void tee(id, toTee, {
      sse: (up.headers.get("content-type") ?? "").includes("text/event-stream"),
      enc: up.headers.get("content-encoding"),
      t0,
      status: up.status,
    });
    return new Response(toClient, { status: up.status, statusText: up.statusText, headers: out });
  },
});

console.log(JSON.stringify({ listening: server.port }));
