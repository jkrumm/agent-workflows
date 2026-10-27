import { DBOS } from "@dbos-inc/dbos-sdk";
import { openSession, runSession } from "../../common/agent-driver.ts";
import { body, PG_URL, probe } from "../../common/world.ts";

// Middleware without forking: a wrapper around DBOS.runStep. Pre/post fire only when the step
// really executes, not when DBOS returns a checkpointed result.
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const runId = DBOS.workflowID!.split("/")[0]!;
  return DBOS.runStep(
    async () => {
      await probe(runId, "mw", "step/pre");
      const out = await fn();
      await probe(runId, "mw", "step/post");
      return out;
    },
    { name },
  );
}

const child = DBOS.registerWorkflow(
  async (i: number) => step("work", () => body.child(DBOS.workflowID!.split("/")[0]!, i)),
  { name: "s1.child" },
);

const s1 = DBOS.registerWorkflow(
  async () => {
    const runId = DBOS.workflowID!;
    await probe(runId, "mw", "run/pre"); // workflow-body code: runs again on every recovery
    const prepared = await step("prepare", () => body.prepare(runId));
    const sessionId = await step("agent.open", () => openSession(runId));
    const answer = await step("agent", () => runSession(runId, sessionId));
    // @break await step("audit", () => body.audit(runId));
    await step("effect", () => body.effect(runId, `${runId}:effect`));
    const handles = await Promise.all(
      [0, 1, 2].map((i) => DBOS.startWorkflow(child, { workflowID: `${runId}/fanout/${i}` })(i)),
    );
    const children = await Promise.all(handles.map((h) => h.getResult().catch(() => null))); // failure split
    const result = await step("finish", () => body.finish(runId, children, prepared, "v1" /* @version */));
    await probe(runId, "mw", "run/post");
    return { ...result, answer };
  },
  { name: "s1" },
);

DBOS.setConfig({
  name: "spike-s1",
  systemDatabaseUrl: PG_URL,
  systemDatabaseSchemaName: "dbos",
  runAdminServer: false,
  logLevel: "warn",
});
process.on("SIGTERM", async () => {
  await DBOS.shutdown().catch(() => {});
  process.exit(0);
});
await DBOS.launch();
if (process.env.START === "1") await DBOS.startWorkflow(s1, { workflowID: process.env.RUN_ID! })();
