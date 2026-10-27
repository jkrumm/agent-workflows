import { defineHook, FatalError, getStepMetadata, getWorkflowMetadata } from "workflow";
import { start } from "workflow/api";
import { openSession, runSession } from "../../../common/agent-driver.ts";
import { body, probe } from "../../../common/world.ts";

// Middleware without forking: step/pre and step/post wrap each step body in host code.
async function mw<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  await probe(runId, "mw", "step/pre");
  const out = await fn();
  await probe(runId, "mw", "step/post");
  return out;
}

async function runPre(runId: string) {
  "use step";
  await probe(runId, "mw", "run/pre"); // the workflow body is a sandbox without I/O, so run/pre is a step
}

async function prepare(runId: string) {
  "use step";
  return mw(runId, () => body.prepare(runId));
}

async function agentOpen(runId: string) {
  "use step";
  return mw(runId, () => openSession(runId));
}

async function agentRun(runId: string, sessionId: string) {
  "use step";
  return mw(runId, () => runSession(runId, sessionId));
}

async function audit(runId: string) {
  "use step";
  return mw(runId, () => body.audit(runId));
}

async function effect(runId: string) {
  "use step";
  const { stepId } = getStepMetadata();
  return mw(runId, () => body.effect(runId, stepId));
}

async function childWork(runId: string, i: number) {
  "use step";
  return mw(runId, async () => {
    try {
      return await body.child(runId, i);
    } catch (err) {
      throw new FatalError(String(err)); // no step retry: the child fails, like the other candidates
    }
  });
}

async function finish(runId: string, children: unknown[], prepared: { n: number }, codeVersion: string) {
  "use step";
  return mw(runId, () => body.finish(runId, children, prepared, codeVersion));
}

// Child fan-out, the documented way: the child resumes a hook in the parent when it ends.
type Completion = { status: "completed"; value: unknown } | { status: "failed"; error: string };
const childDone = defineHook<Completion>();

async function resumeParent(token: string, result: Completion) {
  "use step";
  await childDone.resume(token, result);
}

export async function s1Child(runId: string, i: number, token: string) {
  "use workflow";
  let result: Completion;
  try {
    result = { status: "completed", value: await childWork(runId, i) };
  } catch (err) {
    result = { status: "failed", error: String(err) };
  }
  await resumeParent(token, result);
}

async function startAndWait(runId: string, i: number) {
  const token = `${getWorkflowMetadata().workflowRunId}:child:${i}`;
  const hook = childDone.create({ token });
  await start(s1Child, [runId, i, token]);
  const done = await hook;
  return done.status === "completed" ? done.value : null; // failure split
}

export async function s1(runId: string) {
  "use workflow";
  await runPre(runId);
  const prepared = await prepare(runId);
  const sessionId = await agentOpen(runId);
  const answer = await agentRun(runId, sessionId);
  // @break await audit(runId);
  await effect(runId);
  const children = await Promise.all([0, 1, 2].map((i) => startAndWait(runId, i)));
  const result = await finish(runId, children, prepared, "v1" /* @version */);
  return { ...result, answer };
}
