// Candidate (a): our own journal on Postgres. The whole runtime is this file.
import { Pool, type PoolClient } from "pg";

export const SCHEMA = `
create schema if not exists own;
create table if not exists own.runs (
  id text primary key, workflow text not null, input jsonb not null, parent_id text,
  status text not null default 'pending' check (status in ('pending','running','done','failed')),
  version_started text not null, version_finished text, output jsonb, error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists own.steps (
  run_id text not null references own.runs(id), step_id text not null,
  kind text not null check (kind in ('code','agent','effect','workflow')),
  status text not null check (status in ('running','done','failed')),
  handle jsonb, output jsonb, error text, attempts int not null default 1,
  started_at timestamptz not null default now(), finished_at timestamptz,
  primary key (run_id, step_id));
`;

export type StepKind = "code" | "agent" | "effect" | "workflow";
export type Middleware = {
  runPre?: (run: { id: string; workflow: string }) => Promise<void> | void;
  runPost?: (run: { id: string; workflow: string; status: "done" | "failed" }) => Promise<void> | void;
  stepPre?: (step: { runId: string; stepId: string; kind: StepKind; replay: boolean }) => Promise<void> | void;
  stepPost?: (step: { runId: string; stepId: string; kind: StepKind; status: "done" | "failed" }) => Promise<void> | void;
};

/** `run` prompts the session if it was never prompted, then waits: on a resume that is the re-attach. */
export type AgentDriver = {
  open(runId: string, stepId: string): Promise<string>;
  run(runId: string, sessionId: string): Promise<string>;
};

export type Ctx = {
  runId: string;
  step<T>(id: string, fn: () => Promise<T>): Promise<T>;
  effect<T>(id: string, fn: (key: string) => Promise<T>): Promise<T>;
  agent(id: string): Promise<string>;
  children<I, O>(id: string, wf: Workflow<I, O>, inputs: I[]): Promise<(O | null)[]>;
};

export type Workflow<I, O> = { id: string; run(ctx: Ctx, input: I): Promise<O> };

export function defineWorkflow<I, O>(wf: Workflow<I, O>): Workflow<I, O> {
  return wf;
}

export class Runtime {
  private pool: Pool;
  private workflows = new Map<string, Workflow<any, any>>();
  private active = new Set<string>();

  constructor(url: string, private version: string, private agents: AgentDriver, private mw: Middleware[] = []) {
    this.pool = new Pool({ connectionString: url, max: 20 });
  }

  register(...wfs: Workflow<any, any>[]) {
    for (const wf of wfs) this.workflows.set(wf.id, wf);
  }

  async migrate() {
    await this.pool.query(SCHEMA);
  }

  /** Idempotent by run id: a second start with the same id is a no-op. */
  async start(wf: Workflow<any, any>, runId: string, input: unknown, parentId?: string) {
    await this.pool.query(
      `insert into own.runs (id, workflow, input, parent_id, version_started) values ($1,$2,$3,$4,$5) on conflict (id) do nothing`,
      [runId, wf.id, JSON.stringify(input), parentId ?? null, this.version],
    );
  }

  /** Claims every unfinished top-level run nobody holds. Children are driven by their parent's step. */
  async recover() {
    const { rows } = await this.pool.query(
      `select id from own.runs where parent_id is null and status in ('pending','running') order by created_at`,
    );
    for (const { id } of rows) if (!this.active.has(id)) void this.drive(id);
  }

  /** The advisory lock is the lease: Postgres drops it the moment the holder's connection dies. */
  private async drive(runId: string) {
    this.active.add(runId);
    const lock = await this.pool.connect();
    try {
      const { rows } = await lock.query("select pg_try_advisory_lock(hashtext($1)) as ok", [runId]);
      if (!rows[0].ok) return;
      await this.execute(runId);
    } finally {
      await lock.query("select pg_advisory_unlock_all()").catch(() => {});
      lock.release();
      this.active.delete(runId);
    }
  }

