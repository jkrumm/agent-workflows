import type { Pool, QueryResult, QueryResultRow } from 'pg'
import { type ErrorKind, errorMessage, InfraError, LeaseLost } from './errors.ts'
import type { Json } from './json.ts'
import { lockKey } from './lease.ts'
import type { RunStatus, StepKind, StepStatus, StepUsage } from './types.ts'

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
}

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

/**
 * All SQL of the runtime. Every query error becomes an `InfraError`, so the caller can tell a broken journal
 * from a failing step body.
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

  async query<R extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
    try {
      return await this.pool.query<R>(sql, params)
    } catch (err) {
      throw new InfraError(`journal: ${errorMessage(err)}`, { cause: err })
    }
  }

  /** Inserts the run unless its id or (workflow, idempotency key) exists; returns the id that holds. */
  async insertRun(run: NewRun): Promise<string> {
    const { rows } = await this.query<{ id: string }>(
      `insert into ${this.runs} (id, workflow, parent_id, root_id, purpose, input, input_hash, idempotency_key,
         traceparent, trace_id, version_started, status, error, error_kind, finished_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, case when $12 = 'failed' then now() end)
       on conflict do nothing returning id`,
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
      ],
    )
    if (rows[0]) return rows[0].id
    const existing = await this.query<{ id: string }>(
      `select id from ${this.runs} where id = $1 or (workflow = $2 and idempotency_key = $3)`,
      [run.id, run.workflow, run.idempotencyKey],
    )
    const id = existing.rows[0]?.id
    if (!id) throw new InfraError(`journal: run ${run.id} neither inserted nor found`)
    return id
  }

  async getRun(id: string): Promise<RunRow | null> {
    const { rows } = await this.query<RunRow>(
      `select id, workflow, parent_id, root_id, status, purpose, input, output, error, error_kind, traceparent,
         version_started, started_at
       from ${this.runs} where id = $1`,
      [id],
    )
    return rows[0] ?? null
  }

  /** Called with the advisory lock held: from here on, only writes carrying this token land. */
  async takeLease(id: string, token: string) {
    await this.query(`update ${this.runs} set lease_token = $2, updated_at = now() where id = $1`, [id, token])
  }

  async runningCount(workflow: string): Promise<number> {
    const { rows } = await this.query<{ n: number }>(
      `select count(*)::int as n from ${this.runs}
       where workflow = $1 and parent_id is null and status = 'running'`,
      [workflow],
    )
    return rows[0]?.n ?? 0
  }

  /**
   * pending → running. For a top-level run with a concurrency limit, the count and the update happen under a
   * per-workflow transaction lock, so two processes cannot both take the last slot. False: stay pending.
   */
  async markRunning(id: string, fence: Fence, limit: { workflow: string; max: number } | null): Promise<boolean> {
    const client = await this.connect()
    try {
      await client.query('begin')
      if (limit) {
        await client.query('select pg_advisory_xact_lock($1::bigint)', [
          lockKey(`agw-concurrency:${this.schema}:${limit.workflow}`),
        ])
        const { rows } = await client.query<{ n: number }>(
          `select count(*)::int as n from ${this.runs}
           where workflow = $1 and parent_id is null and status = 'running'`,
          [limit.workflow],
        )
        if ((rows[0]?.n ?? 0) >= limit.max) {
          await client.query('rollback')
          return false
        }
      }
      const res = await client.query(
        `update ${this.runs} set status = 'running', started_at = coalesce(started_at, now()), updated_at = now()
         where id = $1 and status = 'pending' and ${this.fence(2, 3)}`,
        [id, fence.rootId, fence.token],
      )
      await client.query('commit')
      if (res.rowCount) return true
      await this.assertLease(fence)
      return false
    } catch (err) {
      await client.query('rollback').catch(() => {})
      if (err instanceof InfraError) throw err
      throw new InfraError(`journal: ${errorMessage(err)}`, { cause: err })
    } finally {
      client.release()
    }
  }

  /** Terminal write (a refused run ends straight from pending). A cancel that landed first keeps it `cancelled`. */
  async finishRun(id: string, fence: Fence, end: RunEnd): Promise<boolean> {
    const from = end.status === 'cancelled' ? `('pending', 'running', 'cancelled')` : `('pending', 'running')`
    return this.fenced(
      fence,
      `update ${this.runs} set status = $4, output = $5, error = $6, error_kind = $7, version_finished = $8,
         finished_at = now(), updated_at = now()
       where id = $1 and status in ${from} and ${this.fence(2, 3)}`,
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
      `select step_id, kind, status, handle, output, error, error_kind, attempts
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
           finished_at = null`,
      [runId, stepId, fence.rootId, fence.token, kind],
    )
  }

  async stepHandle(runId: string, stepId: string, fence: Fence, state: AgentHandleState) {
    await this.fenced(
      fence,
      `update ${this.steps} set handle = $5 where run_id = $1 and step_id = $2 and ${this.fence(3, 4)}`,
      [runId, stepId, fence.rootId, fence.token, JSON.stringify(state)],
    )
  }

  async finishStep(runId: string, stepId: string, fence: Fence, end: StepEnd) {
    const { usage } = end
    await this.fenced(
      fence,
      `update ${this.steps} set status = $5, output = $6, error = $7, error_kind = $8, model = $9,
         tokens_input = $10, tokens_output = $11, tokens_cache_read = $12, tokens_reasoning = $13,
         cost = $14, tool_calls = $15, usage_by_model = $16, finished_at = now()
       where run_id = $1 and step_id = $2 and ${this.fence(3, 4)}`,
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
      ],
    )
  }

  /** Top-level runs this process can drive, oldest first. */
  async claimable(workflows: string[], limit: number): Promise<string[]> {
    const { rows } = await this.query<{ id: string }>(
      `select id from ${this.runs}
       where parent_id is null and status in ('pending', 'running') and workflow = any($1)
       order by created_at limit $2`,
      [workflows, limit],
    )
    return rows.map((r) => r.id)
  }

  /** Cancels the run and every run below it that has not ended. Returns the ids that changed. */
  async cancel(id: string): Promise<string[]> {
    const { rows } = await this.query<{ id: string }>(
      `update ${this.runs} set status = 'cancelled', error = 'cancelled', error_kind = 'cancelled',
         updated_at = now(), finished_at = coalesce(finished_at, now())
       where (id = $1 or left(id, length($1) + 1) = $1 || '/') and status in ('pending', 'running')
       returning id`,
      [id],
    )
    return rows.map((r) => r.id)
  }

  async cancelledAmong(ids: string[]): Promise<string[]> {
    const { rows } = await this.query<{ id: string }>(
      `select id from ${this.runs} where id = any($1) and status = 'cancelled'`,
      [ids],
    )
    return rows.map((r) => r.id)
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

  private async assertLease(fence: Fence) {
    const { rows } = await this.query<{ lease_token: string | null }>(
      `select lease_token from ${this.runs} where id = $1`,
      [fence.rootId],
    )
    if (rows[0]?.lease_token !== fence.token) throw new LeaseLost(`lease on run ${fence.rootId} was taken over`)
  }

  private async connect() {
    try {
      return await this.pool.connect()
    } catch (err) {
      throw new InfraError(`journal: ${errorMessage(err)}`, { cause: err })
    }
  }
}
