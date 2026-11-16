import type { Pool } from 'pg'
import { containsFence } from './facts.ts'
import { similarFacts } from './similarity.ts'

export const LEARNING_STATUSES = ['proposed', 'active', 'retired'] as const
export type LearningStatus = (typeof LEARNING_STATUSES)[number]

export const MAX_FACT_CHARS = 400
/** How many active facts an agent reads back: the newest, so the block stays small and its cost stays known. */
export const MAX_ACTIVE_FACTS = 25

/** A proposed fact seen by independent runs in this many different ISO weeks is activated. */
export const ACTIVATE_AFTER_WEEKS = 2
/** A proposed fact not seen again for this many weeks is retired. */
export const RETIRE_AFTER_WEEKS = 4
const WEEK_MS = 7 * 86_400_000

export interface Learning {
  id: number
  agent: string
  fact: string
  /** The proposing run's id, or `manual`. */
  source: string
  /** Every run that proposed it (the first is `source`); empty for a human's add. */
  sources: string[]
  evidence: string[]
  /** The ISO weeks (`2026-W47`) in which a run proposed it; empty for a human's add. */
  weeks: string[]
  status: LearningStatus
  createdAt: string
  lastSeenAt: string
  activatedAt: string | null
  retiredAt: string | null
}

export interface NewLearning {
  agent: string
  fact: string
  source: string
  evidence?: string[]
  /** Default `proposed`. Only a human path (`agw learnings add --activate`) passes `active`. */
  status?: 'proposed' | 'active'
  /** When the proposing run looked (its week is the sighting's week). Default now. */
  at?: Date
}

/**
 * What an add did: `new` (stored as proposed or as asked), `repeat` (the same fact seen again by another run in a week
 * it was not seen in: recorded), `activated` (that sighting made it the second week, so it is now active), `known` (the
 * fact exists and nothing changed: same run again, same week, a retired one, or a human's add).
 */
export type AddOutcome = 'new' | 'repeat' | 'activated' | 'known'

export interface TidyReport {
  /** Proposed duplicates folded into the row that stays (their sightings and evidence move to it). */
  merged: number
  activated: Learning[]
  retired: Learning[]
}

/** What the learnings operations, the retrospective and the read-back share. Production is Postgres. */
export interface LearningsStore {
  list(filter?: { agent?: string; status?: LearningStatus; limit?: number }): Promise<Learning[]>
  /**
   * Stores the fact. The same fact of the same agent (identical, or worded alike: {@link similarFacts}) is never stored
   * twice: a run's proposal of a fact that is already there is a sighting. A fact seen by two independent runs in two
   * different ISO weeks is activated ({@link ACTIVATE_AFTER_WEEKS}). A retired one is a rejected one: only a `manual`
   * add brings it back (as the requested status); any other source gets the retired row.
   * Throws {@link LearningRejected} for a fact carrying the learned-facts fence.
   */
  add(learning: NewLearning): Promise<{ learning: Learning; created: boolean; outcome: AddOutcome }>
  /** `proposed` → `active`. Throws on an unknown id or a fence; a retired fact is not revived (add it again by hand). */
  activate(id: number): Promise<Learning>
  /** `proposed | active` → `retired`. Immediate: the next run no longer reads it. */
  retire(id: number): Promise<Learning>
  /** The facts an agent's next run reads back: the {@link MAX_ACTIVE_FACTS} most recently activated, oldest activation first. */
  activeFor(agent: string): Promise<Learning[]>
  /**
   * The rule applied to what is on file: proposed facts worded alike fold into one row (sightings and evidence kept),
   * a proposed fact seen in {@link ACTIVATE_AFTER_WEEKS} weeks by independent runs is activated, one a retrospective
   * proposed and nothing saw again for {@link RETIRE_AFTER_WEEKS} weeks is retired. A human's proposal never ages out.
   */
  tidy(options?: { now?: Date; agent?: string }): Promise<TidyReport>
}

export class LearningNotFound extends Error {
  constructor(id: number) {
    super(`learning ${id} not found`)
  }
}

export class LearningStateError extends Error {}

export class LearningRejected extends Error {}

function assertSafeFact(fact: string) {
  if (containsFence(fact)) throw new LearningRejected('a learned fact may not contain the learned_facts fence')
}

type Row = {
  id: number
  agent: string
  fact: string
  source: string
  sources: string[]
  evidence: string[]
  weeks: string[]
  status: LearningStatus
  created_at: Date
  last_seen_at: Date
  activated_at: Date | null
  retired_at: Date | null
}

const COLUMNS =
  'id, agent, fact, source, sources, evidence, weeks, status, created_at, last_seen_at, activated_at, retired_at'

