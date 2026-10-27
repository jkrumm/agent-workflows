// Recomputes every figure REPORT.md cites from evidence/*.jsonl. `bun scripts/audit.ts` prints them; the report quotes this output.
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, any>;
const load = (f: string): Row[] => readFileSync(join(import.meta.dir, "..", "evidence", f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const rng = (a: number[]) => (a.length ? `${Math.min(...a)} / ${med(a)} / ${Math.max(...a)}` : "n/a");
const ms = (t: string) => Number(/(\d+)ms/.exec(t)?.[1] ?? NaN);
const line = (k: string, v: unknown) => console.log(`${k.padEnd(62)} ${v}`);
const outcome = (r: Row) => r.outcome === "wedge" ? "timeout" : r.outcome; // pre-review rows used "wedge" for any non-prompt end; the only such rows kept as evidence are none

const bw = load("bisect-wedge.jsonl"), bf = load("bisect-fixed.jsonl"), rc = load("recipe.jsonl"), loc = load("location-dose.jsonl");
console.log("min / median / max");
line("bisect-wedge: trials, prompted", `${bw.length}, ${bw.filter((r) => outcome(r) === "prompt").length}`);
line("bisect-wedge: prompt ms", rng(bw.map((r) => r.promptMs)));
line("bisect-wedge: boot ms", rng(bw.map((r) => r.locBootMs).filter((x) => x >= 0)));
line("bisect-wedge: mean CPU % per trial", rng(bw.map((r) => r.cpuMean)));
line("bisect-wedge: SIGTERM not honoured in 6 s", `${bw.filter((r) => r.term.startsWith("ignored")).length}/${bw.length}`);
line("bisect-wedge: SIGTERM exit ms (those that exited)", bw.filter((r) => r.term.startsWith("term ")).map((r) => ms(r.term)).join(", "));
line("bisect-wedge: SIGKILL ok, ms", `${bw.filter((r) => r.kill.startsWith("SIGKILL ok")).length}, ${rng(bw.filter((r) => r.kill.startsWith("SIGKILL ok")).map((r) => ms(r.kill)))}`);
const base = bw.filter((r) => r.cell === "baseline");
line("bisect-wedge baseline cell: prompt ms", base.map((r) => r.promptMs).join(", "));
line("bisect-wedge baseline cell: >45 s", `${base.filter((r) => r.promptMs > 45000).length}/${base.length}`);
line("bisect-fixed: trials, prompted", `${bf.length}, ${bf.filter((r) => outcome(r) === "prompt").length}`);
line("bisect-fixed: prompt ms", rng(bf.map((r) => r.promptMs)));
line("bisect-fixed: boot ms", rng(bf.map((r) => r.locBootMs).filter((x) => x >= 0)));
line("bisect-fixed: SIGTERM exit ms", rng(bf.map((r) => ms(r.term))));
line("bisect-fixed: SIGTERM exits >= 1 s (cell #rep: ms)", bf.filter((r) => ms(r.term) >= 1000).map((r) => `${r.cell} #${r.rep}: ${ms(r.term)}`).join("; ") || "none");
line("bisect-fixed: SIGTERM exits < 100 ms", `${bf.filter((r) => ms(r.term) < 100).length}/${bf.length}`);
line("bisect-fixed: any SIGTERM not honoured", bf.filter((r) => r.term.startsWith("ignored")).length);
for (const e of [...new Set(rc.map((r) => r.extra))]) {
  const z = rc.filter((r) => r.extra === e);
  line(`recipe ${JSON.stringify(e)}: boot ms / prompt ms`, `${z.map((r) => r.locBootMs).join(", ")} / ${z.map((r) => r.promptMs).join(", ")}`);
}
const rb = rc.filter((r) => r.extra === "");
line("recipe baseline: >45 s", `${rb.filter((r) => r.promptMs > 45000).length}/${rb.length}`);
const rd = rc.filter((r) => r.extra === "OPENCODE_DISABLE_FILEWATCHER=1");
line("recipe DISABLE_FILEWATCHER: SIGTERM ms", rd.map((r) => ms(r.term)).join(", "));
for (const c of [...new Set(loc.map((r) => r.cell))]) line(`location-dose ${c}: boot ms`, loc.filter((r) => r.cell === c).map((r) => r.locBootMs).join(", "));
const rcheck = (() => { try { return load("recheck.jsonl"); } catch { return []; } })();
for (const c of [...new Set(rcheck.map((r) => r.cell))]) {
  const z = rcheck.filter((r) => r.cell === c);
  line(`recheck ${c}: outcome / prompt ms / boot ms / SIGTERM`, `${z.map((r) => r.outcome).join(",")} / ${z.map((r) => r.promptMs).join(",")} / ${z.map((r) => r.locBootMs).join(",")} / ${z.map((r) => r.term.replace("ignored SIGTERM 6s", "ign").replace(/term (\d+)ms/, "$1")).join(",")}`);
}
const st = (() => { try { return load("stdio.jsonl"); } catch { return []; } })();
for (const c of [...new Set(st.map((r) => r.cell))]) {
  const z = st.filter((r) => r.cell === c);
  line(`stdio ${c}: outcome / prompt ms / log bytes`, `${z.map((r) => r.outcome).join(",")} / ${z.map((r) => r.promptMs).join(",")} / ${z.map((r) => r.logBytes).join(",")}`);
}
