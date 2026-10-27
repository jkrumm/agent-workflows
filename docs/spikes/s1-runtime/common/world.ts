// The world outside the workflow engine: probes, the fake agent server, the effects table.
// Shared by all three candidates and the harness; lives in schema `harness` of database spike_s1.
import { Pool } from "pg";

export const PG_URL = process.env.SPIKE_PG_URL ?? "";
if (!PG_URL) throw new Error("SPIKE_PG_URL is not set; run through `bun run measure`");

export const CANDIDATE = process.env.CANDIDATE ?? "";
export const VERSION = process.env.WF_VERSION ?? "v1";
export const AGENT_MS = Number(process.env.AGENT_MS ?? 60_000);

export const pool = new Pool({ connectionString: PG_URL, max: 4 });

// Self-kill trigger: KILL_AT="<step>:<ev>[:<delayMs>[:<signal>]]". Only the first incarnation gets it.
const killAt = (process.env.KILL_AT ?? "").split(":");
let killArmed = killAt.length >= 2;

async function maybeKill(step: string, ev: string, runId: string) {
  if (!killArmed || killAt[0] !== step || killAt[1] !== ev) return;
  killArmed = false;
  const delay = Number(killAt[2] ?? 0);
  const signal = (killAt[3] ?? "SIGKILL") as NodeJS.Signals;
  const fire = async () => {
    await pool.query(
      "insert into harness.probe (cand, run_id, step, ev, pid, version) values ($1,$2,'-',$3,$4,$5)",
      [CANDIDATE, runId, `kill:${signal}`, process.pid, VERSION],
    );
    process.kill(process.pid, signal);
  };
  if (delay > 0) setTimeout(fire, delay);
  else await fire();
}

export async function probe(runId: string, step: string, ev: string) {
  await pool.query(
    "insert into harness.probe (cand, run_id, step, ev, pid, version) values ($1,$2,$3,$4,$5,$6)",
    [CANDIDATE, runId, step, ev, process.pid, VERSION],
  );
  await maybeKill(step, ev, runId);
}

// Fake OpenCode server. A session runs for AGENT_MS from its prompt, whether or not anyone watches,
// exactly like a real server whose client process died.
export const agentServer = {
  async create(runId: string, step: string): Promise<string> {
    const id = `ses_${crypto.randomUUID()}`;
    await pool.query(
      "insert into harness.sessions (id, cand, run_id, step, duration_ms) values ($1,$2,$3,$4,$5)",
      [id, CANDIDATE, runId, step, AGENT_MS],
    );
    return id;
  },
  async prompt(id: string) {
    await pool.query("update harness.sessions set prompted_at = clock_timestamp() where id = $1 and prompted_at is null", [id]);
  },
  async wait(id: string): Promise<string> {
    for (;;) {
      const { rows } = await pool.query(
        "select extract(epoch from clock_timestamp() - prompted_at) * 1000 as ms, duration_ms from harness.sessions where id = $1",
        [id],
      );
      if (!rows[0]) throw new Error(`unknown session ${id}`);
      if (Number(rows[0].ms) >= rows[0].duration_ms) return `answer from ${id}`;
      await Bun.sleep(250);
    }
  },
};

// An outside effect with an idempotency key. The unique key turns a retry into a no-op.
export async function writeEffect(runId: string, key: string): Promise<"inserted" | "duplicate"> {
  const { rowCount } = await pool.query(
    "insert into harness.effects (key, cand, run_id) values ($1,$2,$3) on conflict (key) do nothing",
    [key, CANDIDATE, runId],
  );
  const outcome = rowCount === 1 ? "inserted" : "duplicate";
  await pool.query("insert into harness.effect_attempts (cand, run_id, key, outcome) values ($1,$2,$3,$4)", [
    CANDIDATE, runId, key, outcome,
  ]);
  return outcome;
}

export async function recordOutcome(runId: string, result: unknown) {
  await pool.query(
    "insert into harness.outcomes (cand, run_id, version, result) values ($1,$2,$3,$4) on conflict do nothing",
    [CANDIDATE, runId, VERSION, JSON.stringify(result)],
  );
}

// The identical step bodies every candidate runs. Only the orchestration around them differs.
export const body = {
  async prepare(runId: string) {
    await probe(runId, "prepare", "start");
    const out = { n: 21 };
    await probe(runId, "prepare", "end");
    return out;
  },
  async audit(runId: string) {
    // Only called by the v2-break source: a step inserted ahead of recorded ones.
    await probe(runId, "audit", "start");
    await probe(runId, "audit", "end");
    return { audited: true };
  },
  async effect(runId: string, key: string) {
    await probe(runId, "effect", "start");
    const outcome = await writeEffect(runId, key);
    await probe(runId, "effect", "committed");
    await Bun.sleep(1500); // the in-doubt window: effect committed, step not yet journaled
    await probe(runId, "effect", "end");
    return { outcome };
  },
  async child(runId: string, i: number) {
    const step = `child-${i}`;
    await probe(runId, step, "start");
    await Bun.sleep(1000);
    if (i === 1) {
      await probe(runId, step, "fail");
      throw new Error("child 1 fails by design");
    }
    await probe(runId, step, "end");
    return { child: i, value: i * 10 };
  },
  async finish(runId: string, children: unknown[], prepared: { n: number }, codeVersion: string) {
    await probe(runId, "finish", "start");
    const result = { version: codeVersion, n: prepared.n * 2, children };
    await recordOutcome(runId, result);
    await probe(runId, "finish", "end");
    return result;
  },
};
