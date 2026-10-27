// Runs groups of trials (cells x reps) with bounded concurrency and prints a count table.
//   bun scripts/matrix.ts <group>[,<group>...] [--reps N] [--conc N] [--out file.jsonl]
// Groups: replay, location, recipe, bisect-wedge, bisect-fixed  (see `groups` below). Needs the IU Keychain items.
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLEAN_BASE, DEFAULTS, iuCreds, type Opts, type Result, routeReachable, runTrial, startSink } from "./trial.ts";

type Cell = { name: string; o: Partial<Opts>; setup?: () => void; teardown?: () => void };
const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1]! : d; };
const REPS = Number(arg("--reps", "3"));
const CONC = Number(arg("--conc", "3"));
const OUT = arg("--out", join(import.meta.dir, "..", "evidence", "matrix.jsonl"));
const wanted = (process.argv[2] ?? "replay").split(",");
const CEIL = Number(arg("--ceil", "45000"));

/** Fixture trees live under /tmp/ocw-dose-*, one at a time (setup before the cell's reps, teardown after), so they never pollute each other's ancestors. */
const doseRoot = (name: string) => join("/tmp", `ocw-dose-${name}`);
function fill(dir: string, n: number) { mkdirSync(dir, { recursive: true }); for (let i = 0; i < n; i++) writeFileSync(join(dir, `f${i}`), ""); }
const dose = (label: string, name: string, n: number, where: "ancestor-entries" | "grandchildren"): Cell => ({
  name: label,
  o: { cwd: "clean", cwdBase: doseRoot(name), base: undefined },
  setup: () => { rmSync(doseRoot(name), { recursive: true, force: true }); mkdirSync(doseRoot(name), { recursive: true }); if (n) fill(where === "ancestor-entries" ? doseRoot(name) : join(doseRoot(name), "other"), n); },
  teardown: () => rmSync(doseRoot(name), { recursive: true, force: true }),
});

const TMP = tmpdir(); // the mini's real TMPDIR: ~30k entries
const wedgeBase: Partial<Opts> = {}; // = DEFAULTS: scratch under TMPDIR, exactly S2's spawn

const flips = (b: () => Partial<Opts>): Cell[] => [
  { name: "baseline", o: {} },
  { name: "env=parent", o: { env: "parent" } },
  { name: "cwd=repo(AGENTS.md ancestor)", o: { cwd: "repo" } },
  { name: "cwd=empty dir", o: { cwd: "empty" } },
  { name: "cwd=clean /tmp dir", o: { cwd: "clean" } },
  { name: "home=warm", o: { home: "warm" } },
  { name: "otel=unset", o: { otel: "unset", resattr: false } },
  { name: "otel=down", o: { otel: "down" } },
  { name: "otel=up +flag", o: { flag: true } },
  { name: "otel=up svcname (dotfiles)", o: { resattr: false } },
  { name: "client=curl", o: { client: "curl" } },
  { name: "host=127.0.0.1", o: { host: "127.0.0.1" } },
  { name: "host=::1", o: { host: "::1" } },
  { name: "port=fixed 17900", o: { port: "fixed" } },
  { name: "stdio=pipe-unread", o: { stdio: "pipe-unread" } },
  { name: "stdio=pipe-read", o: { stdio: "pipe-read" } },
  { name: "stdio=null", o: { stdio: "null" } },
  { name: "stdio=inherit", o: { stdio: "inherit" } },
].map((c) => ({ name: c.name, o: { ...b(), ...c.o } }));

const groups: Record<string, () => Cell[]> = {
  replay: () => [
    { name: "S2 spawn as ran (no flag)", o: {} },
    { name: "S2 spawn as ran (--flag)", o: { flag: true } },
    { name: "S2 spawn as ran (--curl)", o: { client: "curl" } },
  ],
  location: () => [
    { name: "cwd under real TMPDIR (~30k entries in T/)", o: {} },
    dose("cwd under /tmp, empty parent", "0", 0, "ancestor-entries"),
    ...[1000, 10000, 40000].map((n) => dose(`parent holds ${n} files`, `a${n}`, n, "ancestor-entries")),
    ...[1000, 10000, 40000].map((n) => dose(`parent's sibling dir holds ${n} files`, `g${n}`, n, "grandchildren")),
  ],
  recipe: () => [
    { name: "S2 spawn as ran (baseline)", o: {} },
    { name: "+ OPENCODE_DISABLE_FILEWATCHER=1", o: { extra: "OPENCODE_DISABLE_FILEWATCHER=1" } },
    { name: "+ OPENCODE_FILEWATCHER_DISABLE=1", o: { extra: "OPENCODE_FILEWATCHER_DISABLE=1" } },
    { name: "+ both watcher flags", o: { extra: "OPENCODE_DISABLE_FILEWATCHER=1;OPENCODE_FILEWATCHER_DISABLE=1" } },
    { name: "+ OPENCODE_DISABLE_PROJECT_CONFIG=1", o: { extra: "OPENCODE_DISABLE_PROJECT_CONFIG=1" } },
    { name: "+ OPENCODE_FAST_BOOT=1", o: { extra: "OPENCODE_FAST_BOOT=1" } },
  ],
  repro: () => [
    { name: "S2 spawn as ran (watchers on)", o: {} },
    { name: "same + OPENCODE_DISABLE_FILEWATCHER=1", o: { extra: "OPENCODE_DISABLE_FILEWATCHER=1" } },
  ],
  "bisect-wedge": () => flips(() => ({})),
  "bisect-fixed": () => flips(() => ({ extra: "OPENCODE_DISABLE_FILEWATCHER=1" })),
};

