import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { secretProblem } from '@agent-workflows/host/auth'
import { readDoorTokens } from '@agent-workflows/host/door-tokens'
import { z } from 'zod'
import { parseRegistry, type RegistryPool } from './pools/index.ts'

export const DEFAULT_PORT = 7793

/** IU, every wire derived from `IU_BASE_URL` (ends in `/anthropic`), as `packages/capabilities` and `packages/audio` do. */
export interface IuUpstream {
  apiKey: string
  /** `<root>/anthropic`. */
  anthropicBase: string
  /** `IU_BASE_URL` without `/anthropic`: the base of `/openai/v1`, `/gemini/v1beta`, `/replicate/v1`. */
  root: string
  /** The URL's origin: the base of `/decisions/v1`. */
  origin: string
}

export interface GatewayConfig {
  port: number
  ledgerPath: string
  stateDir: string
  registry: RegistryPool[]
  doorTokens: ReadonlyMap<string, string>
  apiSecret: string
  iu: IuUpstream
  /** null: the flush loop is off and rows stay in the ledger. */
  usagePgUrl: string | null
  machine: string
  version: string
  build: string
}

/** Every problem at once, exit 78 (a LaunchAgent does not retry a config error). Values are never echoed. */
export class ConfigError extends Error {
  override name = 'ConfigError'
  constructor(readonly problems: string[]) {
    super(problems.join('; '))
  }
}

type Env = Record<string, string | undefined>

const trimmed = (value: unknown): unknown => (typeof value === 'string' ? value.trim() || undefined : value)
const optional = z.preprocess(trimmed, z.string().optional())
const required = (name: string) => z.preprocess(trimmed, z.string({ error: `${name} is required` }))
const PORT_PROBLEM = 'AGW_GATEWAY_PORT must be a port number'
const port = z.preprocess(
  trimmed,
  z.coerce
    .number({ error: PORT_PROBLEM })
    .int({ error: PORT_PROBLEM })
    .min(0, { error: PORT_PROBLEM })
    .max(65_535, { error: PORT_PROBLEM })
    .default(DEFAULT_PORT),
)
const iuKeyId = z.preprocess(
  trimmed,
  z
    .literal('personal', {
      error: 'IU_KEY_ID must be unset or "personal": the gateway spends on the personal IU key, never the team key',
    })
    .optional(),
)

function iuUpstream(apiKey: string, baseUrl: string, problems: string[]): IuUpstream | null {
  const anthropicBase = baseUrl.replace(/\/+$/, '')
  if (!anthropicBase.endsWith('/anthropic')) {
    problems.push('IU_BASE_URL must end in /anthropic')
    return null
  }
  let origin: string
  try {
    origin = new URL(anthropicBase).origin
  } catch {
    problems.push('IU_BASE_URL is not a URL')
    return null
  }
  return { apiKey, anthropicBase, root: anthropicBase.slice(0, -'/anthropic'.length), origin }
}

/** The field's value, or undefined with its problem noted. */
function fieldOf<T>(schema: z.ZodType<T>, value: unknown, problems: string[]): T | undefined {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  problems.push(...result.error.issues.map((issue) => issue.message))
  return undefined
}

function attempt<T>(problems: string[], read: () => T): T | null {
  try {
    return read()
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
    return null
  }
}

function readRegistry(file: string): RegistryPool[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`AGW_GATEWAY_ACCOUNTS_FILE: ${file} cannot be read`)
  }
  return parseRegistry(JSON.parse(text))
}

/** The gateway's whole configuration, files included. Throws {@link ConfigError} naming every problem. */
export function loadConfig(env: Env): GatewayConfig {
  const problems: string[] = []
  const listen = fieldOf(port, env.AGW_GATEWAY_PORT, problems)
  const stateDir = fieldOf(required('AGW_GATEWAY_STATE_DIR'), env.AGW_GATEWAY_STATE_DIR, problems)
  const accountsFile = fieldOf(required('AGW_GATEWAY_ACCOUNTS_FILE'), env.AGW_GATEWAY_ACCOUNTS_FILE, problems)
  const iuKey = fieldOf(required('IU_API_KEY'), env.IU_API_KEY, problems)
  const iuBase = fieldOf(required('IU_BASE_URL'), env.IU_BASE_URL, problems)
  fieldOf(iuKeyId, env.IU_KEY_ID, problems)

  // Not trimmed: `secretProblem` names a trailing newline.
  const apiSecret = env.AGW_API_SECRET
  const secretError = secretProblem(apiSecret)
  if (secretError !== null) problems.push(secretError)

  const iu = iuKey === undefined || iuBase === undefined ? null : iuUpstream(iuKey, iuBase, problems)
  const registry = accountsFile === undefined ? null : attempt(problems, () => readRegistry(accountsFile))
  const text = (name: string) => fieldOf(optional, env[name], problems)
  const home = text('HOME') ?? homedir()
  const doorFile = text('AGW_DOOR_CALLERS_FILE') ?? join(home, '.agent-workflows', 'data', 'door-tokens')
  const doorTokens = attempt(problems, () => readDoorTokens(doorFile))

  if (
    problems.length > 0 ||
    listen === undefined ||
    stateDir === undefined ||
    apiSecret === undefined ||
    iu === null ||
    registry === null ||
    doorTokens === null
  ) {
    throw new ConfigError(problems)
  }
  return {
    port: listen,
    stateDir,
    ledgerPath: join(stateDir, 'ledger.sqlite'),
    registry,
    doorTokens,
    apiSecret,
    iu,
    usagePgUrl: text('USAGE_PG_URL') ?? null,
    machine: text('AGW_MACHINE') ?? hostname(),
    version: text('AGW_VERSION') ?? 'dev',
    build: text('AGW_GATEWAY_BUILD') ?? 'dev',
  }
}
