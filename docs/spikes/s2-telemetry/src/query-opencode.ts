// What did OpenCode emit for the probe run, and did it join our step span's trace?
// Reads out/opencode-trace-id.txt (our trace id, probe run tag, our step span id).
import { readFileSync } from "node:fs";

const [ourTrace, run, ourStep] = readFileSync(`${import.meta.dir}/../out/opencode-trace-id.txt`, "utf8").trim().split("\n");
const ch = async (sql: string) => {
  const r = await fetch("http://127.0.0.1:8123/", { method: "POST", body: `${sql} FORMAT JSONEachRow` });
  if (!r.ok) throw new Error(await r.text());
  return (await r.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, string | number>);
};
await Bun.sleep(4000);

console.log(`== spans in OUR trace ${ourTrace.slice(0, 8)} (our step span ${ourStep.slice(0, 8)})`);
console.table(
  await ch(`SELECT ServiceName AS svc, SpanName AS span, substring(ParentSpanId,1,8) AS parent8,
    SpanAttributes['http.route'] AS route, SpanAttributes['http.response.status_code'] AS status
    FROM default.otel_traces WHERE TraceId='${ourTrace}' ORDER BY Timestamp`),
);

console.log(`== opencode resource: spans by trace for probe.run=${run} (is OTEL_RESOURCE_ATTRIBUTES honoured?)`);
console.table(
  await ch(`SELECT substring(TraceId,1,8) AS trace8, count() AS spans, countIf(ParentSpanId='') AS roots,
    anyIf(SpanName, ParentSpanId='') AS root_span, any(ServiceName) AS svc
    FROM default.otel_traces WHERE ResourceAttributes['probe.run']='${run}' AND ServiceName != 'opencode-probe-caller'
    GROUP BY TraceId ORDER BY spans DESC LIMIT 6`),
);

console.log("== span names with ai./gen_ai./token/tool attributes (top 25)");
console.table(
  await ch(`SELECT SpanName AS span, count() AS n,
    arrayStringConcat(arraySlice(arrayFilter(k -> k LIKE 'ai.%' OR k LIKE 'gen_ai.%' OR k LIKE '%token%' OR k LIKE '%tool%' OR k LIKE 'session%', groupUniqArrayArray(mapKeys(SpanAttributes))), 1, 14), ',') AS keys
    FROM default.otel_traces WHERE ResourceAttributes['probe.run']='${run}' AND ServiceName != 'opencode-probe-caller'
    GROUP BY SpanName HAVING keys != '' ORDER BY n DESC LIMIT 25`),
);

console.log("== top span names overall");
console.table(
  await ch(`SELECT SpanName AS span, count() AS n FROM default.otel_traces
    WHERE ResourceAttributes['probe.run']='${run}' AND ServiceName != 'opencode-probe-caller' GROUP BY SpanName ORDER BY n DESC LIMIT 12`),
);
