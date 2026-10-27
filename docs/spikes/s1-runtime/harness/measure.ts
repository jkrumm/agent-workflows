// `bun run measure`: builds every candidate version, runs every scenario against every candidate
// (candidates in parallel, scenarios in sequence), prints the results tables and writes results/.
// Options: --agent-ms <n> (default 60000), --only <cand,...>, --scenario <name,...>
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, openSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { ensureCredentials, pgUrl } from "./env.ts";
import { footprint, type Footprint } from "./footprint.ts";
import { lockProbe } from "./vercel-lock-probe.ts";
import { reset } from "./reset.ts";

ensureCredentials(import.meta.path);

const ROOT = join(import.meta.dir, "..");
const BUILD = join(ROOT, ".build");
const RAW = join(ROOT, "results", "raw");
const URL_ = pgUrl();
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const AGENT_MS = Number(arg("agent-ms") ?? 60_000);
const HALF = Math.round(AGENT_MS / 2);
const CANDIDATES = (arg("only") ?? "own,dbos,vercel").split(",");
const OUTAGE_MS = 2_000;
const STUCK_MS = AGENT_MS + 120_000;

type Scenario = { name: string; kill?: string; deployTo?: string; pinned?: boolean; only?: string };
const SCENARIOS: Scenario[] = [
  { name: "happy" },
  { name: "b-agent", kill: "agent.open:start" },
  { name: "b-effect", kill: "effect:start" },
  { name: "b-fanout", kill: "child-0:start" },
  { name: "b-finish", kill: "finish:start" },
  { name: "m-prepare", kill: "prepare:end" },
  { name: "m-agent", kill: `agent:start:${HALF}` },
  { name: "m-effect", kill: "effect:committed" },
  { name: "m-child", kill: "child-0:start:500" },
  { name: "deploy", kill: `agent:start:${HALF}:SIGTERM`, deployTo: "v2" },
  { name: "deploy-break", kill: `agent:start:${HALF}:SIGTERM`, deployTo: "v2-break" },
  { name: "deploy-break-late", kill: "child-0:start:0:SIGTERM", deployTo: "v2-break" },
  { name: "deploy-pinned", kill: `agent:start:${HALF}:SIGTERM`, deployTo: "v2", pinned: true, only: "dbos" },
  { name: "deploy-break-late-pinned", kill: "child-0:start:0:SIGTERM", deployTo: "v2-break", pinned: true, only: "dbos" },
].filter((s) => !arg("scenario") || arg("scenario")!.split(",").includes(s.name));

// ---------- build: one copy of each candidate per code version, with a real source change ----------

function transform(src: string, version: string) {
  let out = src.replaceAll(`"v1" /* @version */`, `"${version}" /* @version */`);
  if (version === "v2-break") out = out.replaceAll("// @break ", "");
  return out;
}

