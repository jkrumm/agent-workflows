#!/usr/bin/env bun
// Prices the agent steps the journal holds with `cost IS NULL` (Claude routes by default), and re-posts them to Argo.
//   bun scripts/backfill-step-cost.ts             dry run (default): prints the plan, writes nothing
//   bun scripts/backfill-step-cost.ts --commit    writes steps.cost, the run sums, and re-queues the Argo rows
//   --all-models                                  include non-Claude steps (default: `claude-*` only)
//   --estimates                                   also price steps whose per-call split is gone (default: leave them null)
// Why these steps are unpriced: `OpenCodeHost.usage()` voided a whole step when ONE of its messages was above the rate's
// long-prompt threshold, even when OpenCode had reported a cost, and the Haiku rate had no tier to price it with.
// Both are fixed in the host and the routes; this prices what was recorded before.
//
// Each step is priced one of two ways, and the plan says which:
//   per-call        the step's OpenCode session still exists and its messages add up to the step's recorded tokens: every
//                   message is priced by `priceOpenCodeMessages`, the function the host uses now (OpenCode's own cost
//                   where it is right, the rate and its long-prompt tier where it is not).
//   step-total-tier (--estimates only) the per-call split is gone: the step's token totals are priced at the rate, with
//                   the long-prompt tier applied to the whole step when the rate has one. An upper bound: the real calls
//                   were not all long. Without --estimates such a step stays null.
// Reads AGW_PG_URL, schema AGW_PG_SCHEMA (default `agw`); on the mini run it through `secrets-run run --env-file=.env.tpl`
// like the host. The OpenCode server is found through `server.json` in the state dir (AGW_STATE_DIR, default the host's)
// and only read from. Prints ids and numbers, never a message body, a path or a credential.
//
// `--commit`, one short transaction per run: its steps' cost, unpriced_calls = 0, the model's entry in usage_by_model
// (cost, a `costBackfill` marker saying how it was priced), the run's sums (as the `record` middleware computes them, only
// when a step of the run was written), and `argo_synced_at`/claim cleared so the outbox re-posts; Argo upserts on (source,
// source_id, machine). A step quarantined by Argo (`argo_error` set) is never selected or written. Re-running is a no-op:
// priced steps are no longer null. The row's `cost_source` is whatever `packages/middleware/src/argo.ts` writes for a
// step that has a cost.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createClient, type Message } from '../packages/opencode-host/src/client.ts'
import { priceOpenCodeMessages } from '../packages/opencode-host/src/host.ts'
import { costFromUsage, type Rate, resolveRoute, routeIds } from '../packages/routes/src/index.ts'

type Mode = 'per-call' | 'step-total-tier'

interface StepRow {
  run_id: string
  step_id: string
  workflow: string
  model: string | null
  session_id: string | null
  tokens_input: string
  tokens_output: string
  tokens_cache_read: string
  tokens_cache_write: string
  tokens_reasoning: string
  unpriced_calls: number
  usage_by_model: Record<string, Record<string, unknown>> | null
}

interface Planned {
  step: StepRow
  usd: number
  mode: Mode
}

interface Skipped {
  step: StepRow
  reason: string
}

interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>
}
export interface Client extends Queryable {
  release(): void
}
/** The `pg` surface this uses (a `pg.Pool` fits). */
export interface Pool extends Queryable {
  connect(): Promise<Client>
}
/** The one OpenCode client call this makes. */
export interface MessageSource {
  messages(sessionId: string): Promise<Message[]>
}

export interface BackfillOptions {
  pool: Pool
  schema: string
  /** Write. Default false: the plan is printed and nothing is written. */
  commit?: boolean
  /** Include non-Claude steps. Default: `claude-*` only. */
  allModels?: boolean
  /** Also price a step whose per-call split is gone (step totals, upper bound). Default false: it stays null. */
  estimates?: boolean
  /** The OpenCode server's messages; null when it is not reachable (no step can be priced per call). */
  messages: MessageSource | null
  log?: (line: string) => void
}

export interface BackfillResult {
  /** Steps the plan prices. */
  planned: number
  usd: number
  /** Steps actually written (0 on a dry run). */
  written: number
  /** Argo rows actually put back in the outbox (a step the update matched). */
  requeued: number
  /** Runs whose sums were recomputed. */
  runs: number
  skipped: number
}

/** The retired region-pinned ids carry the same card as the id without the suffix. */
const normalize = (model: string) => model.replace(/-eu$/, '')

