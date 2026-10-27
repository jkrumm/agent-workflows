// Static and storage footprint per candidate: LOC we wrote, dependency closure from bun.lock,
// install size, Postgres tables/indexes and bytes per happy-path run.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { ENGINE_SCHEMAS } from "./reset.ts";

export type Footprint = {
  locRuntime: number; locWorkflow: number; depsDirect: number; depsTotal: number; installMB: number;
  tables: number; indexes: number; kbPerRun: number;
};

// What we would own in Wave 2 for each candidate. `common/` is identical for all and not counted.
const FILES: Record<string, { runtime: string[]; workflow: string[] }> = {
  own: { runtime: ["candidates/own/runtime.ts"], workflow: ["candidates/own/worker.ts"] },
  dbos: { runtime: [], workflow: ["candidates/dbos/worker.ts"] },
  vercel: {
    runtime: ["candidates/vercel/workflow-plugin.ts", "candidates/vercel/server.ts"],
    workflow: ["candidates/vercel/workflows/s1.ts"],
  },
};
const DIRECT: Record<string, string[]> = {
  own: ["pg"],
  dbos: ["@dbos-inc/dbos-sdk"],
  vercel: ["workflow", "@workflow/world-postgres"],
};

function loc(root: string, files: string[]) {
  let n = 0;
  for (const f of files) {
    for (const line of readFileSync(join(root, f), "utf8").split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")) n++;
    }
  }
  return n;
}

type LockPkg = [string, string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }?];

function lockPackages(root: string): Record<string, LockPkg> {
  const text = readFileSync(join(root, "bun.lock"), "utf8").replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(text).packages;
}

/** Transitive closure over bun.lock keys; nested keys ("parent/dep") shadow hoisted ones. */
function closure(root: string, direct: string[]) {
  const pkgs = lockPackages(root);
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key) || !pkgs[key]) return;
    seen.add(key);
    const meta = pkgs[key]![2] ?? {};
    for (const dep of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies })) {
      const nested = `${key}/${dep}`;
      visit(pkgs[nested] ? nested : dep);
    }
  };
  direct.forEach(visit);
  return seen;
}

/** "a/@s/b" -> "a/node_modules/@s/b": lock keys chain package names, scoped names take two segments. */
function lockKeyPath(key: string) {
  const parts = key.split("/");
  const names: string[] = [];
  for (let i = 0; i < parts.length; i++) names.push(parts[i]!.startsWith("@") ? `${parts[i]}/${parts[++i]}` : parts[i]!);
  return names.join("/node_modules/");
}

function dirSize(path: string): number {
  let total = 0;
  for (const e of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isFile()) total += statSync(p).size;
  }
  return total;
}

export async function footprint(cand: string, url: string, root: string): Promise<Footprint> {
  const keys = closure(root, DIRECT[cand]!);
  let bytes = 0;
  for (const k of keys) {
    const p = join(root, "node_modules", lockKeyPath(k));
    try {
      bytes += dirSize(p);
    } catch {
      // optional platform packages that were not installed
    }
  }
  const c = new Client({ connectionString: url });
  await c.connect();
  const schemas = ENGINE_SCHEMAS[cand]!;
  const t = await c.query(
    "select count(*)::int as n from information_schema.tables where table_schema = any($1) and table_type = 'BASE TABLE'",
    [schemas],
  );
  const i = await c.query("select count(*)::int as n from pg_indexes where schemaname = any($1)", [schemas]);
  // Bytes in the engine's tables divided by the number of top-level runs the measurement made.
  const size = await c.query(
    `select coalesce(sum(pg_total_relation_size(format('%I.%I', schemaname, tablename))), 0)::bigint as b
     from pg_tables where schemaname = any($1)`,
    [schemas],
  );
  const runs = await c.query("select count(distinct run_id)::int as n from harness.probe where cand = $1", [cand]);
  await c.end();
  return {
    locRuntime: loc(root, FILES[cand]!.runtime),
    locWorkflow: loc(root, FILES[cand]!.workflow),
    depsDirect: DIRECT[cand]!.length,
    depsTotal: keys.size,
    installMB: +(bytes / 1e6).toFixed(1),
    tables: t.rows[0].n,
    indexes: i.rows[0].n,
    kbPerRun: +(Number(size.rows[0].b) / 1024 / Math.max(1, runs.rows[0].n)).toFixed(0),
  };
}