const creds = iuCreds();
if (!(await routeReachable(creds))) { console.error("IU route unreachable; not starting opencode"); process.exit(75); }
const sink = startSink();
const scratch = join(TMP, `ocw-matrix-${Date.now().toString(36)}`);
mkdirSync(scratch, { recursive: true });
mkdirSync(CLEAN_BASE, { recursive: true });
mkdirSync(join(import.meta.dir, "..", "evidence"), { recursive: true });

const SERIAL = new Set(["location"]); // fixture groups: one cell at a time, setup/teardown around its reps
const jobs: { group: string; cell: Cell; rep: number }[] = [];
for (const g of wanted) {
  if (!groups[g]) throw new Error(`unknown group ${g}`);
  if (SERIAL.has(g)) continue;
  for (let rep = 1; rep <= REPS; rep++) for (const cell of groups[g]()) jobs.push({ group: g, cell, rep }); // rep-major: cells share the machine's load drift
}
const rows: (Result & { group: string; cell: string; rep: number })[] = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const j = jobs[next++]!;
    const o: Opts = { ...DEFAULTS, ceilingMs: CEIL, ...j.cell.o, tag: `${j.group}` };
    const r = await runTrial(o, creds, sink, scratch);
    const row = { group: j.group, cell: j.cell.name, rep: j.rep, ...r };
    delete (row as any).root; delete (row as any).base;
    rows.push(row as any);
    appendFileSync(OUT, JSON.stringify(row) + "\n");
    console.error(`${j.group} | ${j.cell.name} #${j.rep}: ${r.outcome} (${r.where}) prompt=${r.promptMs}ms boot=${r.locBootMs}ms cpu=${r.cpuMean}% term=${r.term}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
for (const g of wanted.filter((x) => SERIAL.has(x))) {
  for (const cell of groups[g]!()) {
    cell.setup?.();
    for (let rep = 1; rep <= REPS; rep++) {
      const r = await runTrial({ ...DEFAULTS, ceilingMs: CEIL, ...cell.o, tag: g }, creds, sink, scratch);
      const row: any = { group: g, cell: cell.name, rep, ...r };
      delete row.root; delete row.base;
      rows.push(row);
      appendFileSync(OUT, JSON.stringify(row) + "\n");
      console.error(`${g} | ${cell.name} #${rep}: ${r.outcome} (${r.where}) prompt=${r.promptMs}ms boot=${r.locBootMs}ms cpu=${r.cpuMean}%`);
    }
    cell.teardown?.();
  }
}
sink.stop();

console.log("\n|group|cell|prompted / n|wedged|median prompt ms|median location-boot ms|mean CPU %|prompt >45 s (S2 guard)|SIGTERM not honoured in 6 s|SIGKILL ok|");
console.log("|-|-|-|-|-|-|-|-|-|-|");
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
for (const g of wanted) for (const cell of groups[g]!()) {
  const rs = rows.filter((r) => r.group === g && r.cell === cell.name);
  const ok = rs.filter((r) => r.outcome === "prompt").length;
  console.log(`|${g}|${cell.name}|${ok}/${rs.length}|${rs.length - ok}|${med(rs.map((r) => r.promptMs))}|${med(rs.filter((r) => r.locBootMs >= 0).map((r) => r.locBootMs))}|${med(rs.filter((r) => r.cpuMean >= 0).map((r) => r.cpuMean))}|${rs.filter((r) => r.promptMs > 45000 || r.outcome !== "prompt").length}/${rs.length}|${rs.filter((r) => r.term.startsWith("ignored")).length}/${rs.length}|${rs.filter((r) => r.kill.startsWith("SIGKILL ok")).length}/${rs.filter((r) => r.term.startsWith("ignored")).length}|`);
}
