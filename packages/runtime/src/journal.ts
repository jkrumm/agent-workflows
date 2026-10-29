import type { Pool, QueryResult, QueryResultRow } from 'pg'
import { type ErrorKind, errorMessage, InfraError, LeaseLost, WorkflowError } from './errors.ts'
import type { Json } from './json.ts'
import { lockKey } from './lease.ts'
import type {
  FinalScore,
  KeyedRun,
  RunStatus,
  ScoredRun,
  ScoredRunFilter,
  StepKind,
  StepStatus,
  StepUsage,
  Verdict,
} from './types.ts'

/** Every journal write of a run tree carries its root's lease token; a stale holder's write matches nothing. */
export type Fence = { rootId: string; token: string }

export type RunRow = {
  id: string
  workflow: string
  parent_id: string | null
  root_id: string
  status: RunStatus
  purpose: string
  input: Json
  output: Json | null
  error: string | null
  error_kind: ErrorKind | null
  traceparent: string | null
  version_started: string
  started_at: Date | null
  finished_at: Date | null
  version_finished: string | null
  cancel_requested_at: Date | null
  admitted_at: Date | null
  post_hooks_at: Date | null
  /** Set when the post hooks were given up on rather than delivered; the run record may then be missing. */
  post_hooks_failed_at: Date | null
  /** The run record's sums, written by `runPost`: `numeric` arrives as a string; null until then or when nothing was priced. */
  cost: string | null
  unpriced_calls: number | null
  /** Who admitted the run (a door token's name, or a self-declared sub-caller of the API secret); null: the host itself. */
  caller: string | null
  /** The repo the caller works in, as a bare name; null when none was declared. */
  project: string | null
  /** `work` or `private`, declared by the caller; null lets Argo classify from the project. */
  workspace: string | null
}

const RUN_COLUMNS = `id, workflow, parent_id, root_id, status, purpose, input, output, error, error_kind, traceparent,
  version_started, version_finished, started_at, finished_at, cancel_requested_at, admitted_at, post_hooks_at,
  post_hooks_failed_at, cost, unpriced_calls, caller, project, workspace`

export type CancelledStep = { run_id: string; step_id: string; kind: StepKind; handle: AgentHandleState | null }

export type AgentHandleState = { handle: Json; prompted: boolean }

export type StepRow = {
  step_id: string
  kind: StepKind
  status: StepStatus
  handle: AgentHandleState | null
  output: Json | null
  error: string | null
  error_kind: ErrorKind | null
  attempts: number
  /** Milliseconds since the latest execution started, by the database clock. */
  attempt_age_ms: number
}

export type NewRun = {
  id: string
  workflow: string
  parentId: string | null
  rootId: string
  purpose: string
  input: Json
  inputHash: string
  idempotencyKey: string | null
  traceparent: string | null
  traceId: string | null
  version: string
  status?: 'pending' | 'failed'
  error?: { kind: ErrorKind; message: string }
  /** The caller chose `id` (`StartOptions.runId`): a conflict on it is refused, never answered with the existing run. */
  chosenId?: boolean
  /** Who started the run; a child inherits its parent's. Absent: null. */
  caller?: string | null
  project?: string | null
  workspace?: string | null
}

export type RunEnd = {
  status: 'done' | 'failed' | 'cancelled'
  output: Json | null
  error: { kind: ErrorKind; message: string } | null
  version: string
}

export type StepEnd = {
  status: 'done' | 'failed' | 'cancelled'
  output: Json | null
  error: { kind: ErrorKind; message: string } | null
  usage: StepUsage
  model: string | null
}

/** What scoring a finished run reads. */
export type ScoreTarget = {
  id: string
  workflow: string
  status: RunStatus
  input: Json
  output: Json | null
  scored_at: Date | null
  score_error: string | null
  score_error_kind: 'scorer' | 'infra' | null
  /** The scorer version of `scores.final`, when there is one. */
  scorer: string | null
}

