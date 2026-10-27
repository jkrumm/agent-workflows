// Prints a trace as a tree straight from ClickHouse (loopback HTTP :8123, the /otel skill's local transport).
// Usage: bun src/query-trace.ts [traceId]   (default: out/trace-id.txt)
import { readFileSync } from "node:fs";

const traceId = process.argv[2] ?? readFileSync(`${import.meta.dir}/../out/trace-id.txt`, "utf8").trim();
const sql = `SELECT SpanId, ParentSpanId, ServiceName, SpanName, toString(SpanKind) AS kind, round(Duration/1e6,1) AS ms,
  StatusCode, SpanAttributes FROM default.otel_traces WHERE TraceId = '${traceId}' ORDER BY Timestamp, SpanId FORMAT JSONEachRow`;
// The collector batches before writing to ClickHouse: poll until the trace lands (spans of one trace arrive in >1 batch).
let text = "";
for (let i = 0; i < 15; i++) {
  const res = await fetch("http://127.0.0.1:8123/", { method: "POST", body: sql });
  if (!res.ok) throw new Error(`clickhouse ${res.status}: ${await res.text()}`);
  const next = await res.text();
  if (next.trim() && next === text) break;
  text = next;
  await Bun.sleep(2000);
}
type Row = { SpanId: string; ParentSpanId: string; ServiceName: string; SpanName: string; kind: string; ms: number; StatusCode: string; SpanAttributes: Record<string, string> };
const rows = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
const ids = new Set(rows.map((r) => r.SpanId));
const kids = new Map<string, Row[]>();
for (const r of rows) kids.set(r.ParentSpanId, [...(kids.get(r.ParentSpanId) ?? []), r]);
const roots = rows.filter((r) => r.ParentSpanId === "" || !ids.has(r.ParentSpanId));
const orphans = roots.filter((r) => r.ParentSpanId !== "").length;

const attrs = (a: Record<string, string>) =>
  ["agw.workflow.id", "agw.run.id", "agw.step.id", "agw.step.kind", "agw.tokens.input", "agw.tokens.output", "agw.cost.usd"]
    .filter((k) => k in a)
    .map((k) => `${k.replace("agw.", "")}=${a[k]}`)
    .join(" ");
const print = (r: Row, depth: number) => {
  console.log(`${"  ".repeat(depth)}${r.SpanName}  [${r.ServiceName}] ${r.ms}ms ${attrs(r.SpanAttributes)}`);
  for (const c of kids.get(r.SpanId) ?? []) print(c, depth + 1);
};
console.log(`trace ${traceId}: ${rows.length} spans, ${roots.length} root(s), ${orphans} orphan(s)`);
for (const r of roots) print(r, 0);
