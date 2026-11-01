// Admin API probe for the gateway's cost reconciler (docs/gateway.md §Usage and telemetry).
// Read-only: only GET /v1/organizations/*. No Messages API call, zero inference spend.
// Keys resolve through `secrets-run read` and live in memory only. Output is redacted:
// no ids, no key material, dollar amounts only as order-of-magnitude bands.
//
//   bun run probe.ts                       summary for both orgs
//   bun run probe.ts --watch <minutes>     poll 1m buckets once a minute, print when each first shows up

const BASE = "https://api.anthropic.com";
const ORGS = ["iu", "me"] as const;
type Org = (typeof ORGS)[number];
const BETA = "analytics-usage-cost-2026-08-24";
const MONTH_START = "2026-11-01T00:00:00Z";
const LOOKBACK_START = "2026-10-02T00:00:00Z"; // 30 days back: shape when the month is still empty

// ---------- plumbing ----------

async function adminKey(org: Org): Promise<string> {
  const ref = `op://mini/claude-platform/ADMIN_KEY_${org.toUpperCase()}`;
  const p = Bun.spawn(["secrets-run", "read", ref], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()).trim();
  if ((await p.exited) !== 0 || !out) throw new Error(`admin key for ${org} did not resolve`);
  return out;
}

const REDACTIONS: [RegExp, string][] = [
  [/sk-ant-[\w-]+/g, "<key>"],
  [/\b(apikey|wrkspc|user|usr|org|svac|svc|req|page|acct|account)_[A-Za-z0-9]{6,}/g, "<id>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>"],
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>"],
];
const redact = (s: string) => REDACTIONS.reduce((a, [re, to]) => a.replace(re, to), s);

type Res = { status: number; body: any; text: string; ms: number };
type Params = [string, string][];