type ScoredRow = {
  id: string
  workflow: string
  fingerprint: string | null
  final: FinalScore
  cost: string | null
  unpriced_calls: number | null
  wall_ms: number | null
  tokens: string | null
  tool_calls: number | null
  finished_at: Date | null
}

/** Top-level runs holding a concurrency slot. One definition for the count and the per-workflow split. */
const RUNNING_TOP = `parent_id is null and status = 'running'`

/** Advisory keys currently held in this database, as the 64-bit key `pg_try_advisory_lock(bigint)` took. */
const HELD_KEYS = `select (l.classid::int8 << 32) | l.objid::int8 as k from pg_locks l
  where l.locktype = 'advisory' and l.objsubid = 1 and l.granted
    and l.database = (select oid from pg_database where datname = current_database())`

/**
 * All SQL of the runtime. Every query error becomes an `InfraError`, so the caller can tell a broken journal
 * from a failing step body.
 *
 * Not fenced, on purpose: `postHooksDone` and `steerDelivered` (idempotent delivery markers; a stale writer can
 * only cause one more at-least-once delivery), `cancel` and `addSteer` (requests from any process, applied by the
 * lease holder) and `takeLease` (called with the advisory lock held; it is what moves the fence).
 */
export class Journal {
  private readonly runs: string
  private readonly steps: string
  private readonly signals: string

  constructor(
    readonly pool: Pool,
    readonly schema: string,
  ) {
    this.runs = `"${schema}".runs`
    this.steps = `"${schema}".steps`
    this.signals = `"${schema}".signals`
  }

  /** The advisory lock key of a top-level run (children share their root's). */
  lockKey(rootId: string): string {
    return lockKey(`${this.schema}:${rootId}`)
  }