/** The rate of the route table's entry for a model (primary or fallback), and which entry it is. */
function rateForModel(model: string): { rate: Rate; source: string } | null {
  const wanted = normalize(model)
  for (const id of routeIds()) {
    const route = resolveRoute(id, {})
    for (const [kind, r] of [
      ['primary', route],
      ['fallback', route.fallback],
    ] as const) {
      if (r?.model === wanted && r.rate) return { rate: r.rate, source: `${id} ${kind}` }
    }
  }
  return null
}

const num = (value: string) => Number(value)

async function price(step: StepRow, options: BackfillOptions): Promise<Planned | Skipped> {
  const model = step.model
  if (!model) return { step, reason: 'no model recorded' }
  const found = rateForModel(model)
  if (!found) return { step, reason: `no route prices ${model}` }
  const { rate } = found
  if (Object.keys(step.usage_by_model ?? {}).length > 1) return { step, reason: 'several models in one step' }

  if (options.messages && step.session_id) {
    const messages = await options.messages.messages(step.session_id).catch(() => null)
    if (messages) {
      const sum = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
      for (const m of messages) {
        if (m.type !== 'assistant' || !m.tokens) continue
        const read = m.tokens.cache?.read ?? 0
        const write = m.tokens.cache?.write ?? 0
        sum.input += (m.tokens.input ?? 0) + read + write
        sum.cacheRead += read
        sum.cacheWrite += write
        sum.output += (m.tokens.output ?? 0) + (m.tokens.reasoning ?? 0)
      }
      const matches =
        sum.input === num(step.tokens_input) &&
        sum.cacheRead === num(step.tokens_cache_read) &&
        sum.cacheWrite === num(step.tokens_cache_write) &&
        sum.output === num(step.tokens_output) // the step's output already includes reasoning
      const priced = matches ? priceOpenCodeMessages(messages, rate) : null
      if (priced) return { step, usd: priced.cost, mode: 'per-call' }
    }
  }

  if (!options.estimates) return { step, reason: 'per-call split unavailable (--estimates prices it from the totals)' }
  const read = num(step.tokens_cache_read)
  const write = num(step.tokens_cache_write)
  const total = costFromUsage(
    'opencode',
    {
      input_tokens: num(step.tokens_input) - read - write,
      output_tokens: num(step.tokens_output),
      cache_read_input_tokens: read,
      cache_creation_input_tokens: write,
    },
    rate,
  )
  if (total.usd === null) return { step, reason: 'the rate cannot price the totals' }
  return { step, usd: total.usd, mode: 'step-total-tier' }
}

const usd = (value: number) => `$${value.toFixed(4)}`

