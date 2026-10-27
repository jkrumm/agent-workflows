// Flush-on-exit matrix on Bun: which exit paths deliver a span when the batch timer (30 s) cannot.
const run = Date.now().toString(36);
const cases: { mode: string; signal?: NodeJS.Signals }[] = [
  { mode: "nohandler-exit" },
  { mode: "nohandler-natural" },
  { mode: "handler-natural" },
  { mode: "shutdown-then-exit" },
  { mode: "nohandler-sigterm", signal: "SIGTERM" },
  { mode: "handler-sigterm", signal: "SIGTERM" },
  { mode: "handler-sigint", signal: "SIGINT" },
];
const exits: Record<string, string> = {};
for (const c of cases) {
  const proc = Bun.spawn(["bun", `${import.meta.dir}/flush-child.ts`, c.mode], {
    env: { ...process.env, PROBE_RUN: run },
    stdout: "pipe",
    stderr: "inherit",
  });
  if (c.signal) {
    await proc.stdout.getReader().read(); // READY
    proc.kill(c.signal);
  }
  const t0 = Date.now();
  const timeout = setTimeout(() => proc.kill("SIGKILL"), 15_000);
  const code = await proc.exited;
  clearTimeout(timeout);
  exits[c.mode] = `exit=${code} sig=${proc.signalCode ?? "-"} ${Date.now() - t0}ms`;
}
await Bun.sleep(8000);
const res = await fetch("http://127.0.0.1:8123/", {
  method: "POST",
  body: `SELECT ResourceAttributes['probe.case'] AS c, count() AS n FROM default.otel_traces WHERE ResourceAttributes['probe.run']='${run}' GROUP BY c FORMAT JSONEachRow`,
});
const got = new Map((await res.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.c, Number(r.n)]));
console.table(cases.map((c) => ({ case: c.mode, delivered: got.get(c.mode) ? "yes" : "NO", process: exits[c.mode] })));
