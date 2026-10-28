import { MIN_SECRET_LENGTH } from './auth.ts'

export type Env = Record<string, string | undefined>

export interface HostConfig {
  secret: string
  port: number
  machine: string
  pgUrl: string
  schema: string
  version: string
  agentsDir: string | undefined
  opencodeBin: string | undefined
}

/** Every problem at once, so one failed start names all missing variables. Values are never echoed. */
export function loadConfig(env: Env): HostConfig {
  const problems: string[] = []
  const required = (name: string) => {
    const value = env[name]?.trim()
    if (!value) problems.push(`${name} is required`)
    return value ?? ''
  }
  const secret = env.AGW_API_SECRET ?? ''
  if (secret.length < MIN_SECRET_LENGTH)
    problems.push(`AGW_API_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters`)
  const machine = required('AGW_MACHINE')
  const pgUrl = required('AGW_PG_URL')
  const rawPort = env.AGW_PORT?.trim() || '7791'
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) problems.push('AGW_PORT must be an integer from 0 to 65535')
  const schema = env.AGW_PG_SCHEMA?.trim() || 'agw'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) problems.push('AGW_PG_SCHEMA is not a valid schema name')
  if (problems.length > 0) throw new Error(`invalid configuration:\n- ${problems.join('\n- ')}`)
  return {
    secret,
    port,
    machine,
    pgUrl,
    schema,
    version: env.AGW_VERSION?.trim() || 'dev',
    agentsDir: env.AGW_AGENTS_DIR?.trim() || undefined,
    opencodeBin: env.AGW_OPENCODE_BIN?.trim() || undefined,
  }
}