function build(cand: string, version: string) {
  const dir = join(BUILD, `${cand}-${version}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "candidates"), { recursive: true });
  symlinkSync(join(ROOT, "common"), join(dir, "common"));
  const target = join(dir, "candidates", cand);
  cpSync(join(ROOT, "candidates", cand), target, {
    recursive: true,
    filter: (p) => !p.includes(".well-known"),
  });
  const wfFile = cand === "vercel" ? join(target, "workflows", "s1.ts") : join(target, "worker.ts");
  writeFileSync(wfFile, transform(readFileSync(wfFile, "utf8"), version));
  if (cand === "vercel") {
    const r = spawnSync("bun", ["x", "workflow", "build"], { cwd: target, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`vercel build ${version} failed:\n${r.stdout}\n${r.stderr}`);
  }
  return target;
}

// ---------- one scenario ----------

type Row = {
  cand: string; scenario: string; outcome: "ok" | "FAIL" | "stuck"; why: string;
  completedReruns: number; inDoubtReruns: number; effectRows: number; effectDupAttempts: number;
  sessions: number; agentWallS: number | null; recoveryS: number | null; finishedOn: string | null;
  engineRunId?: string; engineStatus: string; finalStatus?: string; afterLockProbe?: string; mw: string; totalS: number; pgBlip: boolean; attempts: number;
};

const LOG_BLIP = /the database system is shutting down|the database system is starting up|terminating connection due to administrator|ECONNREFUSED/;

async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: URL_ });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

function launch(cand: string, version: string, runId: string, logFile: string, extra: Record<string, string>) {
  const dir = join(BUILD, `${cand}-${version}`, "candidates", cand);
  const entry = cand === "vercel" ? "server.ts" : "worker.ts";
  const fd = openSync(logFile, "a");
  return spawn("bun", [entry], {
    cwd: dir,
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      SPIKE_PG_URL: URL_,
      CANDIDATE: cand,
      RUN_ID: runId,
      WF_VERSION: version,
      AGENT_MS: String(AGENT_MS),
      WORKFLOW_TARGET_WORLD: "@workflow/world-postgres",
      WORKFLOW_POSTGRES_URL: URL_,
      PORT: "3199",
      ...extra,
    },
  });
}

/** Engine-side status of one run. Vercel assigns its own run ids; the harness resolves it once. */
async function engineStatus(cand: string, id: string | undefined): Promise<string> {
  if (!id) return "none";
  try {
    if (cand === "own") return (await q("select status from own.runs where id = $1", [id]))[0]?.status ?? "none";
    if (cand === "dbos")
      return (await q("select status from dbos.workflow_status where workflow_uuid = $1", [id]))[0]?.status ?? "none";
    const r = (await q("select status, error_code from workflow.workflow_runs where id = $1", [id]))[0];
    return r ? [r.status, r.error_code].filter(Boolean).join(" ") : "none";
  } catch (e) {
    return `error: ${String(e).slice(0, 60)}`;
  }
}

async function vercelRunId(since: Date): Promise<string | undefined> {
  const rows = await q("select id from workflow.workflow_runs where name like '%//s1' and created_at >= $1 order by created_at limit 1", [since]);
  return rows[0]?.id;
}

const TERMINAL_FAIL = new Set(["failed", "ERROR", "MAX_RECOVERY_ATTEMPTS_EXCEEDED", "cancelled", "CANCELLED"]);

async function waitFor(cand: string, runId: string, engineId: () => Promise<string | undefined>, deadline: number, exited: () => boolean) {
  while (Date.now() < deadline) {
    if ((await q("select 1 from harness.outcomes where cand = $1 and run_id = $2", [cand, runId])).length) return "done";
    if (TERMINAL_FAIL.has((await engineStatus(cand, await engineId())).split(" ")[0]!)) return "failed";
    if (exited()) return "exited";
    await Bun.sleep(250);
  }
  return "timeout";
}

async function stop(p: ReturnType<typeof spawn>) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  const gone = new Promise((r) => p.once("exit", r));
  p.kill("SIGTERM");
  await Promise.race([gone, Bun.sleep(5000)]);
  if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
}

async function runScenario(cand: string, sc: Scenario, attempt: number): Promise<Row> {
  const runId = `${cand}-${sc.name}-${Date.now()}`;
  const logFile = join(RAW, `${cand}-${sc.name}.log`);
  writeFileSync(logFile, "");
  const since = new Date(Date.now() - 1000);
  const t0 = Date.now();
  const pinned = sc.pinned ? { DBOS__APPVERSION: "pinned" } : {};
  let engineRunId: string | undefined = cand === "vercel" ? undefined : runId;
  const engineId = async () => (engineRunId ??= await vercelRunId(since));
  let p = launch(cand, "v1", runId, logFile, { START: "1", ...(sc.kill ? { KILL_AT: sc.kill } : {}), ...pinned });
  let exited = false;
  p.once("exit", () => (exited = true));
  let state = await waitFor(cand, runId, engineId, t0 + STUCK_MS, () => exited);
  let respawnAt: number | null = null;
  if (state === "exited" && sc.kill) {
    await Bun.sleep(OUTAGE_MS);
    respawnAt = Date.now();
    p = launch(cand, sc.deployTo ?? "v1", runId, logFile, { START: "0", ...pinned });
    exited = false;
    p.once("exit", () => (exited = true));
    state = await waitFor(cand, runId, engineId, respawnAt + STUCK_MS, () => exited);
  }
  // Children and run/post may land just after the outcome row; let the engine settle.
  await Bun.sleep(1500);
  const status = await engineStatus(cand, await engineId());
  await stop(p);
  const totalS = (Date.now() - t0) / 1000;

  const probes = await q<{ step: string; ev: string; pid: number; ts: Date }>(
    "select step, ev, pid, ts from harness.probe where cand = $1 and run_id = $2 order by id",
    [cand, runId],
  );
  const kill = probes.find((r) => r.step === "-");
  const killTs = kill ? +kill.ts : Infinity;
  const [trigStep, trigEv] = (sc.kill ?? "").split(":");
  let completedReruns = 0;
  let inDoubtReruns = 0;
  const steps = new Set(probes.filter((r) => r.step !== "mw" && r.step !== "-").map((r) => r.step));
  for (const s of steps) {
    const endedBefore = probes.some((r) => r.step === s && (r.ev === "end" || r.ev === "fail") && +r.ts <= killTs);
    const rerun = probes.filter((r) => r.step === s && r.ev === "start" && +r.ts > killTs).length;
    if (!endedBefore || !rerun) continue;
    if (s === trigStep && trigEv === "end") inDoubtReruns += rerun;
    else completedReruns += rerun;
  }
  const effects = await q("select count(*)::int as n from harness.effects where cand = $1 and run_id = $2", [cand, runId]);
  const dup = await q(
    "select count(*)::int as n from harness.effect_attempts where cand = $1 and run_id = $2 and outcome = 'duplicate'",
    [cand, runId],
  );
  const sessions = await q("select count(*)::int as n from harness.sessions where cand = $1 and run_id = $2", [cand, runId]);
  const agentStart = probes.find((r) => r.step === "agent" && r.ev === "start");
  const agentEnd = probes.findLast((r) => r.step === "agent" && r.ev === "end");
  const recovered = respawnAt ? probes.find((r) => +r.ts > respawnAt! && r.step !== "-") : undefined;
  const outcome = (await q("select version, result from harness.outcomes where cand = $1 and run_id = $2", [cand, runId]))[0];
  const mwCount = (ev: string) => probes.filter((r) => r.step === "mw" && r.ev === ev).length;
  const children = outcome?.result?.children;
  const failSplitOk =
    Array.isArray(children) && children.length === 3 && children[1] === null && children[0] && children[2];

  const why: string[] = [];
  if (!outcome) why.push(state === "timeout" ? `no outcome after ${STUCK_MS / 1000}s` : `no outcome (${state})`);
  if (outcome && !failSplitOk) why.push("failure split wrong");
  if (effects[0].n !== 1) why.push(`${effects[0].n} effect rows`);
  if (completedReruns) why.push(`${completedReruns} completed step(s) re-ran`);
  const log = readFileSync(logFile, "utf8");
  return {
    cand,
    scenario: sc.name,
    outcome: why.length === 0 ? "ok" : state === "timeout" ? "stuck" : "FAIL",
    why: why.join("; "),
    completedReruns,
    inDoubtReruns,
    effectRows: effects[0].n,
    effectDupAttempts: dup[0].n,
    sessions: sessions[0].n,
    agentWallS: agentStart && agentEnd ? (+agentEnd.ts - +agentStart.ts) / 1000 : null,
    recoveryS: recovered && respawnAt ? (+recovered.ts - respawnAt) / 1000 : null,
    finishedOn: outcome?.version ?? null,
    engineRunId,
    engineStatus: status,
    mw: ["run/pre", "step/pre", "step/post", "run/post"].map(mwCount).join("/"),
    totalS,
    pgBlip: LOG_BLIP.test(log),
    attempts: attempt,
  };
}

async function lane(cand: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (const sc of SCENARIOS) {
    if (sc.only && sc.only !== cand) continue;
    let row = await runScenario(cand, sc, 1);
    // A Postgres restart by the parallel P0b work invalidates the measurement: rerun it.
    for (let a = 2; row.pgBlip && a <= 3; a++) row = await runScenario(cand, sc, a);
    console.error(`[${cand}] ${sc.name}: ${row.outcome} ${row.why} (${row.totalS.toFixed(0)}s)`);
    rows.push(row);
  }
  return rows;
}

// ---------- tables ----------

const fmt = (v: unknown) => (v === null || v === undefined ? "-" : typeof v === "number" ? String(+v.toFixed(1)) : String(v));
function table(head: string[], rows: unknown[][]) {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "-").join("|")}|`, ...rows.map((r) => `| ${r.map(fmt).join(" | ")} |`)].join("\n");
}

