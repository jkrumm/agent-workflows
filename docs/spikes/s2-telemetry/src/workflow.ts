// A fake workflow run with the middleware's telemetry contract: one run span, one child span per step.
import { createHash, randomBytes } from "node:crypto";
import type { Context } from "@opentelemetry/api";
import { withSpan, SpanKind, type Telemetry } from "./telemetry.ts";
import type { RunRecord, StepRecord, Tokens } from "./run-record.ts";

const WORKFLOW_ID = "research.report";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const sum = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  reasoning: a.reasoning + b.reasoning,
});
const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

type StepResult = Partial<Omit<StepRecord, "stepId" | "kind" | "spanId" | "outcome" | "wallMs">>;
type StepEnv = { traceparentEnv: Record<string, string>; headers: Record<string, string> };

export async function runWorkflow(
  tel: Telemetry,
  opts: { parent: Context; input: unknown; transport: "cli" | "http"; stubUrl: string; leafCmd: string[] },
): Promise<RunRecord> {
  const runId = `run_${randomBytes(6).toString("hex")}`;
  const started = Date.now();
  const steps: StepRecord[] = [];
  const attrs = { "agw.workflow.id": WORKFLOW_ID, "agw.run.id": runId, "agw.transport": opts.transport };

  const record = await withSpan(
    tel,
    `agw.run ${WORKFLOW_ID}`,
    attrs,
    async (runSpan) => {
      const step = (stepId: string, kind: StepRecord["kind"], fn: (env: StepEnv) => Promise<StepResult>) =>
        withSpan(
          tel,
          `agw.step ${stepId}`,
          { ...attrs, "agw.step.id": stepId, "agw.step.kind": kind },
          async (span) => {
            const t0 = Date.now();
            const env = tel.childEnv();
            const headers = tel.inject({} as Record<string, string>);
            const r = await fn({ traceparentEnv: env, headers });
            const tokens = r.tokens ?? ZERO;
            const rec: StepRecord = {
              stepId,
              kind,
              spanId: span.spanContext().spanId,
              outcome: "ok",
              wallMs: Date.now() - t0,
              model: r.model ?? null,
              tokens,
              costUsd: r.costUsd ?? null,
              costSource: r.costSource ?? "none",
              toolCalls: r.toolCalls ?? 0,
              sessionId: r.sessionId ?? null,
            };
            span.setAttributes({
              "agw.tokens.input": tokens.input,
              "agw.tokens.output": tokens.output,
              "agw.tokens.cache_read": tokens.cacheRead,
              "agw.tokens.cache_write": tokens.cacheWrite,
              "agw.tokens.reasoning": tokens.reasoning,
              "agw.cost.usd": rec.costUsd ?? 0,
              "agw.tool_calls": rec.toolCalls,
              ...(rec.model ? { "gen_ai.request.model": rec.model } : {}),
              ...(rec.sessionId ? { "opencode.session.id": rec.sessionId } : {}),
            });
            steps.push(rec);
          },
        );

      // 1. code step
      await step("prepare", "code", async () => {
        await sleep(15);
        return {};
      });

      // 2. agent step: fake model usage; the "agent" shells out to a child process (traceparent via env)
      await step("research", "agent", async ({ traceparentEnv }) => {
        const proc = Bun.spawn(opts.leafCmd, {
          env: { ...process.env, ...traceparentEnv },
          stdout: "pipe",
          stderr: "inherit",
        });
        await proc.exited;
        return {
          model: "claude-haiku-5-5",
          tokens: { input: 1200, output: 340, cacheRead: 18000, cacheWrite: 800, reasoning: 80 },
          costUsd: 0.0123,
          costSource: "reported" as const,
          toolCalls: 2,
          sessionId: "ses_fake" + randomBytes(3).toString("hex"),
        };
      });

      // 3. code step with an outbound HTTP call (traceparent header)
      await step("notify", "code", async ({ headers }) => {
        const res = await fetch(`${opts.stubUrl}/v1/ping`, { method: "POST", headers });
        await res.text();
        return {};
      });

      // 4. child workflow step: its own run-shaped sub-span with one agent step inside
      await step("title", "workflow", async () => {
        await withSpan(tel, "agw.run title.generate", { "agw.workflow.id": "title.generate", "agw.run.id": runId + ".1" }, async () => {
          await withSpan(tel, "agw.step name", { "agw.step.id": "name", "agw.step.kind": "agent" }, () => sleep(10));
        });
        return {};
      });

      const tokens = steps.reduce((t, s) => sum(t, s.tokens), ZERO);
      const costUsd = steps.reduce<number | null>((c, s) => (s.costUsd === null ? c : (c ?? 0) + s.costUsd), null);
      const toolCalls = steps.reduce((n, s) => n + s.toolCalls, 0);
      const sc = runSpan.spanContext();
      runSpan.setAttributes({
        "agw.tokens.input": tokens.input,
        "agw.tokens.output": tokens.output,
        "agw.tokens.cache_read": tokens.cacheRead,
        "agw.tokens.reasoning": tokens.reasoning,
        "agw.cost.usd": costUsd ?? 0,
        "agw.steps": steps.length,
        "agw.outcome": "ok",
      });
      const route = "claude-haiku-5-5/medium";
      return {
        runId,
        workflowId: WORKFLOW_ID,
        inputHash: hash(JSON.stringify(opts.input)),
        output: { title: "Fake report", sections: 3 },
        outcome: "ok",
        startedAt: new Date(started).toISOString(),
        wallMs: Date.now() - started,
        steps,
        tokens,
        costUsd,
        toolCalls,
        friction: { repeatToolNudges: 0, reasks: 0, retries: 0, timeouts: 0 },
        scores: { gate: 0.9 },
        traceId: sc.traceId,
        parentTraceparent: null,
        fingerprint: {
          workflowVersion: "0.0.1",
          agents: { research: hash("AGENTS.md+skills").slice(0, 12) },
          route,
          opencodeVersion: "2.0.32",
          hash: hash(["0.0.1", "research", route, "2.0.32"].join("|")).slice(0, 16),
        },
        caller: { project: "agent-workflows", machine: process.env.AGW_MACHINE ?? "dev-host" },
      } satisfies RunRecord;
    },
    { parent: opts.parent, kind: SpanKind.SERVER },
  );
  return record;
}