  async query<R extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
    try {
      return await this.pool.query<R>(sql, params)
    } catch (err) {
      throw new InfraError(`journal: ${errorMessage(err)}`, { cause: err })
    }
  }

  /**
   * Inserts the run unless its id or (workflow, idempotency key) exists; returns the id that holds. A child is
   * inserted under its root's fence.
   */
  async insertRun(run: NewRun, fence: Fence | null = null): Promise<string> {
    const guard = fence ? `where ${this.fence(19, 20)}` : ''
    const { rows } = await this.query<{ id: string }>(
      `insert into ${this.runs} (id, workflow, parent_id, root_id, purpose, input, input_hash, idempotency_key,
         traceparent, trace_id, version_started, status, error, error_kind, finished_at, lock_key, caller, project,
         workspace)
       select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         case when $12 = 'failed' then now() end, $15::bigint, $16, $17, $18 ${guard}
       ${run.chosenId ? 'on conflict (id) do nothing' : 'on conflict do nothing'} returning id`,
      [
        run.id,
        run.workflow,
        run.parentId,
        run.rootId,
        run.purpose,
        JSON.stringify(run.input),
        run.inputHash,
        run.idempotencyKey,
        run.traceparent,
        run.traceId,
        run.version,
        run.status ?? 'pending',
        run.error?.message ?? null,
        run.error?.kind ?? null,
        this.lockKey(run.rootId),
        run.caller ?? null,
        run.project ?? null,
        run.workspace ?? null,
        ...(fence ? [fence.rootId, fence.token] : []),
      ],
    )
    if (rows[0]) return rows[0].id
    // Enforced by the insert itself, aimed at the primary key alone: two starts with one chosen id never both pass,
    // and a conflict on any other unique key is that key's own error, never read as this one.
    if (run.chosenId) throw new WorkflowError('invalid_input', `run id ${run.id} is already used`)
    if (fence) await this.assertLease(fence)
    const existing = await this.query<{ id: string }>(
      `select id from ${this.runs} where id = $1 or (workflow = $2 and idempotency_key = $3)`,
      [run.id, run.workflow, run.idempotencyKey],
    )
    const id = existing.rows[0]?.id
    if (!id) throw new InfraError(`journal: run ${run.id} neither inserted nor found`)
    return id
  }

  async inputHashOf(id: string): Promise<string | null> {
    const { rows } = await this.query<{ input_hash: string }>(`select input_hash from ${this.runs} where id = $1`, [id])
    return rows[0]?.input_hash ?? null
  }

  async getRun(id: string): Promise<RunRow | null> {
    const { rows } = await this.query<RunRow>(`select ${RUN_COLUMNS} from ${this.runs} where id = $1`, [id])
    return rows[0] ?? null
  }

  /**
   * Called with the advisory lock held: from here on, only writes carrying this token land. Claiming a running
   * run counts one drive (the persisted poison-run cap); returns the count.
   */
  async takeLease(id: string, token: string): Promise<number> {
    const { rows } = await this.query<{ drives: number }>(
      `update ${this.runs} set lease_token = $2, drives = drives + (status = 'running')::int, updated_at = now()
       where id = $1 returning drives`,
      [id, token],
    )
    return rows[0]?.drives ?? 0
  }

  /**
   * pending → running, counting one drive. For a top-level run with a concurrency limit, the count and the update
   * happen under a per-workflow transaction lock, so two processes cannot both take the last slot. Returns the
   * run's `started_at`, or null: stay pending.
   */
  async markRunning(id: string, fence: Fence, limit: { workflow: string; max: number } | null): Promise<Date | null> {
    const client = await this.connect()
    let startedAt: Date | null = null
    try {
      await client.query('begin')
      if (limit) {
        await client.query('select pg_advisory_xact_lock($1::bigint)', [
          lockKey(`agw-concurrency:${this.schema}:${limit.workflow}`),
        ])
        const { rows } = await client.query<{ n: number }>(
          `select count(*)::int as n from ${this.runs} where ${RUNNING_TOP} and workflow = $1`,
          [limit.workflow],
        )
        if ((rows[0]?.n ?? 0) >= limit.max) {
          await client.query('rollback')
          return null
        }
      }
      const res = await client.query<{ started_at: Date }>(
        `update ${this.runs} set status = 'running', started_at = coalesce(started_at, now()), drives = drives + 1,
           updated_at = now()
         where id = $1 and status = 'pending' and ${this.fence(2, 3)}
         returning started_at`,
        [id, fence.rootId, fence.token],
      )
      await client.query('commit')
      startedAt = res.rows[0]?.started_at ?? null
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw new InfraError(`journal: ${errorMessage(err)}`, { cause: err })
    } finally {
      client.release()
    }
    if (startedAt) return startedAt
    // After the release: a second checkout while holding one could exhaust the pool.
    await this.assertLease(fence)
    return null
  }

  /** runPre accepted the run: from now on a resume skips admission. */
  async markAdmitted(id: string, fence: Fence) {
    await this.fenced(
      fence,
      `update ${this.runs} set admitted_at = now(), updated_at = now()
       where id = $1 and status = 'running' and ${this.fence(2, 3)}`,
      [id, fence.rootId, fence.token],
    )
  }

  async postHooksDone(id: string) {
    await this.query(`update ${this.runs} set post_hooks_at = now() where id = $1`, [id])
  }

  /** Counts a failed runPost delivery; at `max` it marks the run delivered anyway. Returns the attempt count. */
  async postHooksFailed(id: string, max: number): Promise<{ attempts: number; gaveUp: boolean }> {
    const { rows } = await this.query<{ attempts: number; gave_up: boolean }>(
      `update ${this.runs} set post_hooks_attempts = post_hooks_attempts + 1,
         post_hooks_at = case when post_hooks_attempts + 1 >= $2 then now() end,
         post_hooks_failed_at = case when post_hooks_attempts + 1 >= $2 then now() end
       where id = $1 and post_hooks_at is null
       returning post_hooks_attempts as attempts, post_hooks_at is not null as gave_up`,
      [id, max],
    )
    return { attempts: rows[0]?.attempts ?? 0, gaveUp: rows[0]?.gave_up ?? false }
  }

  /** Ended runs (of trees rooted in `workflows`) whose runPost was never confirmed and whose root nobody holds. */
  async postHooksPending(workflows: string[], limit: number): Promise<RunRow[]> {
    const { rows } = await this.query<RunRow>(
      `with held as (${HELD_KEYS})
       select ${RUN_COLUMNS} from ${this.runs} where id in (
         select c.id from ${this.runs} c join ${this.runs} r on r.id = c.root_id
         where c.post_hooks_at is null and c.status in ('done', 'failed', 'cancelled') and r.workflow = any($1)
           and not exists (select 1 from held where held.k = r.lock_key)
         order by c.finished_at limit $2)`,
      [workflows, limit],
    )
    return rows
  }

  /** Terminal write (a refused run ends straight from pending). False when another writer ended it first. */
  async finishRun(id: string, fence: Fence, end: RunEnd): Promise<boolean> {
    return this.fenced(
      fence,
      `update ${this.runs} set status = $4, output = $5, error = $6, error_kind = $7, version_finished = $8,
         finished_at = now(), updated_at = now()
       where id = $1 and status in ('pending', 'running') and ${this.fence(2, 3)}`,
      [
        id,
        fence.rootId,
        fence.token,
        end.status,
        end.output === null ? null : JSON.stringify(end.output),
        end.error?.message ?? null,
        end.error?.kind ?? null,
        end.version,
      ],
    )
  }

  async getStep(runId: string, stepId: string): Promise<StepRow | null> {
    const { rows } = await this.query<StepRow>(
      `select step_id, kind, status, handle, output, error, error_kind, attempts,
         (extract(epoch from now() - attempt_started_at) * 1000)::float8 as attempt_age_ms
       from ${this.steps} where run_id = $1 and step_id = $2`,
      [runId, stepId],
    )
    return rows[0] ?? null
  }

  /** Inserts the step as running, or flips a resumed/retried row back to running with one more attempt. */
  async stepRunning(runId: string, stepId: string, kind: StepKind, fence: Fence) {
    await this.fenced(
      fence,
      `insert into ${this.steps} (run_id, step_id, kind, status, attempts)
       select $1, $2, $5, 'running', 1 where ${this.fence(3, 4)}
       on conflict (run_id, step_id) do update
         set status = 'running', attempts = ${this.steps}.attempts + 1, error = null, error_kind = null,
           finished_at = null, attempt_started_at = now()`,
      [runId, stepId, fence.rootId, fence.token, kind],
    )
  }

  async stepHandle(runId: string, stepId: string, fence: Fence, state: AgentHandleState | null) {
    await this.fenced(
      fence,
      `update ${this.steps} set handle = $5 where run_id = $1 and step_id = $2 and ${this.fence(3, 4)}`,
      [runId, stepId, fence.rootId, fence.token, state === null ? null : JSON.stringify(state)],
    )
  }

  /** First terminal writer wins: false when a cancel cleanup ended the step first. */
  async finishStep(runId: string, stepId: string, fence: Fence, end: StepEnd): Promise<boolean> {
    const { usage } = end
    return this.fenced(
      fence,
      `update ${this.steps} set status = $5, output = $6, error = $7, error_kind = $8, model = $9,
         tokens_input = $10, tokens_output = $11, tokens_cache_read = $12, tokens_reasoning = $13,
         cost = $14, tool_calls = $15, usage_by_model = $16, unpriced_calls = $17, tokens_cache_write = $18,
         finished_at = now()
       where run_id = $1 and step_id = $2 and status = 'running' and ${this.fence(3, 4)}`,
      [
        runId,
        stepId,
        fence.rootId,
        fence.token,
        end.status,
        end.output === null ? null : JSON.stringify(end.output),
        end.error?.message ?? null,
        end.error?.kind ?? null,
        end.model,
        usage.tokens.input,
        usage.tokens.output,
        usage.tokens.cacheRead,
        usage.tokens.reasoning,
        usage.cost,
        usage.toolCalls,
        Object.keys(usage.byModel).length ? JSON.stringify(usage.byModel) : null,
        usage.unpricedCalls,
        usage.tokens.cacheWrite,
      ],
    )
  }

  /**
   * Top-level runs this process may drive, oldest first: pending runs of workflows below their concurrency limit,
   * then running ones. Runs whose lease is visibly held (pg_locks) and the caller's `exclude` list are filtered in
   * SQL, so every page holds only claimable runs and orphans beyond the first page are reached.
   */
  async claimable(workflows: string[], saturated: string[], exclude: string[], limit: number): Promise<string[]> {
    const { rows } = await this.query<{ id: string }>(
      `with held as (${HELD_KEYS})
       (select id from ${this.runs} r
        where parent_id is null and status = 'pending' and workflow = any($1) and not (workflow = any($2))
          and not (id = any($3)) and not exists (select 1 from held where held.k = r.lock_key)
        order by created_at limit $4)
       union all
       (select id from ${this.runs} r
        where ${RUNNING_TOP} and workflow = any($1)
          and not (id = any($3)) and not exists (select 1 from held where held.k = r.lock_key)
        order by created_at limit $4)`,
      [workflows, saturated, exclude, limit],
    )
    return rows.map((r) => r.id)
  }

  /** Top-level runs in `running` per workflow, across all processes. */
  async runningByWorkflow(workflows: string[]): Promise<Map<string, number>> {
    const { rows } = await this.query<{ workflow: string; n: number }>(
      `select workflow, count(*)::int as n from ${this.runs}
       where ${RUNNING_TOP} and workflow = any($1) group by workflow`,
      [workflows],
    )
    return new Map(rows.map((r) => [r.workflow, r.n]))
  }

  /**
   * Cancels the run and every run below it that has not ended: a pending run ends `cancelled` at once; a running
   * one gets `cancel_requested_at`, and the process driving it (or the next one to claim it) aborts the running
   * step, aborts agent sessions and finalizes it. Returns the ids that changed.
   */
  async cancel(id: string): Promise<string[]> {
    const { rows } = await this.query<{ id: string }>(
      `update ${this.runs} set
         status = case when status = 'pending' then 'cancelled' else status end,
         error = case when status = 'pending' then 'cancelled' else error end,
         error_kind = case when status = 'pending' then 'cancelled' else error_kind end,
         finished_at = case when status = 'pending' then now() else finished_at end,
         cancel_requested_at = coalesce(cancel_requested_at, now()),
         updated_at = now()
       where ${this.subtree(1)} and status in ('pending', 'running')
       returning id`,
      [id],
    )
    return rows.map((r) => r.id)
  }

  async cancelRequestedAmong(ids: string[]): Promise<string[]> {
    const { rows } = await this.query<{ id: string }>(
      `select id from ${this.runs}
       where id = any($1) and (status = 'cancelled' or cancel_requested_at is not null)`,
      [ids],
    )
    return rows.map((r) => r.id)
  }

  /** Marks every still-running step of the run and its descendants cancelled; returns them (agent handles to abort). */
  async cancelRunningSteps(id: string, fence: Fence): Promise<CancelledStep[]> {
    const { rows } = await this.query<CancelledStep>(
      `update ${this.steps} set status = 'cancelled', error = 'cancelled', error_kind = 'cancelled', finished_at = now()
       where run_id in (select id from ${this.runs} where ${this.subtree(1)})
         and status = 'running' and ${this.fence(2, 3)}
       returning run_id, step_id, kind, handle`,
      [id, fence.rootId, fence.token],
    )
    return rows
  }

  /** Ends every unfinished descendant of a cancelled run; returns them for their `runPost`. */
  async cancelDescendants(id: string, fence: Fence): Promise<RunRow[]> {
    const { rows } = await this.query<RunRow>(
      `update ${this.runs} set status = 'cancelled', error = 'cancelled', error_kind = 'cancelled',
         finished_at = now(), updated_at = now()
       where ${this.subtree(1)} and id <> $1 and status in ('pending', 'running') and ${this.fence(2, 3)}
       returning ${RUN_COLUMNS}`,
      [id, fence.rootId, fence.token],
    )
    return rows
  }

  /** Journals a steer for a running agent step; false when the step is not a running agent step. */
  async addSteer(runId: string, stepId: string, text: string): Promise<boolean> {
    const res = await this.query(
      `insert into ${this.signals} (run_id, step_id, kind, payload)
       select $1, $2, 'steer', $3 where exists (
         select 1 from ${this.steps} where run_id = $1 and step_id = $2 and kind = 'agent' and status = 'running')`,
      [runId, stepId, JSON.stringify({ text })],
    )
    return res.rowCount === 1
  }

  async pendingSteers(runIds: string[]): Promise<{ id: string; run_id: string; step_id: string; text: string }[]> {
    const { rows } = await this.query<{ id: string; run_id: string; step_id: string; text: string }>(
      `select id::text, run_id, step_id, payload->>'text' as text from ${this.signals}
       where run_id = any($1) and delivered_at is null and kind = 'steer' order by id`,
      [runIds],
    )
    return rows
  }

  async steerDelivered(id: string) {
    await this.query(`update ${this.signals} set delivered_at = now() where id = $1::bigint`, [id])
  }

  /** An inline gate's verdict onto the run under `scores.gates[stepId]`; a re-run of the step writes the same key. */
  async recordGate(runId: string, stepId: string, verdict: Verdict, fence: Fence) {
    await this.fenced(
      fence,
      `update ${this.runs} set scores = jsonb_set(coalesce(scores, '{}'), '{gates}',
           coalesce(scores->'gates', '{}') || jsonb_build_object($4::text, $5::jsonb)),
         updated_at = now()
       where id = $1 and ${this.fence(2, 3)}`,
      [runId, fence.rootId, fence.token, stepId, JSON.stringify(verdict)],
    )
  }

  async scoreTarget(id: string): Promise<ScoreTarget | null> {
    const { rows } = await this.query<ScoreTarget>(
      `select id, workflow, status, input, output, scored_at, score_error, score_error_kind,
         scores->'final'->>'scorer' as scorer
       from ${this.runs} where id = $1`,
      [id],
    )
    return rows[0] ?? null
  }

  /**
   * The after-the-fact score of an ended run (`scores.final`, `score_source`, `scored_at`, `score_error`), resetting
   * the failed-attempt count. Not fenced: the run has ended and nobody else writes these. `onlyUnscored` (drift) makes
   * it first-writer-wins, except over a scorer error of another scorer version (re-scored); false when nothing changed.
   */
  async writeFinalScore(id: string, final: FinalScore, onlyUnscored: boolean): Promise<boolean> {
    const unscored = `and (scored_at is null or score_error_kind = 'infra'
      or (score_error_kind = 'scorer' and scores->'final'->>'scorer' is distinct from $6))`
    const res = await this.query(
      `with scored as (
         update ${this.runs} set scores = coalesce(scores, '{}') || jsonb_build_object('final', $2::jsonb),
           score_source = $3, score_error = $4, score_error_kind = $5,
           -- An infra give-up keeps its count: it sorts last, and a retry a day later gives up after one failure.
           score_attempts = case when $5 = 'infra' then score_attempts else 0 end, scored_at = now(),
           updated_at = now()
         where id = $1 and status in ('done', 'failed') ${onlyUnscored ? unscored : ''}
         returning id
       ), resync as (
         -- The Argo rows carry the scores in raw: steps already posted (or being posted) go back into the outbox,
         -- and a claim in flight is dropped so its mark misses and the next flush posts the scored rows.
         update ${this.steps} s set argo_synced_at = null, argo_claim = null, argo_claimed_until = null
         from scored where s.run_id = scored.id and s.argo_error is null
           and (s.argo_synced_at is not null or s.argo_claim is not null)
       )
       select count(*)::int as n from scored`,
      [
        id,
        JSON.stringify(final),
        final.source,
        final.error ?? null,
        final.error === undefined ? null : (final.errorKind ?? 'scorer'),
        ...(onlyUnscored ? [final.scorer] : []),
      ],
    )
    return (res.rows[0] as { n: number } | undefined)?.n === 1
  }

  /** One more failed scoring attempt (judge, journal): the count `scoreRun` gives up at. */
  async scoreFailed(id: string): Promise<number> {
    const { rows } = await this.query<{ n: number }>(
      `update ${this.runs} set score_attempts = score_attempts + 1, last_score_attempt_at = now()
       where id = $1 returning score_attempts as n`,
      [id],
    )
    return rows[0]?.n ?? 0
  }

  /**
   * Done top-level runs of `workflows` with one of `purposes`, finished since `since`, not scored yet, whose
   * persisted sample position (`drift_sample`, the first 32 bits of md5(id)) is below `rate` × 2^32 (the `runs_drift`
   * index reads only that range), plus drift-scored runs whose scorer error came from another scorer version than the
   * workflow's current one (`versions`, by index). Runs with failed attempts come last, so a persistent failure never
   * starves newer runs.
   */
  async driftCandidates(options: {
    workflows: string[]
    /** The workflows among `workflows` that have a scorer, and its version (same index). */
    scored: string[]
    versions: string[]
    /** First retry delay after a failed attempt, doubled per attempt. */
    backoffMs: number
    purposes: string[]
    rate: number
    since: Date
    limit: number
  }): Promise<string[]> {
    const { rows } = await this.query<{ id: string }>(
      `select id from (
         (select id, score_attempts, finished_at from ${this.runs}
          where workflow = any($1) and status = 'done' and parent_id is null and scored_at is null
            and drift_sample < floor($4::float8 * 4294967296) and finished_at >= $3 and purpose = any($2)
            and (score_attempts = 0
              or last_score_attempt_at < now() - make_interval(secs => $8::float8 / 1000 * 2 ^ (score_attempts - 1))))
         union all
         -- "distinct from" the current version: two hosts on different scorer versions would re-score each other's
         -- errors back and forth; accepted, the platform runs one host per deploy.
         (select r.id, r.score_attempts, r.finished_at from ${this.runs} r
          join unnest($6::text[], $7::text[]) as v(workflow, version) on v.workflow = r.workflow
          where r.score_error is not null and r.score_source = 'drift' and r.finished_at >= $3
            and ((r.score_error_kind = 'scorer' and r.scores->'final'->>'scorer' is distinct from v.version)
              or (r.score_error_kind = 'infra' and r.last_score_attempt_at < now() - interval '1 day'))
            -- The same attempt backoff as unscored runs: a failing re-score is never reselected every tick.
            and (r.score_attempts = 0 or r.last_score_attempt_at is null
              or r.last_score_attempt_at < now() - make_interval(secs => $8::float8 / 1000 * 2 ^ (r.score_attempts - 1))))
       ) c
       order by score_attempts, finished_at limit $5`,
      [
        options.workflows,
        options.purposes,
        options.since,
        options.rate,
        options.limit,
        options.scored,
        options.versions,
        options.backoffMs,
      ],
    )
    return rows.map((r) => r.id)
  }

  /**
   * Scored runs of a workflow, oldest first, narrowed in SQL: by run ids, by a fingerprint prefix, by the exact args
   * an eval arm ran with (jsonb equality: key order does not matter). Only the record columns compare needs.
   */
  async scoredRuns(options: ScoredRunFilter): Promise<ScoredRun[]> {
    const { rows } = await this.query<ScoredRow>(
      `select id, workflow, fingerprint, scores->'final' as final, cost, unpriced_calls, wall_ms,
         tokens_input + tokens_output as tokens, tool_calls, finished_at
       from ${this.runs}
       where workflow = $1 and score_source = $2 and scored_at is not null
         and ($3::text[] is null or id = any($3))
         and ($4::text is null or (fingerprint collate "C" >= $4 and fingerprint collate "C" < ($4 || chr(1114111))))
         and ($5::jsonb is null or coalesce(scores->'final'->'args', '{}') = $5::jsonb)
       order by finished_at, id`,
      [
        options.workflow,
        options.source,
        options.runIds ?? null,
        options.fingerprintPrefix ?? null,
        options.args === undefined ? null : JSON.stringify(options.args),
      ],
    )
    return rows.map((r) => ({
      runId: r.id,
      workflowId: r.workflow,
      fingerprint: r.fingerprint,
      final: r.final,
      cost: r.cost === null ? null : Number(r.cost),
      unpricedCalls: r.unpriced_calls ?? 0,
      wallMs: r.wall_ms,
      tokens: r.tokens === null ? null : Number(r.tokens),
      toolCalls: r.tool_calls,
      finishedAt: r.finished_at,
    }))
  }

  /** The run a workflow + idempotency key names, with what scoring it needs to know; null when there is none. */
  async runByKey(workflow: string, key: string): Promise<KeyedRun | null> {
    const { rows } = await this.query<{
      id: string
      status: RunStatus
      error: string | null
      error_kind: ErrorKind | null
      final: FinalScore | null
      fingerprint: string | null
    }>(
      `select id, status, error, error_kind, scores->'final' as final, fingerprint from ${this.runs}
       where workflow = $1 and idempotency_key = $2`,
      [workflow, key],
    )
    const row = rows[0]
    if (!row) return null
    return {
      runId: row.id,
      status: row.status,
      error: row.error_kind ? { kind: row.error_kind, message: row.error ?? '' } : null,
      final: row.final,
      fingerprint: row.fingerprint,
    }
  }

  /** Mean recorded cost of the latest `limit` done top-level runs of a workflow (the eval estimate). */
  async recentCost(workflow: string, limit: number): Promise<{ runs: number; meanCost: number | null }> {
    const { rows } = await this.query<{ n: number; mean: string | null }>(
      `select count(*)::int as n, avg(cost)::text as mean from (
         select cost from ${this.runs}
         where workflow = $1 and status = 'done' and parent_id is null and cost is not null
         order by finished_at desc limit $2) recent`,
      [workflow, limit],
    )
    const row = rows[0]
    return { runs: row?.n ?? 0, meanCost: row?.mean ? Number(row.mean) : null }
  }

  /** Throws `LeaseLost` when another process took the run tree over. */
  async assertLease(fence: Fence) {
    const { rows } = await this.query<{ lease_token: string | null }>(
      `select lease_token from ${this.runs} where id = $1`,
      [fence.rootId],
    )
    if (rows[0]?.lease_token !== fence.token) throw new LeaseLost(`lease on run ${fence.rootId} was taken over`)
  }

  /** The run `$n` and every run below it; index-usable through `root_id` (children are `${parent}/${step}/${i}`). */
  private subtree(idParam: number): string {
    const p = `$${idParam}`
    return `root_id = (select s.root_id from ${this.runs} s where s.id = ${p})
      and (id = ${p} or starts_with(id, ${p} || '/'))`
  }

  /**
   * `for share` makes a lease takeover (`takeLease` updates the root row) wait for in-flight fenced writes,
   * and a write that starts after the takeover re-checks the new token and matches nothing.
   */
  private fence(rootParam: number, tokenParam: number): string {
    return `exists (select 1 from ${this.runs} f where f.id = $${rootParam} and f.lease_token = $${tokenParam} for share)`
  }

  private async fenced(fence: Fence, sql: string, params: unknown[]): Promise<boolean> {
    const res = await this.query(sql, params)
    if (res.rowCount) return true
    await this.assertLease(fence)
    return false
  }

  private async connect() {
    try {
      return await this.pool.connect()
    } catch (err) {
      throw new InfraError(`journal: ${errorMessage(err)}`, { cause: err })
    }
  }
}
