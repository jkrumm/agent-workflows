import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/** One credit pool: the `platform` block of an account in the Claude account registry. */
export interface RegistryPool {
  id: string
  creditUsd: number
  /**
   * The credit's expiry day of month, as the Console's Billing page shows it; the credit renews on the same day. Not the
   * subscription's payment day (`iu` pays on the 18th, its credit expires on the 21st). null = unknown.
   */
  cycleDay: number | null
  headroomUsd: number
  /**
   * What production keeps of the credit, in USD; an `eval` request draws only on credit above it. Absent: the pro-rata
   * share of the remaining days, `creditUsd × daysLeft / cycleLengthDays` (docs/gateway.md §Credit pacing).
   */
  evalReserveUsd?: number
  enabled: boolean
  apiKeyRef: string
  adminKeyRef?: string
}

const Platform = z.object({
  creditUsd: z.number().positive(),
  cycleDay: z.number().int().min(1).max(31).nullable(),
  headroomUsd: z.number().nonnegative(),
  evalReserveUsd: z.number().nonnegative().optional(),
  enabled: z.boolean(),
  apiKeyRef: z.string().min(1),
  adminKeyRef: z.string().min(1).optional(),
})

/**
 * Where the registry file is, resolved as the accounts package does (`packages/accounts/src/paths.ts` in
 * software-factory): `$CLAUDE_ACCOUNTS_REGISTRY`, else `~/.config/claude-accounts/registry.json` when it exists, else
 * the shared dotfiles file of a machine that still has one. `$AGW_GATEWAY_ACCOUNTS_FILE` overrides all three. The
 * registry is a JSON file read here by shape only; keys this reader does not know (a mode, a host block, a version) are
 * ignored.
 */
export function registryFile(env: Record<string, string | undefined>, home: string): string {
  const named = env.AGW_GATEWAY_ACCOUNTS_FILE || env.CLAUDE_ACCOUNTS_REGISTRY
  if (named) return named
  const own = join(home, '.config', 'claude-accounts', 'registry.json')
  return existsSync(own) ? own : join(home, 'SourceRoot', 'dotfiles', 'config', 'claude-accounts.json')
}

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

/** Pools whose `evalReserveUsd` exceeds their `creditUsd`: no eval request can ever draw on them. Logged at start. */
export const reserveAboveCredit = (registry: readonly RegistryPool[]): RegistryPool[] =>
  registry.filter((pool) => pool.evalReserveUsd !== undefined && pool.evalReserveUsd > pool.creditUsd)
