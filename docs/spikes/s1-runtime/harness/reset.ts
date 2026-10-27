// Drops and recreates every schema the spike owns inside database spike_s1. Nothing outside it.
import { Client } from "pg";
import { HARNESS_SCHEMA } from "../common/schema.ts";

export const ENGINE_SCHEMAS: Record<string, string[]> = {
  own: ["own"],
  dbos: ["dbos"],
  vercel: ["workflow", "workflow_drizzle", "graphile_worker"],
};

export async function reset(url: string) {
  const c = new Client({ connectionString: url });
  await c.connect();
  const { rows } = await c.query("select current_database() as db");
  if (rows[0].db !== "spike_s1") throw new Error(`refusing to reset database ${rows[0].db}`);
  for (const s of ["harness", ...Object.values(ENGINE_SCHEMAS).flat()]) await c.query(`drop schema if exists ${s} cascade`);
  await c.query(HARNESS_SCHEMA);
  await c.end();
}

/** Drops one candidate's engine schemas so no earlier scenario's run can be recovered or replayed. */
export async function resetEngine(url: string, cand: string) {
  const c = new Client({ connectionString: url });
  await c.connect();
  const { rows } = await c.query("select current_database() as db");
  if (rows[0].db !== "spike_s1") throw new Error(`refusing to reset database ${rows[0].db}`);
  for (const s of ENGINE_SCHEMAS[cand]!) await c.query(`drop schema if exists ${s} cascade`);
  await c.end();
}

if (import.meta.main) {
  await reset(process.env.SPIKE_PG_URL!);
  process.exit(0);
}
