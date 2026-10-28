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
  input: { depth?: string }
  final: {
    caseId?: string
    args?: { design?: string; profile?: string }
    scores?: Record<string, number>
    error?: string
  } | null
  output: { status?: string; tools?: Record<string, number> } | null
  error_kind: string | null
  cost: string | null
  wall_ms: number | null
  tokens_input: string | null
  tokens_output: string | null
  tokens_cache_read: string | null
  tool_calls: number | null
}

const armOf = (args: { design?: string; profile?: string } | undefined): ArmId | null => {
  const design = args?.design ?? 'engine'
  const id = design === 'engine' ? 'engine' : `${design}-${args?.profile ?? 'yolo'}`
  return (ARMS as string[]).includes(id) ? (id as ArmId) : null
}

export async function load(pool: Pool, schema: string, evalRunIds: string[]) {
  const { rows } = await pool.query<DbRow>(
    `select id as run_id, status, input, scores->'final' as final, output, error_kind, cost, wall_ms, tokens_input,
            tokens_output, tokens_cache_read, tool_calls
       from "${schema}".runs
      where workflow = 'research' and scores->'final'->>'evalRunId' = any($1)`,
    [evalRunIds],
  )
  return rows.flatMap((r) => {
    const arm = armOf(r.final?.args)
    const depth = r.input.depth
    if (!arm || !r.final?.caseId || (depth !== 'quick' && depth !== 'standard' && depth !== 'deep')) return []
    const scores = r.final.scores ?? {}
    const row: Row = {
      arm,
      caseId: r.final.caseId,
      depth,
      ok: r.status === 'done' && r.final.error === undefined,
      golden: scores.golden ?? null,
      supported: scores.supported ?? null,
      cost: r.cost === null ? null : Number(r.cost),
      wallMs: r.wall_ms,
    }
    return [
      {
        row,
        partial: r.output?.status === 'partial',
        errorKind: r.error_kind,
        grounded: scores.grounded ?? null,
        tokens: Number(r.tokens_input ?? 0) + Number(r.tokens_output ?? 0),
        cacheRead: Number(r.tokens_cache_read ?? 0),
        toolCalls: r.tool_calls ?? 0,
      },
    ]
  })
}

type Loaded = Awaited<ReturnType<typeof load>>[number]

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const f = (x: number | null, digits = 2) => (x === null ? 'n/a' : x.toFixed(digits))

export function report(loaded: Loaded[]): string {
  const lines: string[] = []
  const table = (title: string, filter: (l: Loaded) => boolean) => {
    lines.push(
      `### ${title}`,
      '',
      '| arm | runs | failed | partial | golden | supported | grounded | median $ | p50 wall s | tokens (median) | cache read share | tool calls (median) |',
      '|-|-|-|-|-|-|-|-|-|-|-|-|',
    )
    for (const arm of ARMS) {
      const mine = loaded.filter((l) => l.row.arm === arm && filter(l))
      if (!mine.length) continue
      const ok = mine.filter((l) => l.row.ok)
      const score = (key: 'golden' | 'supported') => avg(mine.map((l) => (l.row.ok ? (l.row[key] ?? 0) : 0)))
      const tokens = mine.reduce((a, l) => a + l.tokens, 0)
      lines.push(
        `| ${arm} | ${mine.length} | ${mine.length - ok.length} | ${ok.filter((l) => l.partial).length} | ${f(score('golden'))} | ${f(score('supported'))} | ${f(avg(ok.flatMap((l) => (l.grounded === null ? [] : [l.grounded]))))} | ${f(median(mine.flatMap((l) => (l.row.cost === null ? [] : [l.row.cost]))), 4)} | ${f((median(mine.flatMap((l) => (l.row.wallMs === null ? [] : [l.row.wallMs]))) ?? NaN) / 1000, 0)} | ${median(mine.map((l) => l.tokens)) ?? 'n/a'} | ${tokens ? f(mine.reduce((a, l) => a + l.cacheRead, 0) / tokens) : 'n/a'} | ${median(mine.map((l) => l.toolCalls)) ?? 'n/a'} |`,
      )
    }
    lines.push('')
  }
  table('All questions', () => true)
  for (const depth of ['quick', 'standard', 'deep'] as const) table(`${depth}`, (l) => l.row.depth === depth)
  const failures = loaded.filter((l) => !l.row.ok)
  if (failures.length) {
    lines.push('### Failed runs', '', '| arm | case | error kind |', '|-|-|-|')
    for (const l of failures) lines.push(`| ${l.row.arm} | ${l.row.caseId} | ${l.errorKind ?? 'scorer'} |`)
    lines.push('')
  }
  const verdict = decide(loaded.map((l) => l.row))
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
