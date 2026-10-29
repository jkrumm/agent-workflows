import { Pool } from 'pg'
import { ARMS, type ArmId, decide, median, type Row } from './decision.ts'

/**
 * The comparison's report: reads the research runs the given eval runs replayed (`agw eval run research --args
 * '{"design":…,"profile":…}'`, three per arm) from the journal and prints the per-arm and per-depth tables and the
 * verdict of the pre-registered rule as markdown. Read-only.
 *   AGW_PG_URL=… bun packages/host/src/workflows/research/compare.ts <evalRunId>[,<evalRunId>…]
 */

type DbRow = {
  run_id: string
  status: string
  idempotency_key: string
  input: { depth?: string; design?: string; profile?: string }
  final: { scores?: Record<string, number>; error?: string } | null
  output: { status?: string; tools?: Record<string, number> } | null
  error_kind: string | null
  cost: string | null
  wall_ms: number | null
  tokens_input: string | null
  tokens_output: string | null
  tokens_cache_read: string | null
  tool_calls: number | null
}

const armOf = (input: { design?: string; profile?: string }): ArmId | null => {
  const design = input.design ?? 'engine'
  const id = design === 'engine' ? 'engine' : `${design}-${input.profile ?? 'yolo'}`
  return (ARMS as string[]).includes(id) ? (id as ArmId) : null
}

/**
 * Every research run the eval runs started, found by their case key (`eval:<evalRunId>:<caseId>`), so none drops out
 * silently. Only a `done` run is ok. A failed run is a miss (golden 0, supported 0, the pre-registered rule) whose cost
 * and wall time count. An incomplete run (cancelled, still running) never ended: it is listed and counted, but left
 * out of quality, of every median and of the rule. A done run without a verdict (not scored yet, a recorded scorer
 * error) is left out of the quality scores and counted as unscored.
 */
export async function load(pool: Pool, schema: string, evalRunIds: string[]) {
  const { rows } = await pool.query<DbRow>(
    `select id as run_id, status, idempotency_key, input, scores->'final' as final, output, error_kind, cost, wall_ms,
            tokens_input, tokens_output, tokens_cache_read, tool_calls
       from "${schema}".runs
      where workflow = 'research'
        and exists (select 1 from unnest($1::text[]) as p where starts_with(idempotency_key, p))`,
    [evalRunIds.map((id) => `eval:${id}:`)],
  )
  return rows.flatMap((r) => {
    const arm = armOf(r.input)
    const depth = r.input.depth
    const prefix = evalRunIds.map((id) => `eval:${id}:`).find((p) => r.idempotency_key.startsWith(p))
    if (!arm || !prefix || (depth !== 'quick' && depth !== 'standard' && depth !== 'deep')) return []
    const state = r.status === 'done' ? 'done' : r.status === 'failed' ? 'failed' : 'incomplete'
    const ended = state !== 'incomplete'
    const verdict = state === 'done' && r.final !== null && r.final.error === undefined
    const scores = verdict ? (r.final?.scores ?? {}) : {}
    const row: Row = {
      arm,
      caseId: r.idempotency_key.slice(prefix.length),
      depth,
      ok: state === 'done',
      golden: scores.golden ?? null,
      supported: scores.supported ?? null,
      cost: ended && r.cost !== null ? Number(r.cost) : null,
      wallMs: ended ? r.wall_ms : null,
    }
    return [
      {
        row,
        state,
        status: r.status,
        unscored: state === 'done' && !verdict,
        partial: r.output?.status === 'partial',
        errorKind: r.error_kind,
        grounded: scores.grounded ?? null,
        judgedShare: scores.judgedShare ?? null,
        tokens: ended ? Number(r.tokens_input ?? 0) + Number(r.tokens_output ?? 0) : null,
        cacheRead: ended ? Number(r.tokens_cache_read ?? 0) : null,
        toolCalls: ended ? (r.tool_calls ?? 0) : null,
      },
    ]
  })
}

