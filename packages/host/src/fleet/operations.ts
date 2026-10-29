import { type ResolvedCliSpec, withCli } from '@agent-workflows/capabilities'
import { os } from '@orpc/server'
import { z } from 'zod'
import type { HostContext, HostOperation } from '../operations.ts'
import { type Fleet, renderView } from './index.ts'
import { ACCOUNT_ID_PATTERN, DEFAULT_ACCOUNT } from './quota.ts'
import { MAX_COLS, MIN_COLS } from './render.ts'
import { ACCOUNT_QUOTA, OVERVIEW_PAYLOAD } from './schema.ts'

// The reads the fleet answers without a journal row: `agents` (a herdr pane polls it every half minute), `quota` and
// `quota-report` (the statusline reports on every render). They are host operations like `run status`, not workflows.

const base = os.$context<HostContext>()

export const AGENTS_OUTPUT = z.object({
  data: OVERVIEW_PAYLOAD.optional().describe('The merged overview; absent with --text'),
  text: z.string().optional().describe('The text render; only with --text'),
})

export const QUOTA_REPORT_INPUT = z.object({
  fiveHourPct: z.number().describe('Utilisation of the 5-hour window, percent'),
  fiveHourMinsLeft: z.number().nullable().optional().describe('Minutes until the 5-hour window resets'),
  sevenDayPct: z.number().nullable().optional().describe('Utilisation of the 7-day window, percent'),
  account: z
    .string()
    .regex(new RegExp(ACCOUNT_ID_PATTERN))
    .optional()
    .describe(`The account the figures belong to; default ${DEFAULT_ACCOUNT}`),
})

const POSTED = z.object({
  five_hour_pct: z.number(),
  five_hour_mins_left: z.number().nullable(),
  seven_day_pct: z.number().nullable(),
  updated_at: z.number(),
})

export const QUOTA_OUTPUT = z.object({
  data: POSTED.nullable().describe(`The last report for ${DEFAULT_ACCOUNT}, as it was posted`),
  accounts: z
    .record(z.string(), ACCOUNT_QUOTA)
    .describe('Every known account; the CLI numbers, overridden per window by a newer report, stale after 6 h'),
})

const cliOf = (command: string[], extra: Partial<ResolvedCliSpec> = {}): ResolvedCliSpec => ({
  command,
  positional: [],
  mutating: false,
  defaultFormat: 'json',
  kind: 'capability',
  ...extra,
})

export function fleetOperations(fleet: Fleet): Record<'agents' | 'quota' | 'quotaReport', HostOperation> {
  const agentsCli = cliOf(['agents'], { plainField: 'text' })
  const quotaCli = cliOf(['quota'])
  const reportCli = cliOf(['quota-report'])

  return {
    agents: {
      operationId: 'agents',
      method: 'POST',
      path: '/agents',
      cli: agentsCli,
      procedure: base
        .route({
          method: 'POST',
          path: '/agents',
          operationId: 'agents',
          summary: 'Every agent on the host by project, with the newest recommendations and the Max quota',
          description:
            'A read: no run is journaled. --text answers the render for a `watch` pane (print it with --format plain).',
          tags: ['fleet'],
          spec: withCli(agentsCli),
        })
        .input(
          z
            .object({
              text: z.boolean().default(false).describe('Answer the text render instead of the data'),
              color: z.boolean().default(false).describe('ANSI colour and the summary bar (with --text)'),
              cols: z
                .int()
                .min(MIN_COLS)
                .max(MAX_COLS)
                .optional()
                .describe(`Terminal width for --text, ${MIN_COLS}..${MAX_COLS}; default 110`),
            })
            .strict(),
        )
        .output(AGENTS_OUTPUT)
        .handler(async ({ input }) => {
          if (input.text) return { text: await renderView(fleet, input) }
          return { data: (await fleet.view()).payload }
        }),
    },
    quota: {
      operationId: 'quota',
      method: 'GET',
      path: '/quota',
      cli: quotaCli,
      procedure: base
        .route({
          method: 'GET',
          path: '/quota',
          operationId: 'quota',
          summary: 'Claude Max quota per account',
          tags: ['fleet'],
          spec: withCli(quotaCli),
        })
        .output(QUOTA_OUTPUT)
        .handler(async () => ({
          data: fleet.quota.posted(DEFAULT_ACCOUNT),
          accounts: await fleet.quota.accounts(),
        })),
    },
    quotaReport: {
      operationId: 'quotaReport',
      method: 'POST',
      path: '/quota/report',
      cli: reportCli,
      procedure: base
        .route({
          method: 'POST',
          path: '/quota/report',
          operationId: 'quotaReport',
          summary: 'Report one account’s quota figures (the statusline does, on every render)',
          description: 'Held in memory only: no run is journaled.',
          tags: ['fleet'],
          spec: withCli(reportCli),
        })
        .input(QUOTA_REPORT_INPUT.strict())
        .output(z.object({ ok: z.literal(true) }))
        .handler(({ input }) => {
          const { account = DEFAULT_ACCOUNT, ...usage } = input
          fleet.quota.record(account, {
            five_hour_pct: usage.fiveHourPct,
            five_hour_mins_left: usage.fiveHourMinsLeft ?? null,
            seven_day_pct: usage.sevenDayPct ?? null,
          })
          return { ok: true as const }
        }),
    },
  }
}
