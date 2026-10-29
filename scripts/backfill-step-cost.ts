#!/usr/bin/env bun
// Prices the agent steps the journal holds with `cost IS NULL` (Claude routes by default), and re-posts them to Argo.
//   bun scripts/backfill-step-cost.ts             dry run (default): prints the plan, writes nothing
//   bun scripts/backfill-step-cost.ts --commit    writes steps.cost, the run sums, and re-queues the Argo rows
//   --all-models                                  include non-Claude steps (default: `claude-*` only)
//   --no-estimates                                skip steps whose per-call split is unknowable (default: price them)
// Why these steps are unpriced: `OpenCodeHost.usage()` voided a whole step when ONE of its messages was above the rate's
// long-prompt threshold, even when OpenCode had reported a cost, and the Haiku rate had no tier to price it with.
// Both are fixed in the host and the routes; this prices what was recorded before.
//
// Each step is priced one of two ways, and the plan says which:
//   per-call        the step's OpenCode session still exists and its messages add up to the step's recorded tokens: every
//                   message is priced by `priceOpenCodeMessages`, the function the host uses now (OpenCode's own cost
//                   where it is right, the rate and its long-prompt tier where it is not).
//   step-total-tier the per-call split is gone: the step's token totals are priced at the rate with the long-prompt tier
//                   applied to the whole step. An upper bound (never an under-price): the real calls were not all long.
// Reads AGW_PG_URL, schema AGW_PG_SCHEMA (default `agw`); on the mini run it through `secrets-run run --env-file=.env.tpl`
// like the host. The OpenCode server is found through `server.json` in the state dir (AGW_STATE_DIR, default the host's)
// and only read from. Prints ids and numbers, never a message body, a path or a credential.
//
// `--commit` per step, in one transaction: steps.cost, unpriced_calls = 0, the model's entry in usage_by_model (cost, a
// `costBackfill` marker saying how it was priced), the run's sums (as the `record` middleware computes them), and
// `argo_synced_at`/claim cleared so the outbox re-posts; Argo upserts on (source, source_id, machine). The row's
// `cost_source` is whatever `packages/middleware/src/argo.ts` writes for a step that has a cost.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createClient } from '../packages/opencode-host/src/client.ts'
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

interface Client {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  release(): void
}
interface Pool {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  connect(): Promise<Client>
  end(): Promise<void>
}

const args = new Set(process.argv.slice(2))
const commit = args.has('--commit')
const allModels = args.has('--all-models')
const estimates = !args.has('--no-estimates')

/** The retired region-pinned ids carry the same card as the id without the suffix. */
const normalize = (model: string) => model.replace(/-eu$/, '')

/** The rate of the route table's entry for a model (primary or fallback), or null when no route prices it. */
function rateForModel(model: string): Rate | null {
  const wanted = normalize(model)
  for (const id of routeIds()) {
    const route = resolveRoute(id, {})
    for (const r of [route, route.fallback]) if (r?.model === wanted && r.rate) return r.rate
  }
  return null
}

const num = (value: string) => Number(value)

function openCodeEndpoint() {
  const state = process.env.AGW_STATE_DIR ?? join(homedir(), '.local', 'state', 'agent-workflows')
  try {
    const { port, password } = JSON.parse(readFileSync(join(state, 'opencode', 'server.json'), 'utf8')) as {
      port: number
      password: string
    }
    return { baseUrl: `http://127.0.0.1:${port}`, password }
  } catch {
    return null
  }
}

