import { FRICTION_COUNTERS, type FrictionCounter } from '@agent-workflows/middleware'
import { z } from 'zod'

/**
 * A run counts as "with friction" when any counter is at or above its limit. Each default is reachable as the FIRST
 * reason, with every other counter below its own limit:
 * - a single nudge is not friction (it fires at the 3rd identical call, which is normal wandering); `nudges: 2` needs
 *   two notes, and two notes without a 5-fold repeat need two different calls repeated 3 times (or two sessions);
 * - `repeatToolCalls: 5` is the second nudge point, a call repeated 5 times is stuck;
 * - the rest are single incidents.
 */
/** `null` switches a counter off. */
export type FrictionLimits = Record<FrictionCounter, number | null>

export const DEFAULT_LIMITS: FrictionLimits = {
  /** Five failed tool calls in a run is more than exploration. */
  toolErrors: 5,
  /** The same call five times: past the first nudge, still going. */
  repeatToolCalls: 5,
  /** Two notes: two different calls repeated 3 times, or two sessions. One note alone is not friction. */
  nudges: 2,
  /** Any schema miss or re-ask. */
  schemaReasks: 1,
  /** Any wallet refusal or runaway-cap failure. */
  overBudget: 1,
  /** The user had to ask again. */
  followUps: 1,
}

export type FrictionSettings = {
  /** The whole job: follow-up marking and issue creation. Default on; `AGW_FRICTION_ISSUES=off` disables it. */
  enabled: boolean
  /** Why the job is off, when it is: the flag, or what was wrong with its configuration. Logged at boot, never served. */
  disabledReason?: string
  /** The job is off because its configuration is wrong (as opposed to switched off). */
  misconfigured?: true
  /** `owner/name` the issues go to (`AGW_FRICTION_REPO`). Without it the job still marks follow-ups but opens nothing. */
  repo: string | undefined
  /** Runs finished in the last N days are looked at. */
  windowDays: number
  /** A workflow needs at least this many runs in the window before a rate means anything. */
  minRuns: number
  /** A breach: this share of the window's runs (0..1) has friction. */
  rate: number
  /** A new run of the same workflow, cwd and scope within this long after a finished one is a follow-up. */
  followUpMinutes: number
  limits: FrictionLimits
}

export const DEFAULT_SETTINGS: FrictionSettings = {
  enabled: true,
  repo: undefined,
  windowDays: 7,
  minRuns: 10,
  rate: 0.25,
  followUpMinutes: 10,
  limits: DEFAULT_LIMITS,
}

const Override = z
  .object({
    windowDays: z.number().int().positive(),
    minRuns: z.number().int().positive(),
    rate: z.number().gt(0).max(1),
    followUpMinutes: z.number().positive(),
    limits: z
      .object(Object.fromEntries(FRICTION_COUNTERS.map((c) => [c, z.number().int().positive().nullable()])))
      .partial()
      .strict(),
  })
  .partial()
  .strict()

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const OFF = new Set(['0', 'false', 'off', 'no'])

/**
 * `AGW_FRICTION_ISSUES` (on unless off), `AGW_FRICTION_REPO` (`owner/name`), `AGW_FRICTION_CONFIG` (JSON with any of
 * windowDays, minRuns, rate, followUpMinutes, limits). Problems are returned, not thrown, so the host's one
 * configuration report names them all.
 */
export function frictionSettings(env: Record<string, string | undefined>): {
  settings: FrictionSettings
  problems: string[]
} {
  const problems: string[] = []
  const repo = env.AGW_FRICTION_REPO?.trim() || undefined
  if (repo && !REPO.test(repo)) problems.push('AGW_FRICTION_REPO must be owner/name')
  let override: z.infer<typeof Override> = {}
  const raw = env.AGW_FRICTION_CONFIG?.trim()
  if (raw) {
    try {
      const parsed = Override.safeParse(JSON.parse(raw))
      if (parsed.success) override = parsed.data
      else
        problems.push(
          `AGW_FRICTION_CONFIG: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        )
    } catch {
      problems.push('AGW_FRICTION_CONFIG is not valid JSON')
    }
  }
  const { limits: given, ...rest } = override
  return {
    settings: {
      ...DEFAULT_SETTINGS,
      ...rest,
      // `null` switches a counter off and stays `null`; an absent one keeps its default.
      limits: { ...DEFAULT_LIMITS, ...given },
      enabled: !OFF.has((env.AGW_FRICTION_ISSUES ?? '').trim().toLowerCase()),
      ...(OFF.has((env.AGW_FRICTION_ISSUES ?? '').trim().toLowerCase())
        ? { disabledReason: 'AGW_FRICTION_ISSUES is off' }
        : {}),
      repo: repo && REPO.test(repo) ? repo : undefined,
    },
    problems,
  }
}

/** What `/health` says about the job: a state, never why (the endpoint is unauthenticated). */
export type FrictionState = 'on' | 'off' | 'misconfigured' | 'no-repo'
export type FrictionStatus = { enabled: boolean; state: FrictionState }

/**
 * The job's state and, for the log only, the reason when it is not `on`. `no-repo`: enabled, but without
 * `AGW_FRICTION_REPO` it records counters and follow-ups and files nothing, which is not the same as working.
 */
export function frictionStatus(settings: FrictionSettings | undefined): FrictionStatus & { reason?: string } {
  if (!settings) return { enabled: false, state: 'off', reason: 'not configured' }
  if (settings.misconfigured) return { enabled: false, state: 'misconfigured', reason: settings.disabledReason }
  if (!settings.enabled) return { enabled: false, state: 'off', reason: settings.disabledReason }
  if (!settings.repo) {
    return { enabled: true, state: 'no-repo', reason: 'AGW_FRICTION_REPO is unset: no issue is ever filed' }
  }
  return { enabled: true, state: 'on' }
}