/** Prices the plan's steps and, with `commit`, writes them: one short transaction per run. */
export async function backfillStepCost(options: BackfillOptions): Promise<BackfillResult> {
  const { pool, schema, commit = false } = options
  const log = options.log ?? console.log
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('the schema is not a plain identifier')
  const steps = `"${schema}".steps`
  const runs = `"${schema}".runs`

  const { rows } = await pool.query(
    `select s.run_id, s.step_id, r.workflow, s.model, s.handle->'handle'->>'sessionId' as session_id,
       s.tokens_input, s.tokens_output, s.tokens_cache_read, s.tokens_cache_write, s.tokens_reasoning,
       s.unpriced_calls, s.usage_by_model
     from ${steps} s join ${runs} r on r.id = s.run_id
     where s.kind = 'agent' and s.cost is null and s.argo_error is null and s.status in ('done', 'failed', 'cancelled')
       and (s.tokens_input > 0 or s.tokens_output > 0)
     order by s.started_at`,
  )
  const quarantined = Number(
    (
      await pool.query(
        `select count(*)::int as n from ${steps} where kind = 'agent' and cost is null and argo_error is not null`,
      )
    ).rows[0]?.n ?? 0,
  )
  const all = rows as unknown as StepRow[]
  const selected = all.filter((s) => options.allModels || s.model?.startsWith('claude-'))
  const planned: Planned[] = []
  const skipped: Skipped[] = []
  for (const step of selected) {
    const result = await price(step, options)
    if ('usd' in result) planned.push(result)
    else skipped.push(result)
  }

  log(`${commit ? 'COMMIT' : 'DRY RUN'}: ${planned.length} step(s) priced, ${usd(planned.reduce((n, p) => n + p.usd, 0))}`)
  const groups = new Map<string, { n: number; usd: number }>()
  for (const p of planned) {
    const key = `${p.step.workflow}  ${p.step.model}  ${p.mode}`
    const g = groups.get(key) ?? { n: 0, usd: 0 }
    g.n += 1
    g.usd += p.usd
    groups.set(key, g)
  }
  for (const [key, g] of [...groups].sort()) log(`  ${key}: ${g.n} step(s), ${usd(g.usd)}`)
  const byWorkflow = new Map<string, number>()
  for (const p of planned) byWorkflow.set(p.step.workflow, (byWorkflow.get(p.step.workflow) ?? 0) + p.usd)
  for (const [workflow, total] of [...byWorkflow].sort()) log(`  per workflow: ${workflow} ${usd(total)}`)
  for (const model of [...new Set(selected.map((s) => s.model).filter((m): m is string => m !== null))].sort()) {
    const found = rateForModel(model)
    log(
      found
        ? `  rate source: ${model} -> route ${found.source} (in ${found.rate.inputPerM}, out ${found.rate.outputPerM} per M${found.rate.longPrompt ? `, tier x${found.rate.longPrompt.inputMultiplier}/x${found.rate.longPrompt.outputMultiplier} over ${found.rate.longPromptTokens}` : ', no tier'})`
        : `  rate source: ${model} -> none (not priced)`,
    )
  }
  const reasons = new Map<string, number>()
  for (const s of skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1)
  for (const [reason, n] of reasons) log(`  skipped ${n}: ${reason}`)
  if (all.length > selected.length) {
    log(`  not selected: ${all.length - selected.length} non-Claude step(s) with cost NULL (--all-models to include)`)
  }
  if (quarantined) log(`  left alone: ${quarantined} step(s) with cost NULL that Argo quarantined (argo_error set)`)

  const result: BackfillResult = { planned: planned.length, usd: 0, written: 0, requeued: 0, runs: 0, skipped: skipped.length }
  result.usd = planned.reduce((n, p) => n + p.usd, 0)
  if (!commit) {
    log('dry run: nothing written (pass --commit to write)')
    return result
  }

  const byRun = new Map<string, Planned[]>()
  for (const p of planned) byRun.set(p.step.run_id, [...(byRun.get(p.step.run_id) ?? []), p])
  for (const [runId, items] of byRun) {
    const client = await pool.connect()
    try {
      await client.query('begin')
      let matched = 0
      for (const { step, usd: cost, mode } of items) {
        const byModel = step.usage_by_model
        const key = byModel ? Object.keys(byModel)[0] : undefined
        const merged =
          byModel && key ? { ...byModel, [key]: { ...byModel[key], cost, unpricedCalls: 0, costBackfill: mode } } : null
        const res = await client.query(
          `update ${steps} set cost = $3, unpriced_calls = 0, usage_by_model = coalesce($4::jsonb, usage_by_model),
             argo_synced_at = null, argo_claim = null, argo_claimed_until = null
           where run_id = $1 and step_id = $2 and cost is null and argo_error is null`,
          [step.run_id, step.step_id, cost, merged === null ? null : JSON.stringify(merged)],
        )
        matched += res.rowCount ?? 0
      }
      if (matched > 0) {
        // The `record` middleware's sums: the run's own steps, summed.
        await client.query(
          `update ${runs} r set cost = s.cost, unpriced_calls = s.unpriced_calls, updated_at = now()
           from (select sum(cost) as cost, coalesce(sum(unpriced_calls), 0) as unpriced_calls
                 from ${steps} where run_id = $1) s
           where r.id = $1`,
          [runId],
        )
        result.runs += 1
      }
      await client.query('commit')
      result.written += matched
      result.requeued += matched
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }
  log(`wrote ${result.written} step(s) in ${result.runs} run(s); ${result.requeued} Argo row(s) re-queued`)
  return result
}

function openCodeMessages(): MessageSource | null {
  const state = process.env.AGW_STATE_DIR ?? join(homedir(), '.local', 'state', 'agent-workflows')
  try {
    const { port, password } = JSON.parse(readFileSync(join(state, 'opencode', 'server.json'), 'utf8')) as {
      port: number
      password: string
    }
    const endpoint = { baseUrl: `http://127.0.0.1:${port}`, password }
    return createClient(() => endpoint)
  } catch {
    return null
  }
}

async function main() {
  const argv = new Set(process.argv.slice(2))
  const url = process.env.AGW_PG_URL
  if (!url) throw new Error('AGW_PG_URL is not set')
  const require = createRequire(resolve(import.meta.dir, '../packages/runtime/package.json'))
  const { Pool } = require('pg') as {
    Pool: new (options: { connectionString: string; max: number }) => Pool & { end(): Promise<void> }
  }
  const pool = new Pool({ connectionString: url, max: 2 })
  try {
    const messages = openCodeMessages()
    if (!messages) console.log('no OpenCode server.json: no step can be priced per call')
    await backfillStepCost({
      pool,
      schema: process.env.AGW_PG_SCHEMA?.trim() || 'agw',
      commit: argv.has('--commit'),
      allModels: argv.has('--all-models'),
      estimates: argv.has('--estimates'),
      messages,
    })
  } finally {
    await pool.end()
  }
}

if (import.meta.main) await main()