async function price(step: StepRow, client: ReturnType<typeof createClient> | null): Promise<Planned | Skipped> {
  const model = step.model
  if (!model) return { step, reason: 'no model recorded' }
  const rate = rateForModel(model)
  if (!rate) return { step, reason: `no route prices ${model}` }
  const entries = Object.keys(step.usage_by_model ?? {})
  if (entries.length > 1) return { step, reason: 'several models in one step' }

  if (client && step.session_id) {
    const messages = await client.messages(step.session_id).catch(() => null)
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

  if (!estimates) return { step, reason: 'per-call split unavailable (--no-estimates)' }
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

function report(planned: Planned[], skipped: Skipped[], excluded: number) {
  const groups = new Map<string, { n: number; usd: number }>()
  for (const p of planned) {
    const key = `${p.step.workflow}  ${p.step.model}  ${p.mode}`
    const g = groups.get(key) ?? { n: 0, usd: 0 }
    g.n += 1
    g.usd += p.usd
    groups.set(key, g)
  }
  console.log(`${commit ? 'COMMIT' : 'DRY RUN'}: ${planned.length} step(s) priced, ${usd(planned.reduce((s, p) => s + p.usd, 0))}`)
  for (const [key, g] of [...groups].sort()) console.log(`  ${key}: ${g.n} step(s), ${usd(g.usd)}`)
  const byWorkflow = new Map<string, number>()
  for (const p of planned) byWorkflow.set(p.step.workflow, (byWorkflow.get(p.step.workflow) ?? 0) + p.usd)
  for (const [workflow, total] of [...byWorkflow].sort()) console.log(`  per workflow: ${workflow} ${usd(total)}`)
  const runs = new Set(planned.map((p) => p.step.run_id))
  console.log(`  ${runs.size} run(s) get their cost sum recomputed; ${planned.length} Argo row(s) re-queued`)
  if (skipped.length) {
    const reasons = new Map<string, number>()
    for (const s of skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1)
    for (const [reason, n] of reasons) console.log(`  skipped ${n}: ${reason}`)
  }
  if (excluded) console.log(`  not selected: ${excluded} non-Claude step(s) with cost NULL (--all-models to include)`)
}

async function write(pool: Pool, schema: string, planned: Planned[]) {
  const steps = `"${schema}".steps`
  const runs = `"${schema}".runs`
  const client = await pool.connect()
  try {
    await client.query('begin')
    for (const { step, usd: cost, mode } of planned) {
      const byModel = step.usage_by_model
      const key = byModel ? Object.keys(byModel)[0] : undefined
      const merged =
        byModel && key
          ? { ...byModel, [key]: { ...byModel[key], cost, unpricedCalls: 0, costBackfill: mode } }
          : null
      await client.query(
        `update ${steps} set cost = $3, unpriced_calls = 0, usage_by_model = coalesce($4::jsonb, usage_by_model),
           argo_synced_at = null, argo_claim = null, argo_claimed_until = null
         where run_id = $1 and step_id = $2 and cost is null`,
        [step.run_id, step.step_id, cost, merged === null ? null : JSON.stringify(merged)],
      )
    }
    await client.query(
      `update ${runs} r set cost = s.cost, unpriced_calls = s.unpriced_calls, updated_at = now()
       from (select run_id, sum(cost) as cost, coalesce(sum(unpriced_calls), 0) as unpriced_calls
             from ${steps} where run_id = any($1) group by run_id) s
       where r.id = s.run_id`,
      [[...new Set(planned.map((p) => p.step.run_id))]],
    )
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

async function main() {
  const url = process.env.AGW_PG_URL
  if (!url) throw new Error('AGW_PG_URL is not set')
  const schema = process.env.AGW_PG_SCHEMA?.trim() || 'agw'
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('AGW_PG_SCHEMA is not a plain identifier')
  const require = createRequire(resolve(import.meta.dir, '../packages/runtime/package.json'))
  const { Pool } = require('pg') as { Pool: new (options: { connectionString: string; max: number }) => Pool }
  const pool = new Pool({ connectionString: url, max: 2 })
  try {
    const { rows } = await pool.query(
      `select s.run_id, s.step_id, r.workflow, s.model, s.handle->'handle'->>'sessionId' as session_id,
         s.tokens_input, s.tokens_output, s.tokens_cache_read, s.tokens_cache_write, s.tokens_reasoning,
         s.unpriced_calls, s.usage_by_model
       from "${schema}".steps s join "${schema}".runs r on r.id = s.run_id
       where s.kind = 'agent' and s.cost is null and s.status in ('done', 'failed', 'cancelled')
         and (s.tokens_input > 0 or s.tokens_output > 0)
       order by s.started_at`,
    )
    const all = rows as unknown as StepRow[]
    const selected = all.filter((s) => allModels || s.model?.startsWith('claude-'))
    const endpoint = openCodeEndpoint()
    const client = endpoint ? createClient(() => endpoint) : null
    if (!client) console.log('no OpenCode server.json: every step is priced from its totals')
    const planned: Planned[] = []
    const skipped: Skipped[] = []
    for (const step of selected) {
      const result = await price(step, client)
      if ('usd' in result) planned.push(result)
      else skipped.push(result)
    }
    report(planned, skipped, all.length - selected.length)
    if (!commit) {
      console.log('dry run: nothing written (pass --commit to write)')
      return
    }
    await write(pool, schema, planned)
    console.log(`wrote ${planned.length} step(s)`)
  } finally {
    await pool.end()
  }
}

if (import.meta.main) await main()
