// Follow-up for Vercel's stuck runs, run by `measure` after the scenarios: back-date graphile-worker
// job locks by 5 h (past its hard-coded 4 h job expiry) and start one v1 worker for 120 s; measure then
// re-reads every Vercel run's status. Standalone: `bun harness/vercel-lock-probe.ts`.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Client } from "pg";
import { ensureCredentials, pgUrl } from "./env.ts";

export async function lockProbe(url: string, root: string) {
  const c = new Client({ connectionString: url });
  await c.connect();
  const locked = await c.query("update graphile_worker._private_jobs set locked_at = locked_at - interval '5 hours' where locked_at is not null");
  await c.end();
  const p = spawn("bun", ["server.ts"], {
    cwd: join(root, ".build", "vercel-v1", "candidates", "vercel"),
    stdio: "ignore",
    env: { ...process.env, SPIKE_PG_URL: url, CANDIDATE: "vercel", RUN_ID: "lock-probe", START: "0", WF_VERSION: "v1",
      WORKFLOW_TARGET_WORLD: "@workflow/world-postgres", WORKFLOW_POSTGRES_URL: url, PORT: "3199" },
  });
  await Bun.sleep(120_000);
  p.kill("SIGTERM");
  await Bun.sleep(2_000);
  return { locksBackdated: locked.rowCount ?? 0 };
}

if (import.meta.main) {
  ensureCredentials(import.meta.path);
  console.log(await lockProbe(pgUrl(), join(import.meta.dir, "..")));
  process.exit(0);
}
