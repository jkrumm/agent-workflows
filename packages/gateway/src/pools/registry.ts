import { z } from 'zod'

/** One credit pool: the `platform` block of an account in dotfiles `config/claude-accounts.json`. */
export interface RegistryPool {
  id: string
  creditUsd: number
  /** Day of month the credit expires and renews (Console Billing page); null = unknown. */
  cycleDay: number | null
  headroomUsd: number
  enabled: boolean
  apiKeyRef: string
  adminKeyRef?: string
}

const Platform = z.object({
  creditUsd: z.number().positive(),
  cycleDay: z.number().int().min(1).max(31).nullable(),
  headroomUsd: z.number().nonnegative(),
  enabled: z.boolean(),
  apiKeyRef: z.string().min(1),
  adminKeyRef: z.string().min(1).optional(),
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The credit pools of the account registry, in registry order. Accounts without a `platform` block are skipped; a
 * malformed block throws naming the account and the field.
 */
export function parseRegistry(json: unknown): RegistryPool[] {
  if (!isRecord(json) || !isRecord(json.accounts)) throw new Error('registry: expected an object with `accounts`')

  const pools: RegistryPool[] = []
  for (const [id, account] of Object.entries(json.accounts)) {
    if (!isRecord(account)) throw new Error(`registry: account "${id}" is not an object`)
    if (account.platform === undefined) continue

    const parsed = Platform.safeParse(account.platform)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const field = ['platform', ...(issue?.path ?? []).map(String)].join('.')
      throw new Error(`registry: account "${id}" ${field}: ${issue?.message ?? 'invalid'}`)
    }
    pools.push({ id, ...parsed.data })
  }
  return pools
}