type Loaded = Awaited<ReturnType<typeof load>>[number]

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const seconds = (ms: number | null) => (ms === null ? null : ms / 1000)
const f = (x: number | null, digits = 2) => (x === null ? 'n/a' : x.toFixed(digits))

export function report(loaded: Loaded[]): string {
  const lines: string[] = []
  const table = (title: string, filter: (l: Loaded) => boolean) => {
    lines.push(
      `### ${title}`,
      '',
      '| arm | runs | failed | incomplete | unscored | partial | golden | supported | judged share | grounded | median $ | p50 wall s | tokens (median) | cache read share | tool calls (median) |',
      '|-|-|-|-|-|-|-|-|-|-|-|-|-|-|-|',
    )
    for (const arm of ARMS) {
      const mine = loaded.filter((l) => l.row.arm === arm && filter(l))
      if (!mine.length) continue
      const ok = mine.filter((l) => l.row.ok)
      const ended = mine.filter((l) => l.state !== 'incomplete')
      // Failed runs count 0; a done run left unscored and an incomplete run are left out (as in the rule).
      const score = (key: 'golden' | 'supported') =>
        avg(ended.flatMap((l) => (!l.row.ok ? [0] : l.row[key] === null ? [] : [l.row[key]])))
      const tokens = ended.reduce((a, l) => a + (l.tokens ?? 0), 0)
      lines.push(
        `| ${arm} | ${mine.length} | ${mine.filter((l) => l.state === 'failed').length} | ${mine.filter((l) => l.state === 'incomplete').length} | ${mine.filter((l) => l.unscored).length} | ${ok.filter((l) => l.partial).length} | ${f(score('golden'))} | ${f(score('supported'))} | ${f(avg(ok.flatMap((l) => (l.judgedShare === null ? [] : [l.judgedShare]))))} | ${f(avg(ok.flatMap((l) => (l.grounded === null ? [] : [l.grounded]))))} | ${f(median(mine.flatMap((l) => (l.row.cost === null ? [] : [l.row.cost]))), 4)} | ${f(seconds(median(mine.flatMap((l) => (l.row.wallMs === null ? [] : [l.row.wallMs])))), 0)} | ${median(ended.map((l) => l.tokens ?? 0)) ?? 'n/a'} | ${tokens ? f(ended.reduce((a, l) => a + (l.cacheRead ?? 0), 0) / tokens) : 'n/a'} | ${median(ended.map((l) => l.toolCalls ?? 0)) ?? 'n/a'} |`,
      )
    }
    lines.push('')
  }
  table('All questions', () => true)
  for (const depth of ['quick', 'standard', 'deep'] as const) table(`${depth}`, (l) => l.row.depth === depth)
  const failures = loaded.filter((l) => !l.row.ok)
  if (failures.length) {
    lines.push('### Failed or incomplete runs', '', '| arm | case | status | error kind |', '|-|-|-|-|')
    for (const l of failures) lines.push(`| ${l.row.arm} | ${l.row.caseId} | ${l.status} | ${l.errorKind ?? 'n/a'} |`)
    lines.push('')
  }
  // The rule sees ended runs only: an incomplete run is no result (listed above), not a miss.
  const verdict = decide(loaded.filter((l) => l.state !== 'incomplete').map((l) => l.row))
  lines.push(
    '### Verdict by the rule',
    '',
    ...verdict.log.map((s) => `- **${s.rule}**: ${s.detail}`),
    '',
    `**Winner: ${verdict.winner}**`,
  )
  return lines.join('\n')
}

if (import.meta.main) {
  const ids = (process.argv[2] ?? '').split(',').filter(Boolean)
  if (!ids.length || !process.env.AGW_PG_URL) {
    console.error('usage: AGW_PG_URL=… bun compare.ts <evalRunId>[,<evalRunId>…]')
    process.exit(2)
  }
  const pool = new Pool({ connectionString: process.env.AGW_PG_URL, max: 1 })
  try {
    console.log(report(await load(pool, process.env.AGW_PG_SCHEMA ?? 'agw', ids)))
  } finally {
    await pool.end()
  }
}