function summary(rows: Row[], fp: Record<string, Footprint>) {
  const by = (c: string) => rows.filter((r) => r.cand === c);
  const pick = (c: string, s: string) => by(c).find((r) => r.scenario === s);
  const deployCell = (r?: Row) => (r ? (r.outcome === "ok" ? `finished on ${r.finishedOn}` : `${r.outcome}: ${r.why || r.engineStatus}`) : "-");
  return table(
    ["metric", ...CANDIDATES],
    [
      ["scenarios ok", ...CANDIDATES.map((c) => `${by(c).filter((r) => r.outcome === "ok").length}/${by(c).length}`)],
      ["completed steps re-executed (all kills)", ...CANDIDATES.map((c) => by(c).reduce((a, r) => a + r.completedReruns, 0))],
      ["in-doubt re-runs (kill between step end and journal)", ...CANDIDATES.map((c) => by(c).reduce((a, r) => a + r.inDoubtReruns, 0))],
      ["duplicate effects (rows > 1)", ...CANDIDATES.map((c) => by(c).filter((r) => r.effectRows > 1).length)],
      ["effect retries absorbed by key", ...CANDIDATES.map((c) => by(c).reduce((a, r) => a + r.effectDupAttempts, 0))],
      [`agent step wall after kill at ${HALF / 1000}s (s)`, ...CANDIDATES.map((c) => pick(c, "m-agent")?.agentWallS)],
      ["agent sessions created in m-agent", ...CANDIDATES.map((c) => pick(c, "m-agent")?.sessions)],
      ["median recovery after restart (s)", ...CANDIDATES.map((c) => median(by(c).map((r) => r.recoveryS)))],
      ["deploy, compatible change", ...CANDIDATES.map((c) => deployCell(pick(c, "deploy")))],
      ["deploy, step inserted ahead of the run's position", ...CANDIDATES.map((c) => deployCell(pick(c, "deploy-break")))],
      ["deploy, step inserted before recorded steps", ...CANDIDATES.map((c) => deployCell(pick(c, "deploy-break-late")))],
      ["deploy, pinned version (DBOS only)", ...CANDIDATES.map((c) => deployCell(pick(c, "deploy-pinned")))],
      ["deploy, pinned, step inserted before recorded (DBOS only)", ...CANDIDATES.map((c) => deployCell(pick(c, "deploy-break-late-pinned")))],
      ["status at end of measurement: deploy / deploy-break-late", ...CANDIDATES.map((c) => `${pick(c, "deploy")?.finalStatus} / ${pick(c, "deploy-break-late")?.finalStatus}`)],
      ["middleware run/pre,step/pre,step/post,run/post (happy)", ...CANDIDATES.map((c) => pick(c, "happy")?.mw)],
      ["LOC runtime / workflow+wiring", ...CANDIDATES.map((c) => `${fp[c]!.locRuntime} / ${fp[c]!.locWorkflow}`)],
      ["deps direct / transitive", ...CANDIDATES.map((c) => `${fp[c]!.depsDirect} / ${fp[c]!.depsTotal}`)],
      ["install size (MB)", ...CANDIDATES.map((c) => fp[c]!.installMB)],
      ["Postgres tables / indexes", ...CANDIDATES.map((c) => `${fp[c]!.tables} / ${fp[c]!.indexes}`)],
      ["Postgres kB per run (engine tables / runs measured)", ...CANDIDATES.map((c) => fp[c]!.kbPerRun)],
      ["happy path wall (s)", ...CANDIDATES.map((c) => pick(c, "happy")?.totalS)],
      ["Postgres restarts hit (reruns)", ...CANDIDATES.map((c) => by(c).reduce((a, r) => a + r.attempts - 1, 0))],
    ],
  );
}

