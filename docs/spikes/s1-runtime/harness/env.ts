// Credentials come from the environment. Without them, re-exec under secrets-run with the
// dev template (override with SPIKE_ENV_TPL). Nothing here is ever printed.
import { spawnSync } from "node:child_process";

export function ensureCredentials(script: string) {
  if (process.env.SPIKE_PG_URL || process.env.POSTGRES_USER) return;
  const tpl = process.env.SPIKE_ENV_TPL ?? `${process.env.HOME}/SourceRoot/vps/.env.dev.tpl`;
  const res = spawnSync("secrets-run", ["run", `--env-file=${tpl}`, "--", "bun", script, ...process.argv.slice(2)], {
    stdio: ["ignore", "inherit", "inherit"], // an inherited stdin pipe makes secrets-run hang
  });
  process.exit(res.status ?? 1);
}

export function pgUrl(): string {
  if (process.env.SPIKE_PG_URL) return process.env.SPIKE_PG_URL;
  const user = encodeURIComponent(process.env.POSTGRES_USER!);
  const pass = encodeURIComponent(process.env.POSTGRES_PASSWORD!);
  return `postgres://${user}:${pass}@${process.env.PGHOST ?? "localhost"}:${process.env.PGPORT ?? 5432}/spike_s1`;
}
