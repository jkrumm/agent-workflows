import type { Pool } from 'pg'
import { z } from 'zod'
import type { AutoPorts } from './auto.ts'

/** The `label` step of an `eval.mine` run, priced: what it cost for all the candidates it labelled. */
export type LabelStepCost = { runId: string; cost: number }

/**
 * The cost of the `label` step of the newest `eval.mine` runs among `runIds`, newest first, steps with an unknown cost
 * (null) left out; a free step (0) counts. Read through the host's read pool: labelling runs inside the `eval.mine`
 * run (`eval.label` is called in process), so no `eval.label` run exists to read.
 */
export function pgLabelStepCosts(
  pool: Pick<Pool, 'query'>,
  schema: string,
): (options: { runIds: string[]; limit: number }) => Promise<LabelStepCost[]> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`invalid schema name "${schema}"`)
  const sql = `select r.id, s.cost::text as cost from "${schema}".runs r
    join "${schema}".steps s on s.run_id = r.id and s.step_id = 'label'
    where r.workflow = 'eval.mine' and r.id = r.root_id and r.id = any($1) and s.cost is not null
    order by coalesce(s.finished_at, r.created_at) desc, r.id limit $2`
  return async ({ runIds, limit }) => {
    if (runIds.length === 0) return []
    const { rows } = await pool.query<{ id: string; cost: string }>(sql, [runIds, limit])
    return rows.map((row) => ({ runId: row.id, cost: Number(row.cost) }))
  }
}

const schemaName = (schema: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`invalid schema name "${schema}"`)
  return schema
}

/**
 * The real reads of `--auto`: the run journal (records each past run wrote), `usage.records` (what the gateway billed it
 * per payer, and the running IU total) and the gateway's `/health` (eval credit). A source that is not configured throws
 * on use, naming itself, so the run fails on the read instead of sizing from a guess.
 */
export function evalMineAutoPorts(options: {
  journal: Pick<Pool, 'query'>
  schema: string
  usage?: Pick<Pool, 'query'>
  usageSchema?: string
  gatewayUrl?: string
  fetch?: typeof fetch
}): AutoPorts {
  const journalSchema = schemaName(options.schema)
  const usageSchema = schemaName(options.usageSchema ?? 'usage')
  const usage = () => {
    if (!options.usage) throw new Error('USAGE_PG_URL is not set on the host: usage.records cannot be read')
    return options.usage
  }
  const doFetch = options.fetch ?? fetch
  return {
    async creditAvailableUsd() {
      const base = options.gatewayUrl?.trim().replace(/\/+$/, '')
      if (!base) throw new Error('AGW_GATEWAY_URL is not set on the host: the gateway /health cannot be read')
      let health: z.infer<typeof Health>
      try {
        // A hang guard on a plain HTTP read; the gateway answers /health from memory.
        const res = await doFetch(`${base}/health`, { signal: AbortSignal.timeout(30_000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        health = Health.parse(await res.json())
      } catch (error) {
        throw new Error(`gateway /health unreadable: ${error instanceof Error ? error.message : String(error)}`)
      }
      return health.pools.filter((pool) => pool.evalEligible).reduce((sum, pool) => sum + pool.evalAvailableUsd, 0)
    },

    async iuSpentUsd({ since }) {
      const { rows } = await usage().query<{ total: string | null; unpriced: string }>(
        `select sum(cost_usd)::text as total, count(*) filter (where cost_usd is null)::text as unpriced
         from "${usageSchema}".records
         where source = 'gateway' and billing = 'api_key' and api_key = 'personal'
           and lane_detail->>'workflow' like 'eval.%' and ts >= $1::timestamptz`,
        [since],
      )
      // A row without a cost is spend nobody knows: counting it as 0 would plan against a total that is too low.
      const unpriced = Number(rows[0]?.unpriced ?? 0)
      if (unpriced > 0) {
        throw new Error(`${unpriced} IU eval rows since ${since} have no cost_usd, so the IU eval spend is unknown`)
      }
      return Number(rows[0]?.total ?? 0)
    },

    async runSpend({ limit }) {
      const { rows: runs } = await options.journal.query<{ id: string; labelled: number; third_seat: number }>(
        `select r.id, coalesce((r.output->>'labelledThisRun')::int, 0) as labelled,
           coalesce((r.output->>'thirdSeatThisRun')::int, 0) as third_seat
         from "${journalSchema}".runs r
         where r.workflow = 'eval.mine' and r.id = r.root_id and r.status = 'done' and r.output is not null
           and coalesce((r.output->>'labelledThisRun')::int, 0) + coalesce((r.output->>'thirdSeatThisRun')::int, 0) > 0
         order by coalesce(r.finished_at, r.created_at) desc, r.id limit $1`,
        [limit],
      )
      if (runs.length === 0) return []
      const { rows: spend } = await usage().query<{ run_id: string; credit: string | null; iu: string | null }>(
        `select run_id,
           (sum(cost_usd) filter (where billing = 'api_credit'))::text as credit,
           (sum(cost_usd) filter (where billing = 'api_key' and api_key = 'personal'))::text as iu
         from "${usageSchema}".records
         where source = 'gateway' and lane_detail->>'workflow' = 'eval.mine' and run_id = any($1)
         group by run_id`,
        [runs.map((run) => run.id)],
      )
      const byRun = new Map(spend.map((row) => [row.run_id, row]))
      return runs.map((run) => ({
        runId: run.id,
        labelled: Number(run.labelled),
        thirdSeat: Number(run.third_seat),
        creditUsd: Number(byRun.get(run.id)?.credit ?? 0),
        iuUsd: Number(byRun.get(run.id)?.iu ?? 0),
      }))
    },
  }
}

/** The part of the gateway's `/health` the sizing reads. */
const Health = z.object({
  pools: z.array(z.object({ evalEligible: z.boolean(), evalAvailableUsd: z.number().finite() })),
})
