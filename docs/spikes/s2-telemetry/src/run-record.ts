// Run record (concept §5) and its projection into Argo's usage_record (N6: the platform posts directly,
// like email-gateway; usage-tracker is not in the path). Argo's input schema is copied verbatim from
// argo/apps/api/src/routes/usage.ts (UsageRecordInputSchema) so mapping is validated locally, never against prod.
import { z } from "zod";

export const Tokens = z.object({
  input: z.number().int().nonnegative(), // fresh uncached input only (Argo additive contract)
  output: z.number().int().nonnegative(), // excludes reasoning
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
});
export type Tokens = z.infer<typeof Tokens>;

export const StepRecord = z.object({
  stepId: z.string(),
  kind: z.enum(["code", "agent", "workflow"]),
  spanId: z.string(),
  outcome: z.enum(["ok", "error"]),
  wallMs: z.number().int().nonnegative(),
  model: z.string().nullable(), // agent steps only; the route resolved to a model id
  tokens: Tokens,
  costUsd: z.number().nullable(),
  costSource: z.enum(["reported", "computed", "none"]),
  toolCalls: z.number().int().nonnegative(),
  sessionId: z.string().nullable(), // OpenCode session id, the durable handle of an agent step
});
export type StepRecord = z.infer<typeof StepRecord>;

export const RunRecord = z.object({
  runId: z.string(),
  workflowId: z.string(),
  inputHash: z.string(),
  output: z.unknown(),
  outcome: z.enum(["ok", "error", "invalid_output"]),
  startedAt: z.string(),
  wallMs: z.number().int().nonnegative(),
  steps: z.array(StepRecord),
  tokens: Tokens, // sum over steps
  costUsd: z.number().nullable(),
  toolCalls: z.number().int().nonnegative(),
  friction: z.object({
    repeatToolNudges: z.number().int().nonnegative(),
    reasks: z.number().int().nonnegative(),
    retries: z.number().int().nonnegative(),
    timeouts: z.number().int().nonnegative(),
  }),
  scores: z.record(z.string(), z.number()),
  traceId: z.string().length(32),
  parentTraceparent: z.string().nullable(),
  fingerprint: z.object({
    workflowVersion: z.string(),
    agents: z.record(z.string(), z.string()), // agent id -> hash of AGENTS.md + skills
    route: z.string(), // model + effort
    opencodeVersion: z.string(),
    hash: z.string(),
  }),
  caller: z.object({ project: z.string(), machine: z.string() }),
});
export type RunRecord = z.infer<typeof RunRecord>;

// ---- Argo (verbatim copy of UsageRecordInputSchema, zod 4) ----
export const ArgoUsageRecordInput = z.object({
  source: z.string(),
  source_id: z.string(),
  grain: z.string(),
  ts: z.string().describe("ISO 8601 timestamp"),
  model: z.string().nullable(),
  model_norm: z.string().nullable(),
  project: z.string().nullable(),
  workspace: z.string().nullable().optional(),
  sub_tool: z.string().nullable(),
  machine: z.string().nullable(),
  billing: z.string(),
  account: z.string().nullable().optional(),
  outcome: z.string().default("ok"),
  input_tokens: z.number().int().default(0),
  output_tokens: z.number().int().default(0),
  cache_read_tokens: z.number().int().default(0),
  cache_write_tokens: z.number().int().default(0),
  reasoning_tokens: z.number().int().default(0),
  duration_ms: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  cost_source: z.string().default("none"),
  raw: z.unknown().nullable(),
  ingested_at: z.string().describe("Source-local ingest time, ISO 8601"),
});
export const ArgoBody = z.object({ records: z.array(ArgoUsageRecordInput).min(1).max(1000) });

/**
 * One Argo row per agent step that spent tokens. Run-level facts (fingerprint, scores, friction, trace id)
 * ride in `raw` because Argo has no column for them; the full run record stays in the platform's Postgres.
 * Upsert key is (source, source_id, machine): source_id = `<runId>:<stepId>` makes a replay a no-op.
 */
export function toArgoRows(run: RunRecord, now = new Date()) {
  const ts = (d: string) => new Date(d).toISOString();
  return run.steps
    .filter((s) => s.kind === "agent")
    .map((s) => ({
      source: "agent-workflows",
      source_id: `${run.runId}:${s.stepId}`,
      grain: "step",
      ts: ts(run.startedAt),
      ingested_at: now.toISOString(),
      model: s.model,
      model_norm: s.model, // Argo/usage-tracker normalise via models.ts; the route table already holds canonical ids
      project: run.caller.project,
      workspace: "private",
      sub_tool: run.workflowId,
      machine: run.caller.machine,
      billing: "iu",
      account: null,
      outcome: s.outcome,
      input_tokens: s.tokens.input,
      output_tokens: s.tokens.output,
      cache_read_tokens: s.tokens.cacheRead,
      cache_write_tokens: s.tokens.cacheWrite,
      reasoning_tokens: s.tokens.reasoning,
      duration_ms: s.wallMs,
      cost_usd: s.costUsd,
      cost_source: s.costSource,
      raw: {
        runId: run.runId,
        stepId: s.stepId,
        traceId: run.traceId,
        spanId: s.spanId,
        fingerprint: run.fingerprint.hash,
        sessionId: s.sessionId,
        toolCalls: s.toolCalls,
        runOutcome: run.outcome,
        runWallMs: run.wallMs,
        scores: run.scores,
        friction: run.friction,
      },
    }));
}