function median(xs: (number | null)[]) {
  const v = xs.filter((x): x is number => x !== null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)]! : null;
}

// ---------- main ----------

mkdirSync(RAW, { recursive: true });
await reset(URL_);
const boot = spawnSync(join(ROOT, "node_modules/.bin/bootstrap"), [], {
  env: { ...process.env, WORKFLOW_POSTGRES_URL: URL_ },
  encoding: "utf8",
});
if (boot.status !== 0) throw new Error(`vercel world bootstrap failed: ${boot.stderr}`);
for (const c of CANDIDATES) for (const v of ["v1", "v2", "v2-break"]) build(c, v);
console.error(`agent step ${AGENT_MS / 1000}s, ${SCENARIOS.length} scenarios, candidates ${CANDIDATES.join(", ")}`);

const t0 = Date.now();
const rows = (await Promise.all(CANDIDATES.map(lane))).flat();
const fp: Record<string, Footprint> = {};
for (const c of CANDIDATES) fp[c] = await footprint(c, URL_, ROOT);
// A run can still move after its scenario: a later process of the same version may recover it,
// a later deploy may replay it. The status at the end of the whole measurement shows that.
for (const r of rows) r.finalStatus = await engineStatus(r.cand, r.engineRunId);
const probe = CANDIDATES.includes("vercel") ? await lockProbe(URL_, ROOT) : null;
if (probe) for (const r of rows.filter((r) => r.cand === "vercel")) r.afterLockProbe = await engineStatus(r.cand, r.engineRunId);

