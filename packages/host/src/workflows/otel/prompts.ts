import type { OtelInputValue } from './schema.ts'

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const

/**
 * The window the task states, in absolute UTC instants: the agent has no clock, so a duration is resolved against
 * `startedAt` (the run's journaled start, so a resumed run gets the same prompt). No `since`: the agent chooses, told
 * what time it is.
 */
export function windowLine(since: string | undefined, startedAt: string): string {
  if (!since) {
    return `Now is ${startedAt}. Choose the window the investigation calls for (default: the last hour) and state it in \`timeRange\`.`
  }
  if (since.includes('/')) return `Exactly ${since.replace('/', ' to ')} (UTC). Query this window, nothing else.`
  const unit = since.slice(-1) as keyof typeof UNIT_MS
  const to = new Date(startedAt)
  const from = new Date(to.getTime() - Number(since.slice(0, -1)) * UNIT_MS[unit])
  return `The last ${since}: ${from.toISOString()} to ${to.toISOString()} (UTC).`
}

export function otelTask(input: OtelInputValue, startedAt: string): string {
  return [
    `## Investigation\n\n${input.investigation.trim()}`,
    `## Environment\n\n${input.env} (fixed: every tool call already runs against it)`,
    `## Window\n\n${windowLine(input.since, startedAt)}`,
    'Answer with the JSON object only.',
  ].join('\n\n')
}

export const JSON_ONLY_REASK =
  'Your last answer was not the JSON object the instructions ask for. Answer again with ONLY that JSON object ' +
  '({"status", "timeRange", "findings", "recommendations"}), no prose and no code fence around it.'
