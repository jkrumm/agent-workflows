import type { Pool } from 'pg'

export const LEARNING_STATUSES = ['proposed', 'active', 'retired'] as const
export type LearningStatus = (typeof LEARNING_STATUSES)[number]

export const MAX_FACT_CHARS = 400
/** How many active facts an agent reads back: the newest, so the block stays small and its cost stays known. */
export const MAX_ACTIVE_FACTS = 25

export interface Learning {
  id: number
  agent: string
  fact: string
  /** The proposing run's id, or `manual`. */
  source: string
  evidence: string[]
  status: LearningStatus
  createdAt: string
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
}

/** What the learnings operations, the retrospective and the read-back share. Production is Postgres. */
export interface LearningsStore {
  list(filter?: { agent?: string; status?: LearningStatus; limit?: number }): Promise<Learning[]>
  /** Stores the fact; a live (proposed or active) identical fact of the same agent is returned, not duplicated. */
  add(learning: NewLearning): Promise<{ learning: Learning; created: boolean }>
  /** `proposed` → `active`. Throws on an unknown id; a retired fact is not revived (add it again). */
  activate(id: number): Promise<Learning>
  /** `proposed | active` → `retired`. Immediate: the next run no longer reads it. */
  retire(id: number): Promise<Learning>
  /** The facts an agent's next run reads back: active, newest {@link MAX_ACTIVE_FACTS}, oldest first. */
  activeFor(agent: string): Promise<Learning[]>
}

export class LearningNotFound extends Error {
  constructor(id: number) {
    super(`learning ${id} not found`)
  }
}

export class LearningStateError extends Error {}

type Row = {
  id: number
  agent: string
  fact: string
  source: string
  evidence: string[]
  status: LearningStatus
  created_at: Date
  activated_at: Date | null
  retired_at: Date | null
}

const COLUMNS = 'id, agent, fact, source, evidence, status, created_at, activated_at, retired_at'

const toLearning = (row: Row): Learning => ({
  id: row.id,
  agent: row.agent,
  fact: row.fact,
  source: row.source,
  evidence: row.evidence,
  status: row.status,
  createdAt: row.created_at.toISOString(),
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
    const { rows } = await pool.query<Row>(
      `update ${table} set status = 'active', activated_at = coalesce(activated_at, now())
        where id = $1 and status in ('proposed', 'active') returning ${COLUMNS}`,
      [id],
    )
    if (rows[0]) return toLearning(rows[0])
    const row = await byId(id)
    throw new LearningStateError(`learning ${id} is ${row.status}; add the fact again to bring it back`)
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
      const status = learning.status ?? 'proposed'
      const inserted = await pool.query<Row>(
        `insert into ${table} (agent, fact, source, evidence, status, activated_at)
         values ($1, $2, $3, $4, $5, case when $5 = 'active' then now() end)
         on conflict (agent, md5(fact)) where status <> 'retired' do nothing
         returning ${COLUMNS}`,
        [learning.agent, learning.fact, learning.source, learning.evidence ?? [], status],
      )
      if (inserted.rows[0]) return { learning: toLearning(inserted.rows[0]), created: true }
      const { rows } = await pool.query<Row>(
        `select ${COLUMNS} from ${table} where agent = $1 and md5(fact) = md5($2) and status <> 'retired'`,
        [learning.agent, learning.fact],
      )
      const live = rows[0]
      if (!live) throw new Error('learnings: a duplicate vanished during add; retry')
      // An explicit activation of a fact only proposed so far is honoured.
      if (status === 'active' && live.status === 'proposed')
        return { learning: await activate(live.id), created: false }
      return { learning: toLearning(live), created: false }
    },
    async retire(id) {
      const { rows } = await pool.query<Row>(
        `update ${table} set status = 'retired', retired_at = now()
          where id = $1 and status in ('proposed', 'active') returning ${COLUMNS}`,
        [id],
      )
      if (rows[0]) return toLearning(rows[0])
      const row = await byId(id)
      return toLearning(row) // already retired: idempotent
    },
    async activeFor(agent) {
      const { rows } = await pool.query<Row>(
        `select * from (select ${COLUMNS} from ${table} where agent = $1 and status = 'active' order by id desc limit $2) newest
          order by id`,
        [agent, MAX_ACTIVE_FACTS],
      )
      return rows.map(toLearning)
    },
  }
}
