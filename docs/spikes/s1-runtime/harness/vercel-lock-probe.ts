// Vercel follow-up for a stuck run: back-date graphile-worker job locks by 5 h, past the 4 h job
// expiry hard-coded in graphile-worker's SQL (`interval '4 hours'`). `measure` then starts one v1
// worker and waits for the run. Standalone: `bun harness/vercel-lock-probe.ts` back-dates only.
import { Client } from "pg";
import { ensureCredentials, pgUrl } from "./env.ts";

export async function backdateLocks(url: string): Promise<number> {
  const c = new Client({ connectionString: url });
  await c.connect();
  const r = await c.query("update graphile_worker._private_jobs set locked_at = locked_at - interval '5 hours' where locked_at is not null");
  await c.end();
  return r.rowCount ?? 0;
}

if (import.meta.main) {
  ensureCredentials(import.meta.path);
  console.log({ locksBackdated: await backdateLocks(pgUrl()) });
  process.exit(0);
}
