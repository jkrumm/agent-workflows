import type { Logger } from './log.ts'
import type { RegistryPool } from './pools/index.ts'

const READ_TIMEOUT_MS = 20_000

/** The ref's value, or a reason it has none. The reason never carries the value. */
export type ReadSecret = (ref: string) => Promise<{ value: string } | { reason: string }>

/** `secrets-run read <ref>`, bounded; a placeholder value (`REPLACE`) counts as no value. */
export const secretsRunReader =
  (command = 'secrets-run'): ReadSecret =>
  async (ref) => {
    let proc: Bun.Subprocess<'ignore', 'pipe', 'ignore'>
    try {
      proc = Bun.spawn([command, 'read', ref], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: READ_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      })
    } catch {
      return { reason: `${command} is not on PATH` }
    }
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (proc.signalCode !== null) return { reason: `${command} timed out after ${READ_TIMEOUT_MS} ms` }
    if (code !== 0) return { reason: `${command} exited ${code}` }
    const value = text.trim()
    if (value === '') return { reason: 'the ref is empty' }
    if (value.includes('REPLACE')) return { reason: 'the ref holds a REPLACE placeholder' }
    return { value }
  }

export interface ResolvedKeys {
  /** Every enabled pool; `undefined` = the ref did not resolve, the pool is disabled. */
  keys: Map<string, string | undefined>
  /** Only the pools whose admin ref resolved. */
  adminKeys: Map<string, string>
}

/** Resolves the keys of the enabled pools at start. A failure disables that pool (or its reconcile), logged by ref. */
export async function resolveKeys(input: {
  registry: RegistryPool[]
  read: ReadSecret
  logger: Logger
}): Promise<ResolvedKeys> {
  const { read, logger } = input
  const resolve = async (pool: string, kind: string, ref: string): Promise<string | undefined> => {
    const result = await read(ref)
    if ('value' in result) return result.value
    logger.warn(`pool ${pool}: ${kind} not resolved`, { pool, ref, reason: result.reason })
    return undefined
  }
  const enabled = input.registry.filter((pool) => pool.enabled)
  const resolved = await Promise.all(
    enabled.map(async (pool) => ({
      id: pool.id,
      key: await resolve(pool.id, 'api key', pool.apiKeyRef),
      admin: pool.adminKeyRef === undefined ? undefined : await resolve(pool.id, 'admin key', pool.adminKeyRef),
    })),
  )
  const keys = new Map<string, string | undefined>()
  const adminKeys = new Map<string, string>()
  for (const { id, key, admin } of resolved) {
    keys.set(id, key)
    if (admin !== undefined) adminKeys.set(id, admin)
  }
  return { keys, adminKeys }
}