async function get(key: string, path: string, params: Params = [], beta = false): Promise<Res> {
  const qs = new URLSearchParams(params).toString();
  const headers: Record<string, string> = {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "user-agent": "agent-workflows-spike/0.1 (admin-api probe)",
  };
  if (beta) headers["anthropic-beta"] = BETA;
  const t0 = Date.now();
  const r = await fetch(`${BASE}${path}${qs ? `?${qs}` : ""}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {}
  await Bun.sleep(300);
  return { status: r.status, body, text, ms: Date.now() - t0 };
}

/** Follow has_more/next_page, return all pages merged into one data array. */
async function getAll(key: string, path: string, params: Params, beta = false, maxPages = 20) {
  const data: any[] = [];
  let first: Res | undefined;
  let page: string | undefined;
  let pages = 0;
  for (; pages < maxPages; ) {
    const res = await get(key, path, page ? [...params, ["page", page]] : params, beta);
    pages++;
    first ??= res;
    if (res.status !== 200) return { res, data, pages, refreshed: null as string | null };
    data.push(...(res.body?.data ?? []));
    if (!res.body?.has_more || !res.body?.next_page) {
      return { res, data, pages, refreshed: (res.body?.data_refreshed_at ?? null) as string | null };
    }
    page = res.body.next_page;
  }
  return { res: first!, data, pages, refreshed: null };
}

const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z");
const err = (r: Res) => redact(r.body?.error ? `${r.body.error.type}: ${r.body.error.message}` : r.text.slice(0, 200));

function band(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return "<$1";
  if (usd < 10) return "$1-10";
  if (usd < 100) return "$10-100";
  if (usd < 1000) return "$100-1k";
  return ">$1k";
}

function keyPaths(v: any, prefix = "", out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keyPaths(x, prefix, out));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (x && typeof x === "object") keyPaths(x, p, out);
      else out.add(p);
    }
  return out;
}

const MONEYISH = /credit|balance|remaining|discount|grant|prepaid|available/i;
const moneyKeys = (v: any) => [...keyPaths(v)].filter((k) => MONEYISH.test(k));

function ageMin(ts: string | null | undefined, now: number) {
  return ts ? ((now - Date.parse(ts)) / 60_000).toFixed(1) : "n/a";
}

// ---------- per-org probe ----------

async function probeOrg(org: Org) {
  const key = await adminKey(org);
  const now = new Date();
  const nowIso = iso(now);
  const tomorrow = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)));
  const windows = [
    { label: "month", start: MONTH_START, width: "1h" },
    { label: "lookback", start: LOOKBACK_START, width: "1d" },
  ];
  const L = (s: string) => console.log(`[${org}] ${s}`);
  const seenMoneyKeys = new Set<string>();
  const note = (body: any) => moneyKeys(body).forEach((k) => seenMoneyKeys.add(k));
  console.log(`\n===== org ${org} (now ${nowIso}) =====`);

  // 0. identity / inventory (counts only)
  for (const [label, path, params] of [
    ["organizations/me", "/v1/organizations/me", []],
    ["api_keys", "/v1/organizations/api_keys", [["limit", "100"]]],
    ["workspaces", "/v1/organizations/workspaces", [["limit", "100"]]],
  ] as [string, string, Params][]) {
    const r = await get(key, path, params);
    note(r.body);
    if (r.status !== 200) L(`${label}: ${r.status} ${err(r)}`);
    else if (Array.isArray(r.body?.data)) L(`${label}: 200, ${r.body.data.length} entries, fields [${[...keyPaths(r.body.data[0] ?? {})].join(", ")}]`);
    else L(`${label}: 200, fields [${[...keyPaths(r.body)].filter((k) => !/(^|\.)(id|name|email)$/.test(k)).join(", ")}]`);
  }

  for (const w of windows) {
    // 1+2. legacy cost_report, month, daily, group workspace + description
    const lc = await getAll(key, "/v1/organizations/cost_report", [
      ["starting_at", w.start], ["ending_at", tomorrow], ["bucket_width", "1d"], ["limit", "31"],
      ["group_by[]", "workspace_id"], ["group_by[]", "description"],
    ]);
    note(lc.res.body);
    let legacyCostCents = 0;
    if (lc.res.status !== 200) L(`${w.label} cost_report (legacy, workspace+description): ${lc.res.status} ${err(lc.res)}`);
    else {
      const rows = lc.data.flatMap((b) => b.results ?? []);
      for (const r of rows) legacyCostCents += Number(r.amount);
      const descs = new Set(rows.map((r) => r.description));
      const decimals = rows.map((r) => String(r.amount).split(".")[1]?.length ?? 0);
      L(`${w.label} cost_report (legacy): 200, ${lc.data.length} bucket(s), ${rows.length} row(s), pages ${lc.pages}`);
      L(`${w.label}   row fields [${[...keyPaths(rows)].join(", ")}]`);
      L(`${w.label}   amount type ${typeof rows[0]?.amount}, decimals ${Math.min(...decimals, 99)}..${Math.max(...decimals, 0)}, currency ${[...new Set(rows.map((r) => r.currency))].join(",")}`);
      L(`${w.label}   total (if amount is cents): ${band(legacyCostCents / 100)}; descriptions: ${[...descs].slice(0, 12).join(" | ")}`);
      L(`${w.label}   cost_type ${[...new Set(rows.map((r) => r.cost_type))].join(",")}; token_type ${[...new Set(rows.map((r) => r.token_type))].join(",")}`);
      L(`${w.label}   workspace_id non-null rows: ${rows.filter((r) => r.workspace_id).length}/${rows.length}`);
      L(`${w.label}   newest bucket ${lc.data.at(-1)?.starting_at ?? "none"}`);
    }

    // legacy cost_report grouped by api key: documented group_by is only workspace_id|description
    const lck = await get(key, "/v1/organizations/cost_report", [
      ["starting_at", w.start], ["ending_at", tomorrow], ["group_by[]", "api_key_id"],
    ]);
    L(`${w.label} cost_report (legacy) group_by[]=api_key_id: ${lck.status}${lck.status === 200 ? " (accepted)" : ` ${err(lck)}`}`);

    // analytics/cost: month, daily, by api key + model + cost_type + token_type
    const ac = await getAll(key, "/v1/organizations/analytics/cost", [
      ["starting_at", w.start], ["ending_at", nowIso], ["time_bucket_width", "1d"], ["limit", "1000"],
      ["group_by[]", "api_key_id"], ["group_by[]", "model"], ["group_by[]", "context_window"], ["group_by[]", "cost_type"], ["group_by[]", "token_type"],
    ], true);
    note(ac.res.body);
    let analyticsCostCents = 0;
    let analyticsRefreshed: string | null = ac.refreshed;
    if (ac.res.status !== 200) L(`${w.label} analytics/cost: ${ac.res.status} ${err(ac.res)}`);
    else {
      const rows = ac.data;
      let amt = 0, list = 0;
      for (const r of rows) { amt += Number(r.cost.amount); list += Number(r.cost.list_amount); }
      analyticsCostCents = amt;
      const keys = new Set(rows.map((r) => r.group.api_key_id).filter(Boolean));
      L(`${w.label} analytics/cost (daily, api_key_id+model+cost_type+token_type): 200, ${rows.length} row(s), pages ${ac.pages}`);
      L(`${w.label}   row fields [${[...keyPaths(rows[0] ?? {})].join(", ")}]`);
      L(`${w.label}   amount type ${typeof rows[0]?.cost.amount}, sample decimals ${String(rows[0]?.cost.amount ?? "").split(".")[1]?.length ?? "n/a"}, currency ${rows[0]?.cost.currency}`);
      L(`${w.label}   total amount ${band(amt / 100)} (cents->USD), total list_amount ${band(list / 100)}; amount==list_amount: ${amt === list}`);
      L(`${w.label}   grouping by api_key_id works: ${keys.size > 0 ? `yes, ${keys.size} distinct non-null key(s)` : "no non-null key rows"}; null-key rows ${rows.filter((r) => !r.group.api_key_id).length}`);
      L(`${w.label}   models ${[...new Set(rows.map((r) => r.group.model))].join(",")}; cost_type ${[...new Set(rows.map((r) => r.group.cost_type))].join(",")}`);
      L(`${w.label}   data_refreshed_at ${analyticsRefreshed ?? "null"} (${ageMin(analyticsRefreshed, now.getTime())} min before now)`);
      if (legacyCostCents > 0 || analyticsCostCents > 0)
        L(`${w.label}   legacy vs analytics total: ratio ${(legacyCostCents / (analyticsCostCents || 1)).toFixed(4)} (1.0 = same unit and same before-credit basis)`);
    }

    // analytics/cost without cost_type/token_type, to see whether amount changes shape
    const ac2 = await get(key, "/v1/organizations/analytics/cost", [
      ["starting_at", w.start], ["ending_at", nowIso], ["group_by[]", "api_key_id"],
    ], true);
    if (ac2.status !== 200) L(`${w.label} analytics/cost (per key, whole range): ${ac2.status} ${err(ac2)}`);
    else L(`${w.label} analytics/cost (per key, whole range): 200, ${ac2.body.data.length} row(s), data_refreshed_at ${ac2.body.data_refreshed_at ?? "null"}`);

    // 3. legacy usage_report, 1h, by api key + model
    const lu = await getAll(key, "/v1/organizations/usage_report/messages", [
      ["starting_at", w.start], ["ending_at", nowIso], ["bucket_width", w.width], ["limit", w.width === "1d" ? "31" : "168"],
      ["group_by[]", "api_key_id"], ["group_by[]", "model"],
    ]);
    note(lu.res.body);
    let legacyTokens = 0;
    let latestHour: string | null = null;
    if (lu.res.status !== 200) L(`${w.label} usage_report/messages (legacy): ${lu.res.status} ${err(lu.res)}`);
    else {
      const withData = lu.data.filter((b) => (b.results ?? []).length > 0);
      const rows = withData.flatMap((b) => b.results);
      const sum = (f: (r: any) => number) => rows.reduce((a, r) => a + f(r), 0);
      legacyTokens = sum((r) => r.uncached_input_tokens + r.cache_read_input_tokens + (r.cache_creation?.ephemeral_1h_input_tokens ?? 0) + (r.cache_creation?.ephemeral_5m_input_tokens ?? 0) + r.output_tokens);
      latestHour = withData.at(-1)?.starting_at ?? null;
      const keys = new Set(rows.map((r) => r.api_key_id).filter(Boolean));
      L(`${w.label} usage_report/messages (legacy, ${w.width}, api_key_id+model): 200, ${lu.data.length} bucket(s) (${withData.length} with data), ${rows.length} row(s), pages ${lu.pages}`);
      L(`${w.label}   row fields [${[...keyPaths(rows)].join(", ")}]`);
      L(`${w.label}   tokens: uncached_in ${sum((r) => r.uncached_input_tokens)}, cache_read ${sum((r) => r.cache_read_input_tokens)}, cache_create_5m ${sum((r) => r.cache_creation?.ephemeral_5m_input_tokens ?? 0)}, cache_create_1h ${sum((r) => r.cache_creation?.ephemeral_1h_input_tokens ?? 0)}, output ${sum((r) => r.output_tokens)}`);
      L(`${w.label}   grouping by api_key_id works: ${keys.size > 0 ? `yes, ${keys.size} distinct non-null key(s)` : "no non-null key rows"}; null-key rows ${rows.filter((r) => !r.api_key_id).length}; models ${[...new Set(rows.map((r) => r.model))].join(",")}`);
      L(`${w.label}   latest ${w.width} bucket with data ${latestHour ?? "none"} (${ageMin(latestHour, now.getTime())} min before now, bucket start)`);
    }

    // analytics/usage, 1h, by api key + model
    const au = await getAll(key, "/v1/organizations/analytics/usage", [
      ["starting_at", w.start], ["ending_at", nowIso], ["time_bucket_width", w.width], ["limit", "1000"],
      ["group_by[]", "api_key_id"], ["group_by[]", "model"], ["group_by[]", "context_window"],
    ], true);
    note(au.res.body);
    if (au.res.status !== 200) L(`${w.label} analytics/usage: ${au.res.status} ${err(au.res)}`);
    else {
      const rows = au.data;
      const tot = rows.reduce((a, r) => a + r.usage.total_tokens, 0);
      const reqs = rows.reduce((a, r) => a + (r.usage.requests ?? 0), 0);
      const newest = rows.map((r) => r.starting_at).sort().at(-1) ?? null;
      L(`${w.label} analytics/usage (${w.width}, api_key_id+model): 200, ${rows.length} row(s), pages ${au.pages}, requests ${reqs}`);
      L(`${w.label}   row fields [${[...keyPaths(rows[0] ?? {})].join(", ")}]`);
      L(`${w.label}   total_tokens == legacy token sum: ${tot === legacyTokens} (${tot} vs ${legacyTokens}); newest bucket ${newest ?? "none"} (${ageMin(newest, now.getTime())} min before now)`);
      L(`${w.label}   data_refreshed_at ${au.refreshed ?? "null"} (${ageMin(au.refreshed, now.getTime())} min before now)`);
    }
    if (ac.res.status === 200 && au.res.status === 200 && ac.data.length > 0) {
      // unit check: implied USD per million tokens if `amount` is in cents, to compare with the public price list
      const tok = new Map<string, number>();
      const cents = new Map<string, number>();
      for (const r of au.data) {
        const u = r.usage;
        const k = `${r.group.model}|${r.group.context_window}|`;
        const add = (t: string, n: number) => tok.set(k + t, (tok.get(k + t) ?? 0) + n);
        add("uncached_input_tokens", u.uncached_input_tokens);
        add("output_tokens", u.output_tokens);
        add("cache_read_input_tokens", u.cache_read_input_tokens);
        add("cache_creation.ephemeral_5m_input_tokens", u.cache_creation?.ephemeral_5m_input_tokens ?? 0);
        add("cache_creation.ephemeral_1h_input_tokens", u.cache_creation?.ephemeral_1h_input_tokens ?? 0);
      }
      for (const r of ac.data) {
        if (r.group.cost_type !== "tokens") continue;
        const k = `${r.group.model}|${r.group.context_window}|${r.group.token_type}`;
        cents.set(k, (cents.get(k) ?? 0) + Number(r.cost.amount));
      }
      for (const [k, c] of [...cents].sort()) {
        const t = tok.get(k) ?? 0;
        L(`${w.label}   implied $/MTok ${k.replace(/\|/g, " ").trim()}: ${t > 0 ? (c / 100 / (t / 1e6)).toFixed(3) : "n/a (no tokens)"} (${t} tokens)`);
      }
    }
  }

  // 4. lag: legacy 1m buckets, last 6h
  const since = iso(new Date(now.getTime() - 6 * 3600_000));
  const lm = await getAll(key, "/v1/organizations/usage_report/messages", [
    ["starting_at", since], ["ending_at", nowIso], ["bucket_width", "1m"], ["limit", "1440"], ["group_by[]", "model"],
  ]);
  if (lm.res.status !== 200) L(`lag, usage 1m buckets (last 6h): ${lm.res.status} ${err(lm.res)}`);
  else {
    const withData = lm.data.filter((b) => (b.results ?? []).length > 0);
    const last = withData.at(-1);
    L(`lag, usage 1m buckets (last 6h): ${lm.data.length} bucket(s), ${withData.length} with data`);
    if (last) L(`  latest minute with data ${last.starting_at}; ${ageMin(last.ending_at, now.getTime())} min before now (bucket end); first in window ${withData[0].starting_at}`);
  }

  // 5. balance: any credit/balance-ish field anywhere, plus candidate endpoints
  for (const p of ["/v1/organizations/credit_balance", "/v1/organizations/balance", "/v1/organizations/billing", "/v1/organizations/credits", "/v1/organizations/spend_limits/effective"]) {
    const r = await get(key, p, [], p.includes("spend_limits"));
    note(r.body);
    L(`balance candidate ${p.replace("/v1/organizations/", "")}: ${r.status}${r.status === 200 ? "" : ` ${err(r).slice(0, 90)}`}`);
  }
  L(`credit/balance/discount-like response fields seen anywhere: ${seenMoneyKeys.size ? [...seenMoneyKeys].join(", ") : "none"}`);
}

// ---------- watch mode: when does a bucket first appear? ----------

async function watch(minutes: number, orgs: readonly Org[]) {
  const deadline = Date.now() + minutes * 60_000;
  const keys = Object.fromEntries(await Promise.all(orgs.map(async (o) => [o, await adminKey(o)])));
  const seen = new Map<string, number>();
  console.log(`watching ${orgs.join(",")} for ${minutes} min, polling 1m buckets once a minute (legacy usage_report and analytics/usage)`);
  while (Date.now() < deadline) {
    for (const org of orgs) {
      for (const api of ["legacy", "analytics"] as const) {
        const now = Date.now();
        const from = iso(new Date(now - 90 * 60_000));
        const to = iso(new Date(now));
        const r =
          api === "legacy"
            ? await get(keys[org], "/v1/organizations/usage_report/messages", [
                ["starting_at", from], ["ending_at", to], ["bucket_width", "1m"], ["limit", "120"], ["group_by[]", "model"],
              ])
            : await get(keys[org], "/v1/organizations/analytics/usage", [
                ["starting_at", from], ["ending_at", to], ["time_bucket_width", "1m"], ["limit", "1000"], ["group_by[]", "model"],
              ], true);
        if (r.status !== 200) { console.log(`[${org}/${api}] ${new Date(now).toISOString()} ${r.status} ${err(r)}`); continue; }
        const buckets: { start: string; end: string }[] =
          api === "legacy"
            ? (r.body.data as any[]).filter((b) => (b.results ?? []).length).map((b) => ({ start: b.starting_at, end: b.ending_at }))
            : (r.body.data as any[]).map((x) => ({ start: x.starting_at, end: x.ending_at }));
        for (const b of buckets) {
          const id = `${org}/${api}@${b.start}`;
          if (seen.has(id)) continue;
          seen.set(id, now);
          console.log(`[${org}/${api}] first seen ${new Date(now).toISOString()}: minute ${b.start} appeared ${((now - Date.parse(b.end)) / 60_000).toFixed(1)} min after its bucket end` + (api === "analytics" ? `; data_refreshed_at ${r.body.data_refreshed_at ?? "null"}` : ""));
        }
      }
    }
    await Bun.sleep(Math.max(0, 60_000 - 2500));
  }
  console.log(`watch done, ${seen.size} bucket observation(s)`);
}

// ---------- main ----------

const args = Bun.argv.slice(2);
if (args[0] === "--watch") await watch(Number(args[1] ?? 5), args[2] ? [args[2] as Org] : ORGS);
else for (const org of ORGS) {
  try {
    await probeOrg(org);
  } catch (e) {
    console.log(`[${org}] probe failed: ${redact(String((e as Error).message ?? e))}`);
    process.exitCode = 1;
  }
}