const toLearning = (row: Row): Learning => ({
  id: row.id,
  agent: row.agent,
  fact: row.fact,
  source: row.source,
  sources: row.sources,
  evidence: row.evidence,
  weeks: row.weeks,
  status: row.status,
  createdAt: row.created_at.toISOString(),
  lastSeenAt: row.last_seen_at.toISOString(),
  activatedAt: row.activated_at?.toISOString() ?? null,
  retiredAt: row.retired_at?.toISOString() ?? null,
})

/** The learnings table of the journal schema (`0005_learnings.sql`, applied by the runtime's migration). */
export function pgLearningsStore(pool: Pick<Pool, 'query'>, schema: string): LearningsStore {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`invalid schema name "${schema}"`)
  const table = `"${schema}".learnings`
  const byId = async (id: number) => {
    const { rows } = await pool.query<Row>(`select ${COLUMNS} from ${table} where id = $1`, [id])
    const row = rows[0]
    if (!row) throw new LearningNotFound(id)
    return row
  }
  const activate: LearningsStore['activate'] = async (id) => {
    const current = await byId(id)
    assertSafeFact(current.fact)
    const { rows } = await pool.query<Row>(
      `update ${table} set status = 'active', activated_at = coalesce(activated_at, now())
        where id = $1 and status in ('proposed', 'active') returning ${COLUMNS}`,
      [id],
    )
    if (rows[0]) return toLearning(rows[0])
    throw new LearningStateError(`learning ${id} is ${current.status}; add the fact again by hand to bring it back`)
  }
  const weekOf = (at: Date) => {
    // The same ISO week the schedule keys a retrospective by (`2026-W47`), computed in the database for the stored rows.
    const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
    const week = Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
  }
  /** The fact of this agent worded like `fact`: a live row before a retired one, the oldest first. */
  const findMatch = async (agent: string, fact: string) => {
    const { rows } = await pool.query<Row>(
      `select ${COLUMNS} from ${table} where agent = $1 order by (status = 'retired'), id`,
      [agent],
    )
    return rows.find((row) => similarFacts(row.fact, fact))
  }
  /** One run's proposal of a fact already on file. The same run again (a resumed step) changes nothing. */
  const seen = async (
    existing: Row,
    learning: NewLearning,
    at: Date,
  ): Promise<{ learning: Learning; created: boolean; outcome: AddOutcome }> => {
    const known = { learning: toLearning(existing), created: false, outcome: 'known' as const }
    if (existing.status === 'retired' || existing.sources.includes(learning.source)) return known
    const week = weekOf(at)
    const { rows } = await pool.query<Row>(
      `update ${table}
          set sources = sources || $2::text, evidence = (select coalesce(array_agg(distinct e), '{}') from unnest(evidence || $3::text[]) e),
              weeks = case when $4 = any(weeks) then weeks else weeks || $4::text end,
              last_seen_at = greatest(last_seen_at, $5)
        where id = $1 and status in ('proposed', 'active') and not ($2 = any(sources)) returning ${COLUMNS}`,
      [existing.id, learning.source, learning.evidence ?? [], week, at],
    )
    const row = rows[0]
    if (!row) return { learning: toLearning(await byId(existing.id)), created: false, outcome: 'known' }
    if (row.status === 'proposed' && row.weeks.length >= ACTIVATE_AFTER_WEEKS)
      return { learning: await activate(row.id), created: false, outcome: 'activated' }
    return {
      learning: toLearning(row),
      created: false,
      outcome: row.weeks.length > existing.weeks.length ? 'repeat' : 'known',
    }
  }
  return {
    activate,
    async list(filter = {}) {
      const { rows } = await pool.query<Row>(
        `select ${COLUMNS} from ${table}
          where ($1::text is null or agent = $1) and ($2::text is null or status = $2)
          order by id desc limit $3`,
        [filter.agent ?? null, filter.status ?? null, filter.limit ?? 100],
      )
      return rows.map(toLearning)
    },
    async add(learning) {
      assertSafeFact(learning.fact)
      const status = learning.status ?? 'proposed'
      const manual = learning.source === 'manual'
      const at = learning.at ?? new Date()
      // A run's proposal that matches a fact on file is a sighting of it, however the run worded it.
      if (!manual) {
        const match = await findMatch(learning.agent, learning.fact)
        if (match) return seen(match, learning, at)
      }
      const inserted = await pool.query<Row>(
        `insert into ${table} (agent, fact, source, sources, evidence, weeks, status, last_seen_at, activated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, case when $7 = 'active' then now() end)
         on conflict (agent, md5(fact)) do nothing
         returning ${COLUMNS}`,
        [
          learning.agent,
          learning.fact,
          learning.source,
          manual ? [] : [learning.source],
          learning.evidence ?? [],
          manual ? [] : [weekOf(at)],
          status,
          at,
        ],
      )
      if (inserted.rows[0]) return { learning: toLearning(inserted.rows[0]), created: true, outcome: 'new' }
      const { rows } = await pool.query<Row>(
        `select ${COLUMNS} from ${table} where agent = $1 and md5(fact) = md5($2)`,
        [learning.agent, learning.fact],
      )
      const existing = rows[0]
      if (!existing) throw new Error('learnings: a duplicate vanished during add; retry')
      if (existing.status === 'retired') {
        if (!manual) return { learning: toLearning(existing), created: false, outcome: 'known' }
        // A human brings a rejected fact back: same row, so its history stays one line.
        const revived = await pool.query<Row>(
          `update ${table} set status = $2, retired_at = null, source = 'manual',
                 activated_at = case when $2 = 'active' then now() end, last_seen_at = now()
            where id = $1 and status = 'retired' returning ${COLUMNS}`,
          [existing.id, status],
        )
        if (revived.rows[0]) return { learning: toLearning(revived.rows[0]), created: true, outcome: 'new' }
        return { learning: toLearning(await byId(existing.id)), created: false, outcome: 'known' } // revived by a concurrent add
      }
      if (!manual) return seen(existing, learning, at) // lost a race with another run's insert of the same text
      // An explicit activation of a fact only proposed so far is honoured.
      if (status === 'active' && existing.status === 'proposed')
        return { learning: await activate(existing.id), created: false, outcome: 'known' }
      return { learning: toLearning(existing), created: false, outcome: 'known' }
    },
    async retire(id) {
      const { rows } = await pool.query<Row>(
        `update ${table} set status = 'retired', retired_at = now()
          where id = $1 and status in ('proposed', 'active') returning ${COLUMNS}`,
        [id],
      )
      if (rows[0]) return toLearning(rows[0])
      return toLearning(await byId(id)) // already retired: idempotent
    },
    async tidy({ now = new Date(), agent = null }: { now?: Date; agent?: string | null } = {}) {
      const report: TidyReport = { merged: 0, activated: [], retired: [] }
      const { rows } = await pool.query<Row>(
        `select ${COLUMNS} from ${table} where status in ('proposed', 'active') and ($1::text is null or agent = $1)
          order by agent, id`,
        [agent],
      )
      // Oldest first; a proposed row folds into the active or older proposed row it is worded like.
      const byAgent = new Map<string, Row[]>()
      for (const row of rows) byAgent.set(row.agent, [...(byAgent.get(row.agent) ?? []), row])
      for (const live of byAgent.values()) {
        const kept: Row[] = []
        for (const row of live) {
          const into = row.status === 'proposed' ? kept.find((k) => similarFacts(k.fact, row.fact)) : undefined
          if (!into) {
            kept.push(row)
            continue
          }
          await pool.query(
            `update ${table}
                set sources = (select coalesce(array_agg(distinct s), '{}') from unnest(sources || $2::text[]) s),
                    evidence = (select coalesce(array_agg(distinct e), '{}') from unnest(evidence || $3::text[]) e),
                    weeks = (select coalesce(array_agg(distinct w order by w), '{}') from unnest(weeks || $4::text[]) w),
                    last_seen_at = greatest(last_seen_at, $5)
              where id = $1`,
            [into.id, row.sources, row.evidence, row.weeks, row.last_seen_at],
          )
          await pool.query(`delete from ${table} where id = $1`, [row.id])
          into.sources = [...new Set([...into.sources, ...row.sources])]
          into.weeks = [...new Set([...into.weeks, ...row.weeks])].sort()
          report.merged++
        }
        for (const row of kept) {
          if (
            row.status === 'proposed' &&
            row.sources.length >= ACTIVATE_AFTER_WEEKS &&
            row.weeks.length >= ACTIVATE_AFTER_WEEKS
          )
            report.activated.push(await activate(row.id))
        }
      }
      const cutoff = new Date(now.getTime() - RETIRE_AFTER_WEEKS * WEEK_MS)
      const stale = await pool.query<Row>(
        `update ${table} set status = 'retired', retired_at = now()
          where status = 'proposed' and cardinality(sources) > 0 and last_seen_at < $1
            and ($2::text is null or agent = $2) returning ${COLUMNS}`,
        [cutoff, agent],
      )
      report.retired = stale.rows.map(toLearning)
      return report
    },
    async activeFor(agent) {
      const { rows } = await pool.query<Row>(
        `select * from (
           select ${COLUMNS} from ${table} where agent = $1 and status = 'active'
            order by activated_at desc, id desc limit $2) newest
          order by activated_at, id`,
        [agent, MAX_ACTIVE_FACTS],
      )
      return rows.map(toLearning)
    },
  }
}
