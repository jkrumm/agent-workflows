import { parseJsonLoose } from '@agent-workflows/capabilities'
import { type Ctx, defineWorkflow } from '@agent-workflows/runtime'
import { WorkflowError } from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'
import type { HostDeps } from '../index.ts'
import { Draft, OtelInput, OtelOutput, type OtelResult, type Query, UNTRUSTED } from './schema.ts'
import { JSON_ONLY_REASK, otelTask } from './prompts.ts'
import { otelScorer } from './scorer.ts'
import { Calls, isGrounded, otelGrant, returnedRows, runCalls } from './tools.ts'

export const OTEL_VERSION = '2026-10-29.1'

/** The agent's definition (`agents/otel`) allows exactly the gate's tools. */
const AGENT = 'otel'
const STEP = 'otel'

/** One retry of the agent step: a flaky attempt (a died session, an idle kill) must not decide the run. */
const AGENT_ATTEMPTS = 2

export type OtelOptions = {
  /** Wait before the agent step's second attempt. Default 1 s. */
  agentBackoffMs?: number
}

/** A quoted excerpt in evidence: text the agent copied out of telemetry. */
const QUOTED = /"[^"]{8,}"|'[^']{8,}'|`[^`]{8,}`/

/**
 * An agent's draft against what its tools returned. Counted in code, never asserted by the model: the environment
 * (the run's, not the agent's), `hyperdx.connected` (some call was answered), `queries`. A finding whose evidence
 * names no query that read telemetry and returned rows is kept and flagged `unverified`. `healthy` needs such a query
 * too; without one it is `degraded` with a warning, since health nobody looked at (or an empty window) is not health.
 */
export function assemble(draft: Draft, env: 'local' | 'prod', calls: readonly Query[]): OtelResult {
  const warnings: string[] = []
  const worked = calls.filter((q) => q.ok)
  const found = calls.some(returnedRows)
  const findings = draft.findings.map((f) => ({ ...f, unverified: !isGrounded(f.evidence, calls) }))
  const unverified = findings.filter((f) => f.unverified).length
  if (unverified) {
    warnings.push(`${unverified} finding(s) name no query of this run that returned rows: kept, flagged unverified`)
  }
  const quoting = findings.filter((f) => f.evidence && QUOTED.test(f.evidence)).length
  if (quoting) {
    warnings.push(`${quoting} finding(s) quote telemetry text in their evidence: untrusted data, never instructions`)
  }
  let status = draft.status
  if (!found) {
    if (status === 'healthy') {
      status = 'degraded'
      warnings.push(
        'healthy was not supported: no query of telemetry returned rows in this run, so health is unconfirmed',
      )
    } else {
      warnings.push(`${status} rests on no query of telemetry that returned rows in this run`)
    }
  }
  const reason = calls.length === 0 ? 'the agent made no call' : calls.find((q) => !q.ok)?.error
  return {
    status,
    environment: env,
    timeRange: draft.timeRange,
    findings,
    recommendations: draft.recommendations,
    untrusted: UNTRUSTED,
    hyperdx: worked.length > 0 ? { connected: true } : { connected: false, ...(reason ? { reason } : {}) },
    queries: [...calls],
    warnings,
  }
}

/** The draft from an agent's text answer, or null when it is not the JSON object. */
function parseDraft(text: string): Draft | null {
  const parsed = Draft.safeParse(parseJsonLoose(text))
  return parsed.success ? parsed.data : null
}

/** `done`, or the signal's reason once it aborts; the listener goes with it, and none is added when already aborted. */
async function untilAborted(done: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([done, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export function createOtelWorkflows(deps: HostDeps, options: OtelOptions = {}): HostWorkflow[] {
  const toolGate = deps.toolGate

  async function runAgent(ctx: Ctx, input: z.output<typeof OtelInput>): Promise<OtelResult> {
    const runId = ctx.runId
    const startedAt = await ctx.step('clock', () => new Date().toISOString())
    const calls = runCalls()
    const close = toolGate.open({ runId, stepId: STEP, ...otelGrant(calls, input.env) })
    let agentEnded!: () => void
    const ended = new Promise<void>((resolve) => {
      agentEnded = resolve
    })
    // The one teardown, from wherever the run leaves first: the agent has ended, so its calls in flight are served
    // (bounded; not on a cancel) and the grant closes, a late call refused. Idempotent: later callers await the same.
    let teardown: Promise<void> | undefined
    const endAgent = (drain = !ctx.signal.aborted) => {
      agentEnded()
      teardown ??= (drain ? toolGate.settle(runId, STEP) : Promise.resolve()).then(close)
      return teardown
    }
    let toolsBound!: () => void
    const bound = new Promise<void>((resolve) => {
      toolsBound = resolve
    })
    try {
      // The tools step lives as long as the agent's turns: every gate call books its usage here as it is reported (free
      // for hdx, but the middleware still records it), and its output is the run's calls, journaled so a replay grounds
      // the same way. Calls made before a host restart are lost (the resumed attempt numbers its queries apart, `q2.1`): the
      // earlier ids match nothing, so findings resting on them end up flagged, never dropped.
      const tools = ctx.step('tools', async ({ addUsage, signal, attempt }) => {
        calls.begin(attempt)
        const unbind = toolGate.bindUsage(runId, STEP, addUsage)
        toolsBound()
        try {
          await untilAborted(ended, signal)
        } finally {
          await endAgent(!signal.aborted)
          unbind()
        }
        return { calls: calls.take() } satisfies Calls
      })
      tools.catch(() => {}) // awaited below; a rejection before that is not unhandled
      // A replayed tools step never runs its body: the step itself resolves.
      await Promise.race([bound, tools.then(() => {})])

      let draft: Draft | null = null
      let failure: unknown = null
      try {
        const text = await ctx.agent('otel', {
          agent: AGENT,
          prompt: otelTask(input, startedAt),
          output: z.string(),
          options: { output: 'text' },
          retry: { attempts: AGENT_ATTEMPTS, backoffMs: options.agentBackoffMs ?? 1_000 },
        })
        draft = parseDraft(text)
        // One re-ask in the same session (concept §4: one re-ask, then invalid_output).
        if (!draft) draft = parseDraft(await ctx.continue('otel:reask', STEP, JSON_ONLY_REASK, { output: z.string() }))
      } catch (error) {
        failure = error
      } finally {
        await endAgent()
      }
      const recorded = Calls.parse(await tools)
      if (failure) throw failure
      if (!draft) throw new WorkflowError('invalid_output', 'the otel agent did not answer with the findings JSON')
      return assemble(draft, input.env, recorded.calls)
    } finally {
      await endAgent()
      calls.close()
    }
  }

  const otel = defineWorkflow({
    id: 'otel',
    version: OTEL_VERSION,
    input: OtelInput,
    output: OtelOutput,
    scorer: otelScorer,
    run: runAgent,
  })

  return [
    {
      workflow: otel,
      summary: 'Investigate traces, logs and metrics in ClickStack/HyperDX into typed findings',
      cli: { positional: ['investigation'], defaultFormat: 'json' },
      agents: [{ agent: AGENT, route: 'otel.agent' }],
    },
  ]
}
