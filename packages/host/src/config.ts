import { IU_KEY_IDS, type IuKeyId, isIuKeyId, parseIuKeyId } from '@agent-workflows/middleware'
import { secretProblem } from './auth.ts'
import { type FrictionSettings, frictionSettings } from './friction/settings.ts'

export type Env = Record<string, string | undefined>

/** What every platform process boots from (`bootProcess`): the API, the journal, the IU key label, the agents. */
export interface ProcessConfig {
  secret: string
  port: number
  machine: string
  pgUrl: string
  schema: string
  version: string
  agentsDir: string | undefined
  opencodeBin: string | undefined
  /** The label of the IU key this host holds (`IU_KEY_ID`, unset is `personal`); the key itself is never read here. */
  iuKey: IuKeyId
}

/** The host process: a `ProcessConfig` plus the jobs only the host runs (the retrospective, the friction job). */
export interface HostConfig extends ProcessConfig {
  /** The weekly retrospective schedule (`AGW_RETRO_WEEKLY`, on unless `0`, `off` or `false`). */
  retroWeekly: boolean
  /** Scheduled retrospectives file their proposals as GitHub issues (`AGW_RETRO_FILE_ISSUES=1`); off by default. */
  retroFileIssues: boolean
  /** `owner/name` the issues go to (`AGW_RETRO_ISSUE_REPO`); required with `retroFileIssues`. `gh` auth is the host env. */
  retroIssueRepo: string | undefined
  /** The daily friction job (concept §7). Absent means off: only `loadConfig` turns it on, so literal test configs never start it. */
  friction?: FrictionSettings
}

const OFF = new Set(['0', 'off', 'false', 'no'])
const ON = new Set(['1', 'on', 'true', 'yes'])

/** Which variable a process takes its port from, and its default. */
export interface PortSetting {
  name: string
  fallback: number
}

/**
 * The shared settings of every process, read from `env`; problems are pushed to `problems`, never thrown, so a caller
 * adding its own settings still names every problem in one failed start. Values are never echoed.
 */
export function readProcessConfig(env: Env, port: PortSetting, problems: string[]): ProcessConfig {
  const required = (name: string) => {
    const value = env[name]?.trim()
    if (!value) problems.push(`${name} is required`)
    return value ?? ''
  }
  const secret = env.AGW_API_SECRET ?? ''
  const secretIssue = secretProblem(secret)
  if (secretIssue) problems.push(secretIssue)
  const machine = required('AGW_MACHINE')
  const pgUrl = required('AGW_PG_URL')
  const rawPort = env[port.name]?.trim() || String(port.fallback)
  const portNumber = Number(rawPort)
  if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535)
    problems.push(`${port.name} must be an integer from 0 to 65535`)
  const schema = env.AGW_PG_SCHEMA?.trim() || 'agw'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) problems.push('AGW_PG_SCHEMA is not a valid schema name')
  // Set but unknown is a config problem (an unknown id never becomes a key); unset or empty is `personal`.
  const rawKeyId = env.IU_KEY_ID?.trim()
  if (rawKeyId && !isIuKeyId(rawKeyId)) problems.push(`IU_KEY_ID must be one of ${IU_KEY_IDS.join(', ')}`)
  return {
    secret,
    port: portNumber,
    machine,
    pgUrl,
    schema,
    version: env.AGW_VERSION?.trim() || 'dev',
    agentsDir: env.AGW_AGENTS_DIR?.trim() || undefined,
    opencodeBin: env.AGW_OPENCODE_BIN?.trim() || undefined,
    iuKey: parseIuKeyId(rawKeyId && isIuKeyId(rawKeyId) ? rawKeyId : undefined),
  }
}

/** Throws once with every problem; the message format every process's start refusal shares. */
export function assertNoProblems(problems: string[]): void {
  if (problems.length > 0) throw new Error(`invalid configuration:\n- ${problems.join('\n- ')}`)
}

/** Every problem at once, so one failed start names all missing variables. Values are never echoed. */
export function loadConfig(env: Env): HostConfig {
  const problems: string[] = []
  const base = readProcessConfig(env, { name: 'AGW_PORT', fallback: 7791 }, problems)
  const retroFileIssues = ON.has(env.AGW_RETRO_FILE_ISSUES?.trim().toLowerCase() ?? '')
  const retroIssueRepo = env.AGW_RETRO_ISSUE_REPO?.trim() || undefined
  if (retroIssueRepo && !/^[\w.-]+\/[\w.-]+$/.test(retroIssueRepo))
    problems.push('AGW_RETRO_ISSUE_REPO must look like owner/name')
  if (retroFileIssues && !retroIssueRepo) problems.push('AGW_RETRO_FILE_ISSUES needs AGW_RETRO_ISSUE_REPO')
  // Advisory: a bad optional setting disables the daily job and says so, it never stops the host from starting.
  const friction = frictionSettings(env)
  for (const problem of friction.problems) console.error(`[agw-host] friction job disabled: ${problem}`)
  assertNoProblems(problems)
  return {
    ...base,
    retroWeekly: !OFF.has(env.AGW_RETRO_WEEKLY?.trim().toLowerCase() ?? ''),
    retroFileIssues,
    retroIssueRepo,
    friction:
      friction.problems.length > 0
        ? {
            ...friction.settings,
            enabled: false,
            misconfigured: true as const,
            disabledReason: friction.problems.join('; '),
          }
        : friction.settings,
  }
}