const detail = table(
  ["candidate", "scenario", "outcome", "completed re-runs", "in-doubt re-runs", "effect rows", "key-absorbed retries", "sessions", "agent wall s", "recovery s", "finished on", "engine status", "status at end", "after lock probe", "mw pre/sPre/sPost/post", "total s"],
  rows.map((r) => [r.cand, r.scenario, r.outcome + (r.why ? ` (${r.why})` : ""), r.completedReruns, r.inDoubtReruns, r.effectRows, r.effectDupAttempts, r.sessions, r.agentWallS, r.recoveryS, r.finishedOn, r.engineStatus, r.finalStatus, r.afterLockProbe, r.mw, r.totalS]),
);
const probeText = probe
  ? `\nVercel follow-up: ${probe.locksBackdated} graphile-worker job locks back-dated past the 4 h expiry, then one v1 worker ran for 120 s ` +
    `(column "after lock probe").\n`
  : "";
const out = `## Summary\n\n${summary(rows, fp)}\n\n## Per scenario\n\n${detail}\n${probeText}`;
writeFileSync(join(ROOT, "results", "results.json"), JSON.stringify({ agentMs: AGENT_MS, rows, footprint: fp, vercelLockProbe: probe, wallS: (Date.now() - t0) / 1000 }, null, 2));
writeFileSync(join(ROOT, "results", "results.md"), out);
console.log(out);
process.exit(0);
