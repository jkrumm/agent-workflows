import { createHash } from 'node:crypto'
import { CapabilityCallError } from '@agent-workflows/capabilities'
import type { Json, JudgeCaller, Runtime } from '@agent-workflows/runtime'
import { canonicalJson } from './canonical.ts'
import { type CapabilityWorkflows, journaledError } from './capability-runs.ts'
import { type KeyAttempt, withAttemptKeys } from './attempt-keys.ts'

/** What a scorer may judge with: reads and model answers, never a workflow or an effect. */
export const JUDGE_CAPABILITIES = ['web.fetch', 'web.package', 'decide'] as const
export const judgeAllowed = (id: string) =>
  (JUDGE_CAPABILITIES as readonly string[]).includes(id) || id.startsWith('llm.')

type Caller = { call(id: never, input: never, options: never): Promise<unknown> }

/**
 * The scorers' judge (`RuntimeOptions.judge`), limited to {@link JUDGE_CAPABILITIES} and `llm.*`.
 * - Regression and drift score outside any step: each call is a `cap.<id>` run of its own, recorded and priced like any
 *   direct capability call, with purpose `eval` (regression) or `drift`.
 * - An inline gate calls in process; its usage lands on the gate's step, under the scored run's purpose.
 * Each call is keyed by the scored run, the score source, the scorer version, the capability and its input, under the
 * shared attempt rule (`withAttemptKeys`): a retried scoring adopts a finished call, a typed capability failure
 * included (a final answer); an untyped failure or a cancelled call is stepped past and runs again under the next key.
 * Drift keys also carry the pass (its UTC day). An aborted scoring cancels the call it started.
 * A capability's own typed failure (a page that is gone, a package that does not exist) is an answer, not an outage:
 * it comes back as `{ error: { code, message } }`. Anything else throws, and the runtime retries the scoring.
 */
export function scorerJudge(options: {
  registry: Caller
  workflows: CapabilityWorkflows
  runtime: () => Pick<Runtime, 'start' | 'wait' | 'cancel' | 'runByKey'>
  /** The clock a drift pass is keyed by (its UTC day); tests set it. */
  now?: () => Date
}): JudgeCaller {
  const call = options.registry.call.bind(options.registry) as unknown as (
    id: string,
    input: Json,
    scope: object,
  ) => Promise<Json>
  return async (capability, input, scope) => {
    if (!judgeAllowed(capability)) {
      throw new Error(`judge: ${capability} is not a judge capability (${JUDGE_CAPABILITIES.join(', ')}, llm.*)`)
    }
    if (scope.source === 'inline') {
      // The same contract as below: a capability's typed failure is an answer, not an outage.
      try {
        return await call(capability, input, { addUsage: scope.addUsage, signal: scope.signal })
      } catch (error) {
        if (error instanceof CapabilityCallError && error.defined) {
          return { error: { code: error.code, message: error.message } }
        }
        throw error
      }
    }
    const workflow = options.workflows.get(capability)
    if (!workflow) throw new Error(`judge: no capability ${capability} on this host`)
    const runtime = options.runtime()
    const purpose = scope.source === 'regression' ? 'eval' : 'drift'
    const call_ = createHash('sha256')
      .update(`${capability}\0${canonicalJson(input)}`)
      .digest('hex')
      .slice(0, 32)
    // Per scored run, score source, scorer version and call: a retried scoring adopts the calls it finished; a drift
    // re-score under a new scorer fetches fresh, and so does each drift pass (keyed by its UTC day). Regression keys
    // carry no pass: an eval's scoring retry adopts.
    const pass = scope.source === 'drift' ? `:${(options.now?.() ?? new Date()).toISOString().slice(0, 10)}` : ''
    const base = `judge:${scope.source}${pass}:${scope.scorer}:${scope.runId}:${call_}`
    return withAttemptKeys(base, async (key): Promise<KeyAttempt<Json>> => {
      const existing = await runtime.runByKey(workflow.id, key)
      if (existing?.status === 'cancelled') return { failedBefore: true }
      if (existing?.status === 'failed') {
        // A typed capability failure (a page gone, a package not found) is a final answer and is adopted; an untyped
        // or infra failure is stepped past and runs again.
        const typed = journaledError(existing.error?.message ?? '')
        if (!typed?.defined) return { failedBefore: true }
        return { value: { error: { code: typed.code, message: typed.message } } }
      }
      scope.signal.throwIfAborted()
      const { runId } = await runtime.start(workflow, input, { purpose, idempotencyKey: key })
      // The scoring was aborted (cancel, shutdown): the call it started goes with it, also when that came first.
      const onAbort = () => void runtime.cancel(runId).catch(() => {})
      scope.signal.addEventListener('abort', onAbort, { once: true })
      if (scope.signal.aborted) onAbort()
      let end: Awaited<ReturnType<typeof runtime.wait>>
      try {
        end = await runtime.wait(runId, { pollMs: 200, signal: scope.signal })
      } finally {
        scope.signal.removeEventListener('abort', onAbort)
      }
      // Aborted while waiting: the cancel above ended the call; the abort is the answer, not the cancelled run.
      scope.signal.throwIfAborted()
      if (end.status === 'done') return { value: end.output }
      // Typed means one of the capabilities' defined error codes; an internal error is an outage, not an answer.
      const typed = end.status === 'failed' ? journaledError(end.error?.message ?? '') : null
      if (typed?.defined) return { value: { error: { code: typed.code, message: typed.message } } }
      throw new Error(`judge ${capability}: run ${runId} ${end.status}${end.error ? `: ${end.error.message}` : ''}`)
    })
  }
}
