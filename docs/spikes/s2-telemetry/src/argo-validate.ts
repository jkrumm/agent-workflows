// Validates a real run record (written by `bun run spike`) against the run-record schema, projects it to Argo rows
// and validates those against Argo's own input schema. Nothing is posted anywhere. Writes the committed samples.
import { readFileSync, writeFileSync } from "node:fs";
import { ArgoBody, RunRecord, toArgoRows } from "./run-record.ts";

const dir = `${import.meta.dir}/..`;
const run = RunRecord.parse(JSON.parse(readFileSync(`${dir}/out/run-record.cli.json`, "utf8")));
const rows = toArgoRows(run);
const body = ArgoBody.parse({ records: rows });

// the checks that matter beyond shape
const agent = run.steps.filter((s) => s.kind === "agent");
const sumCost = agent.reduce((c, s) => c + (s.costUsd ?? 0), 0);
if (Math.abs(sumCost - (run.costUsd ?? 0)) > 1e-9) throw new Error("run cost != sum of step cost");
if (rows.some((r) => r.reasoning_tokens > 0 && r.output_tokens === 0)) throw new Error("reasoning without output");
// Argo is keyed (source, source_id, machine): a replay must produce identical keys
const again = toArgoRows(run).map((r) => `${r.source}|${r.source_id}|${r.machine}`);
if (again.join() !== rows.map((r) => `${r.source}|${r.source_id}|${r.machine}`).join()) throw new Error("keys unstable");
// negative control: the schema really rejects bad rows (a float token count, a missing billing)
const bad = ArgoBody.safeParse({ records: [{ ...rows[0], input_tokens: 1.5, billing: undefined }] });
if (bad.success) throw new Error("schema accepted a bad row");

writeFileSync(`${dir}/sample/run-record.sample.json`, JSON.stringify(run, null, 2) + "\n");
writeFileSync(`${dir}/sample/argo-usage-rows.sample.json`, JSON.stringify(body, null, 2) + "\n");
console.log(`run record ok (${run.steps.length} steps); ${rows.length} Argo row(s) valid against UsageRecordInputSchema`);
console.log(`negative control rejected: ${bad.error!.issues.map((i) => i.path.join(".")).join(", ")}`);
console.log(JSON.stringify(body.records[0], null, 2));
