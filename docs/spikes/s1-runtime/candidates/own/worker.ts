import { openSession, runSession } from "../../common/agent-driver.ts";
import { body, PG_URL, probe, VERSION } from "../../common/world.ts";
import { defineWorkflow, Runtime } from "./runtime.ts";

const child = defineWorkflow({
  id: "s1.child",
  run: (ctx, { i }: { i: number }) => ctx.step("work", () => body.child(ctx.runId.split("/")[0]!, i)),
});

const s1 = defineWorkflow({
  id: "s1",
  async run(ctx, _input: {}) {
    const prepared = await ctx.step("prepare", () => body.prepare(ctx.runId));
    const answer = await ctx.agent("agent");
    // @break await ctx.step("audit", () => body.audit(ctx.runId));
    await ctx.effect("effect", (key) => body.effect(ctx.runId, key));
    const children = await ctx.children("fanout", child, [{ i: 0 }, { i: 1 }, { i: 2 }]);
    return ctx.step("finish", () => body.finish(ctx.runId, children, prepared, "v1" /* @version */)).then((r) => ({ ...r, answer }));
  },
});

// Middleware proof: all four interception points, recorded as probes.
const runtime = new Runtime(
  PG_URL,
  VERSION,
  { open: (runId) => openSession(runId), run: runSession },
  [
    {
      runPre: (r) => probe(r.id.split("/")[0]!, "mw", "run/pre"),
      stepPre: (s) => probe(s.runId.split("/")[0]!, "mw", "step/pre"),
      stepPost: (s) => probe(s.runId.split("/")[0]!, "mw", "step/post"),
      runPost: (r) => probe(r.id.split("/")[0]!, "mw", "run/post"),
    },
  ],
);
runtime.register(s1, child);

await runtime.migrate();
if (process.env.START === "1") await runtime.start(s1, process.env.RUN_ID!, {});
process.on("SIGTERM", async () => {
  await runtime.close().catch(() => {});
  process.exit(0);
});
await runtime.recover();
setInterval(() => void runtime.recover(), 1000);
