// Dev helper: run a command with SPIKE_PG_URL set. `bun harness/shell.ts <cmd...>`
import { spawnSync } from "node:child_process";
import { ensureCredentials, pgUrl } from "./env.ts";
ensureCredentials(import.meta.path);
const args = process.argv.slice(2);
const cmd = args[0] === "--" ? args.slice(1) : args;
const r = spawnSync(cmd[0]!, cmd.slice(1), { stdio: "inherit", env: { ...process.env, SPIKE_PG_URL: pgUrl() } });
process.exit(r.status ?? 1);
