import type { Logger, Middleware } from '@agent-workflows/runtime'
import { type JournalDb, withRetry } from './db.ts'

/** The label of an IU key (usage-tracker contract, "IU keys"): which key paid, never the key itself. */
export const IU_KEY_IDS = ['personal', 'athena-team'] as const
export type IuKeyId = (typeof IU_KEY_IDS)[number]

export const isIuKeyId = (value: unknown): value is IuKeyId =>
  typeof value === 'string' && (IU_KEY_IDS as readonly string[]).includes(value)

/**
 * `IU_KEY_ID` → a label. Unset or empty is `personal`; anything unknown is `personal` plus one warning (an unknown
 * id never becomes a key). The warning names the allowed ids and never echoes the value.
 */
export function parseIuKeyId(raw: string | undefined, warn?: (message: string) => void): IuKeyId {
  const value = raw?.trim()
  if (!value) return 'personal'
  if (isIuKeyId(value)) return value
  warn?.(`IU_KEY_ID is not one of ${IU_KEY_IDS.join(', ')}; using personal`)
  return 'personal'
}

/**
 * Stamps the label of the key this host process holds onto the run row at admission (`resume: false`, the host
 * that executes the run), the way the fingerprint is stamped. Stored on the run, not read at flush time: the outbox
 * may flush after a restart with a different key. A resumed run keeps the label it was admitted with.
 */
export function iuKeyMiddleware(options: { db: JournalDb; logger: Logger; iuKey: IuKeyId }): Middleware {
  const { db, iuKey } = options
  return {
    name: 'iu-key',
    async runPre({ runId, resume }) {
      if (resume) return
      const { rowCount } = await withRetry(() =>
        db.pool.query(`update ${db.runs} set iu_key = $2, updated_at = now() where id = $1`, [runId, iuKey]),
      )
      if (rowCount === 0) options.logger.warn('iu key: run row not found; label not stamped', { runId })
    },
  }
}