  private async execute(runId: string): Promise<{ status: "done" | "failed"; output?: unknown }> {
    const { rows } = await this.pool.query("select * from own.runs where id = $1", [runId]);
    const run = rows[0];
    if (run.status === "done") return { status: "done", output: run.output };
    if (run.status === "failed") return { status: "failed" };
    const wf = this.workflows.get(run.workflow);
    if (!wf) throw new Error(`workflow ${run.workflow} not registered`);
    await this.pool.query("update own.runs set status = 'running', updated_at = now() where id = $1", [runId]);
    for (const m of this.mw) await m.runPre?.({ id: runId, workflow: wf.id });
    try {
      const output = await wf.run(this.ctx(runId), run.input);
      await this.pool.query(
        "update own.runs set status = 'done', output = $2, version_finished = $3, updated_at = now() where id = $1",
        [runId, JSON.stringify(output ?? null), this.version],
      );
      for (const m of this.mw) await m.runPost?.({ id: runId, workflow: wf.id, status: "done" });
      return { status: "done", output };
    } catch (err) {
      await this.pool.query(
        "update own.runs set status = 'failed', error = $2, version_finished = $3, updated_at = now() where id = $1",
        [runId, String(err), this.version],
      );
      for (const m of this.mw) await m.runPost?.({ id: runId, workflow: wf.id, status: "failed" });
      return { status: "failed" };
    }
  }

  private ctx(runId: string): Ctx {
    const journaled = async <T>(stepId: string, kind: StepKind, fn: (row: any) => Promise<T>): Promise<T> => {
      const { rows } = await this.pool.query("select * from own.steps where run_id = $1 and step_id = $2", [runId, stepId]);
      const row = rows[0];
      if (row?.status === "done") return row.output as T;
      if (row?.status === "failed") throw new Error(row.error);
      for (const m of this.mw) await m.stepPre?.({ runId, stepId, kind, replay: !!row });
      await this.pool.query(
        `insert into own.steps (run_id, step_id, kind, status) values ($1,$2,$3,'running')
         on conflict (run_id, step_id) do update set attempts = own.steps.attempts + 1, status = 'running'`,
        [runId, stepId, kind],
      );
      try {
        const output = await fn(row);
        await this.pool.query(
          "update own.steps set status = 'done', output = $3, finished_at = now() where run_id = $1 and step_id = $2",
          [runId, stepId, JSON.stringify(output ?? null)],
        );
        for (const m of this.mw) await m.stepPost?.({ runId, stepId, kind, status: "done" });
        return output;
      } catch (err) {
        await this.pool.query(
          "update own.steps set status = 'failed', error = $3, finished_at = now() where run_id = $1 and step_id = $2",
          [runId, stepId, String(err)],
        );
        for (const m of this.mw) await m.stepPost?.({ runId, stepId, kind, status: "failed" });
        throw err;
      }
    };

    return {
      runId,
      step: (id, fn) => journaled(id, "code", fn),
      effect: (id, fn) => journaled(id, "effect", () => fn(`${runId}:${id}`)),
      agent: (id) =>
        journaled(id, "agent", async (row) => {
          let sessionId: string | undefined = row?.handle?.sessionId;
          if (!sessionId) {
            sessionId = await this.agents.open(runId, id);
            await this.pool.query("update own.steps set handle = $3 where run_id = $1 and step_id = $2", [
              runId, id, JSON.stringify({ sessionId }),
            ]);
          }
          return this.agents.run(runId, sessionId);
        }),
      children: (id, wf, inputs) =>
        journaled(id, "workflow", () =>
          Promise.all(
            inputs.map(async (input, i) => {
              const childId = `${runId}/${id}/${i}`;
              await this.start(wf, childId, input, runId);
              const res = await this.execute(childId);
              return res.status === "done" ? res.output : null; // failure split: a child returns null
            }),
          ),
        ),
    };
  }

  async close() {
    await this.pool.end();
  }
}
