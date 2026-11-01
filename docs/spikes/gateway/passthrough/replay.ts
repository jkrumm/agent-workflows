// Passthrough spike measurement. One command: `bun replay.ts`.
// Runs the free offline selftest, then at most (CAP - already spent) real Haiku calls: direct and through proxy.ts.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { CAP, HERE, RAW, resolveKey, sha256, spend, spent } from "./common.ts";

const MODEL = "claude-haiku-5-5";
const API = "https://api.anthropic.com";
// 1h TTL is GA (no beta needed); the list is what Claude Code sends on a Haiku API-key run, minus the two
// values probed separately below (claude-code-20250219, oauth-2025-04-20).
const BETA = "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,extended-cache-ttl-2025-04-11";
const BETA_CC = `claude-code-20250219,${BETA}`;
const BETA_CC_OAUTH = `claude-code-20250219,oauth-2025-04-20,${BETA}`;
const RUN = Date.now().toString(36);
const N = 5;

mkdirSync(RAW, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 0. offline selftest (free) ----
const st = Bun.spawnSync(["bun", `${HERE}/selftest.ts`], { stdout: "inherit", stderr: "inherit" });
if (st.exitCode !== 0) throw new Error("selftest failed; not spending upstream calls");

const KEY = resolveKey();

// ---- 1. model id (free GET) ----
const models = (await (await fetch(`${API}/v1/models?limit=100`, { headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(60_000) })).json()) as any;
const modelIds: string[] = models.data?.map((m: any) => m.id) ?? [];
if (!modelIds.includes(MODEL)) throw new Error(`${MODEL} not in /v1/models`);

// ---- 2. proxy subprocess (own process: no event-loop contention with the timing client) ----
const logPath = `${RAW}/proxy-${RUN}.jsonl`;
rmSync(logPath, { force: true });
const proc = Bun.spawn(["bun", `${HERE}/proxy.ts`], { stdout: "pipe", stderr: "inherit", env: { ...process.env, PROXY_LOG: logPath } });
process.on("exit", () => proc.kill());
const PORT = JSON.parse(new TextDecoder().decode((await proc.stdout.getReader().read()).value)).listening as number;
const events = (): any[] => {
  try {
    return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
async function logOf(ev: string, id: string) {
  for (let i = 0; i < 200; i++) {
    const e = events().find((x) => x.ev === ev && x.id === id);
    if (e) return e;
    await sleep(50);
  }
  throw new Error(`no ${ev} log for ${id}`);
}

// ---- request shape: Claude-Code-like ----
function pad(): string {
  const verbs = ["re-read", "diff", "grep", "list", "validate", "format", "summarise", "revert", "inspect", "bisect"];
  const objs = ["the failing test", "the changed file", "the lockfile", "the migration", "the config", "the schema", "the fixture", "the CLI flag"];
  const lines: string[] = ["# Project instructions", ""];
  for (let i = 1; i <= 190; i++) {
    lines.push(`Rule ${i}: before you touch ${objs[i % objs.length]}, ${verbs[(i * 3) % verbs.length]} it, keep the change minimal, and report ${i % 7 === 0 ? "the exit code" : "the result"} verbatim.`);
  }
  return lines.join("\n");
}
const BIG = pad();
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
  name,
  description,
  input_schema: { type: "object", properties, required },
});
const TOOLS = [
  tool("Bash", "Run a shell command in the project and return stdout, stderr and the exit code.", { command: { type: "string" }, timeout: { type: "number" } }, ["command"]),
  tool("Read", "Read a file from the local filesystem by absolute path.", { file_path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, ["file_path"]),
  tool("Edit", "Replace an exact string in a file.", { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, ["file_path", "old_string", "new_string"]),
];
const NEUTRAL_ID = "You are an interactive coding agent running in a terminal.";
const CC_ID = "You are Claude Code, Anthropic's official CLI for Claude.";
function bodyFor(mode: "json" | "sse", firstSystem = NEUTRAL_ID): string {
  return JSON.stringify({
    model: MODEL,
    max_tokens: 32,
    metadata: { user_id: `user_spike_account__session_${RUN}` },
    system: [
      { type: "text", text: firstSystem },
      { type: "text", text: `Spike marker ${RUN}-${mode}. Answer tersely.` },
      { type: "text", text: BIG, cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    tools: TOOLS,
    messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly one word: ok" }] }],
    stream: mode === "sse",
  });
}

// ---- client ----
type Usage = { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number };
const core = (u: any): Usage => ({
  input_tokens: u?.input_tokens ?? 0,
  cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
  cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
  output_tokens: u?.output_tokens ?? 0,
});
const sameUsage = (a: Usage, b: Usage) => JSON.stringify(a) === JSON.stringify(b);

// Usage from the raw response text, parsed independently of the proxy's tee.
function rawUsage(text: string, stream: boolean): { usage: Usage | null; usageRaw: any } {
  if (!stream) {
    const j = JSON.parse(text);
    return { usage: j.usage ? core(j.usage) : null, usageRaw: j.usage ?? null };
  }
  let start: any = null;
  let out: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const d = JSON.parse(line.slice(5));
    if (d.type === "message_start") start = d.message.usage;
    if (d.type === "message_delta") out = d.usage.output_tokens;
  }
  return { usage: start ? core({ ...start, output_tokens: out ?? start.output_tokens }) : null, usageRaw: start };
}

type Result = {
  target: "proxy" | "direct";
  id: string;
  status: number;
  headerNames: string[];
  headerOf: (n: string) => string | null;
  text: string;
  usage: Usage | null;
  usageRaw: any;
  clientSha: string;
  tHeaders: number;
  tFirstByte: number;
  tFirstDelta: number | null;
  tTotal: number;
  proxyReq?: any;
  proxyUsage?: any;
};

async function call(target: "proxy" | "direct", body: string, o: { stream: boolean; beta?: string; claudeCodeUa?: boolean }): Promise<Result> {
  const id = crypto.randomUUID();
  const bytes = new TextEncoder().encode(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": o.beta ?? BETA,
    "x-agw-run-id": id,
    "user-agent": "agw-spike/0.1",
  };
  if (o.claudeCodeUa) {
    headers["user-agent"] = "claude-cli/2.1 (external, cli)";
    headers["x-app"] = "cli";
  }
  if (target === "proxy") {
    headers["x-api-key"] = "client-dummy-key"; // must never reach upstream
    headers.authorization = "Bearer client-dummy-token";
  } else {
    headers["x-api-key"] = KEY;
    spend();
  }
  const url = target === "proxy" ? `http://127.0.0.1:${PORT}/anthropic/v1/messages` : `${API}/v1/messages`;
  const t0 = performance.now();
  const res = await fetch(url, { method: "POST", headers, body: bytes, signal: AbortSignal.timeout(60_000) });
  const tHeaders = performance.now() - t0;
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  let tFirstByte = 0;
  let tFirstDelta: number | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    tFirstByte ||= performance.now() - t0;
    text += dec.decode(value, { stream: true });
    if (tFirstDelta === null && text.includes("event: content_block_delta")) tFirstDelta = performance.now() - t0;
  }
  const tTotal = performance.now() - t0;
  let parsed: { usage: Usage | null; usageRaw: any } = { usage: null, usageRaw: null };
  if (res.status === 200) parsed = rawUsage(text, o.stream);
  const r: Result = {
    target, id, status: res.status, headerNames: [...res.headers.keys()].sort(), headerOf: (n) => res.headers.get(n),
    text, ...parsed, clientSha: sha256(bytes), tHeaders, tFirstByte, tFirstDelta, tTotal,
  };
  if (target === "proxy") {
    r.proxyReq = await logOf("request", id);
    if (res.status === 200 || res.status >= 400) r.proxyUsage = await logOf("usage", id);
  }
  return r;
}

// ---- statistics ----
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stdev = (a: number[]) => {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
};
const fmt = (n: number) => n.toFixed(0);

// ---- run ----
const out: string[] = [];
const say = (s = "") => {
  console.log(s);
  out.push(s);
};
const summary: Record<string, unknown> = { model: MODEL, run: RUN };
const failures: string[] = [];
const verdict = (name: string, ok: boolean, detail: string) => {
  say(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (!ok) failures.push(name);
};
const before = spent();
say(`== passthrough spike summary ==`);
say(`model ${MODEL} listed by GET /v1/models; beta list: ${BETA}`);

// Checks 1-3: identical pairs, non-streamed and streamed
const proxied: Result[] = [];
const pair: Record<string, Result[]> = {};
for (const mode of ["json", "sse"] as const) {
  const body = bodyFor(mode);
  const a = await call("proxy", body, { stream: mode === "sse" });
  const b = await call("proxy", body, { stream: mode === "sse" });
  for (const r of [a, b]) if (r.status !== 200) throw new Error(`${mode}: status ${r.status}: ${r.text.slice(0, 300)}`);
  pair[mode] = [a, b];
  proxied.push(a, b);
}
const allCalls = () => proxied;
verdict(
  "1 body hash identity",
  allCalls().every((r) => r.clientSha === r.proxyReq.inboundSha && r.proxyReq.inboundSha === r.proxyReq.sentSha),
  `${allCalls().filter((r) => r.clientSha === r.proxyReq.inboundSha && r.proxyReq.inboundSha === r.proxyReq.sentSha).length}/${allCalls().length} calls client == inbound == sent (sha256 of ${pair.json[0].proxyReq.bytes} / ${pair.sse[0].proxyReq.bytes} bytes)`,
);
for (const mode of ["json", "sse"] as const) {
  const [a, b] = pair[mode];
  const ua = a.usage!;
  const ub = b.usage!;
  const w1h = a.usageRaw?.cache_creation?.ephemeral_1h_input_tokens;
  verdict(
    `2 cache read, ${mode === "sse" ? "streamed" : "non-streamed"}`,
    ub.cache_read_input_tokens > 0,
    `call 1 write ${ua.cache_creation_input_tokens} read ${ua.cache_read_input_tokens}${w1h !== undefined ? ` (1h write ${w1h})` : ""}; call 2 write ${ub.cache_creation_input_tokens} read ${ub.cache_read_input_tokens}`,
  );
}
verdict(
  "3 tee usage == raw usage",
  allCalls().every((r) => r.proxyUsage.usage && sameUsage(core(r.proxyUsage.usage), r.usage!)),
  `${allCalls().filter((r) => r.proxyUsage.usage && sameUsage(core(r.proxyUsage.usage), r.usage!)).length}/${allCalls().length} calls equal on input/cache_creation/cache_read/output; e.g. ${JSON.stringify(pair.sse[1].usage)}`,
);
summary.pairs = Object.fromEntries(Object.entries(pair).map(([k, v]) => [k, v.map((r) => ({ usage: r.usage, usageRaw: r.usageRaw, bytes: r.proxyReq.bytes }))]));

// Check 4: TTFT, streamed, interleaved, same body (cache warm after the pair above)
const sseBody = bodyFor("sse");
await call("direct", sseBody, { stream: true }); // connection warm-up, discarded
await call("proxy", sseBody, { stream: true }); // connection warm-up, discarded
const T = { direct: { fb: [] as number[], fd: [] as number[], hdr: [] as number[] }, proxy: { fb: [] as number[], fd: [] as number[], hdr: [] as number[] } };
let lastDirect!: Result;
let lastProxy!: Result;
let ttftCacheOk = true;
for (let i = 0; i < N; i++) {
  for (const t of i % 2 === 0 ? (["direct", "proxy"] as const) : (["proxy", "direct"] as const)) {
    const r = await call(t, sseBody, { stream: true });
    if (r.status !== 200) throw new Error(`ttft ${t}: status ${r.status}`);
    if (!(r.usage!.cache_read_input_tokens > 0)) ttftCacheOk = false;
    T[t].fb.push(r.tFirstByte);
    T[t].fd.push(r.tFirstDelta ?? Number.NaN);
    T[t].hdr.push(r.tHeaders);
    if (t === "direct") lastDirect = r;
    else lastProxy = r;
  }
}
const stat = (a: number[]) => ({ median: median(a), min: Math.min(...a), max: Math.max(...a), sd: stdev(a), all: a.map(Math.round) });
const rows = (["direct", "proxy"] as const).map((t) => ({ t, headers: stat(T[t].hdr), firstByte: stat(T[t].fb), firstDelta: stat(T[t].fd) }));
say();
say(`TTFT, streamed, N=${N} per path, interleaved (alternating order), cache warm (all reads > 0: ${ttftCacheOk}); ms from fetch() to:`);
say("| path | headers med | first byte med | min-max | sd | first content_block_delta med | min-max | sd |");
say("|-|-|-|-|-|-|-|-|");
for (const r of rows) {
  say(`| ${r.t} | ${fmt(r.headers.median)} | ${fmt(r.firstByte.median)} | ${fmt(r.firstByte.min)}-${fmt(r.firstByte.max)} | ${fmt(r.firstByte.sd)} | ${fmt(r.firstDelta.median)} | ${fmt(r.firstDelta.min)}-${fmt(r.firstDelta.max)} | ${fmt(r.firstDelta.sd)} |`);
}
for (const k of ["firstByte", "firstDelta"] as const) {
  const d = rows[1][k].median - rows[0][k].median;
  const noise = Math.max(rows[0][k].sd, rows[1][k].sd);
  verdict(`4 TTFT ${k === "firstByte" ? "first byte" : "first content delta"}`, Math.abs(d) <= noise, `proxy - direct median = ${d >= 0 ? "+" : ""}${fmt(d)} ms, noise (larger sd) ${fmt(noise)} ms`);
}
say(`   raw samples (ms) first byte: direct ${rows[0].firstByte.all.join(",")} | proxy ${rows[1].firstByte.all.join(",")}`);
say(`   raw samples (ms) first delta: direct ${rows[0].firstDelta.all.join(",")} | proxy ${rows[1].firstDelta.all.join(",")}`);
summary.ttft = rows;

// Malformed call (missing messages), proxy and direct
const bad = JSON.stringify({ model: MODEL, max_tokens: 16 });
const badP = await call("proxy", bad, { stream: false });
const badD = await call("direct", bad, { stream: false });
const strip = (s: string) => s.replace(/req_[A-Za-z0-9]+/g, "req_<id>");
say();
say(`malformed (no \`messages\`): proxy ${badP.status} ${strip(badP.text)}`);
say(`                           direct ${badD.status} ${strip(badD.text)}`);
verdict("malformed passes through unchanged", badP.status === badD.status && strip(badP.text) === strip(badD.text) && badP.status === 400, `status ${badP.status} vs ${badD.status}, bodies equal after id strip`);

// Header passthrough
const names = (r: Result) => r.headerNames;
const watch = (n: string) => n.startsWith("anthropic-ratelimit-") || n === "request-id";
const wd = names(lastDirect).filter(watch);
const wp = names(lastProxy).filter(watch);
const onlyD = names(lastDirect).filter((n) => !names(lastProxy).includes(n));
const onlyP = names(lastProxy).filter((n) => !names(lastDirect).includes(n));
say();
say(`headers: direct ${names(lastDirect).length}, proxy ${names(lastProxy).length}; ratelimit+request-id direct [${wd.join(", ")}]`);
verdict("ratelimit + request-id headers pass", wd.length > 0 && JSON.stringify(wd) === JSON.stringify(wp), `${wp.length} headers match by name; only in direct: [${onlyD.join(", ")}], only in proxy: [${onlyP.join(", ")}]`);
const encs = new Set([lastDirect.headerOf("content-encoding"), lastProxy.headerOf("content-encoding")]);
say(`   content-encoding direct/proxy: ${lastDirect.headerOf("content-encoding")}/${lastProxy.headerOf("content-encoding")}; forwarded request headers (names): ${Object.keys(pair.json[0].proxyReq.forwarded).join(",")}; dropped: ${pair.json[0].proxyReq.dropped.join(",")}`);
void encs;

// Probe: the credit org with the Claude Code identity beta (research flagged a 400 "credit balance too low")
say();
for (const [label, beta] of [["claude-code-20250219", BETA_CC], ["claude-code-20250219 + oauth-2025-04-20", BETA_CC_OAUTH]] as const) {
  const r = await call("proxy", bodyFor("json"), { stream: false, beta });
  say(`probe beta +${label}: ${r.status} ${strip(r.text).slice(0, 220)}${r.status === 200 ? ` (cache read ${r.usage!.cache_read_input_tokens})` : ""}`);
  (summary.probes ??= []) as unknown[];
  (summary.probes as unknown[]).push({ beta: label, status: r.status, body: r.status === 200 ? undefined : strip(r.text).slice(0, 300) });
}

// Probe: which Claude-Code identity signals the credit org refuses (found while building this spike)
say();
const idProbes = [
  ["system prefix \"You are Claude Code, Anthropic's official CLI for Claude.\"", await call("proxy", bodyFor("json", CC_ID), { stream: false })],
  ["user-agent claude-cli/2.1 + x-app: cli", await call("proxy", bodyFor("json"), { stream: false, claudeCodeUa: true })],
] as const;
for (const [label, r] of idProbes) {
  say(`probe identity ${label}: ${r.status} ${strip(r.text).slice(0, 120)}`);
  (summary.identityProbes ??= []) as unknown[];
  (summary.identityProbes as unknown[]).push({ signal: label, status: r.status, body: r.status === 200 ? undefined : strip(r.text).slice(0, 300) });
}

proc.kill();
say();
say(`upstream /v1/messages calls this run: ${spent() - before} (total spent ${spent()}/${CAP})`);
say(failures.length ? `RESULT: FAIL (${failures.join("; ")})` : "RESULT: all checks PASS");
summary.failures = failures;
mkdirSync(`${HERE}/results`, { recursive: true });
writeFileSync(`${HERE}/results/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(`${HERE}/results/summary.txt`, `${out.join("\n")}\n`);
process.exit(failures.length ? 1 : 0);
