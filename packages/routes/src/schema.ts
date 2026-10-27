import { z } from 'zod'

/** Transports. `opencode` is an agent step on the OpenCode host; the other three are single calls. */
export const WIRES = ['iu-openai', 'iu-anthropic', 'iu-decision', 'opencode'] as const
export type Wire = (typeof WIRES)[number]

/** Reasoning levels. `none` is OpenCode's own "thinking off" variant; the rest are shared. */
export const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

/** USD per million tokens, for wires whose provider reports no cost. */
export const rateSchema = z.strictObject({
  inputPerM: z.number().nonnegative(),
  outputPerM: z.number().nonnegative(),
})
export type Rate = z.infer<typeof rateSchema>

export const ROUTE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/

export const routeSchema = z
  .strictObject({
    wire: z.enum(WIRES),
    model: z.string().min(1),
    effort: z.enum(EFFORTS).optional(),
    maxOutputTokens: z.int().positive().optional(),
    rate: rateSchema.optional(),
  })
  .refine((r) => r.wire !== 'iu-decision' || (r.effort === undefined && r.maxOutputTokens === undefined), {
    message: 'iu-decision routes take neither effort nor maxOutputTokens',
  })
export type RouteEntry = z.infer<typeof routeSchema>

/** A table entry plus the id it was resolved by. */
export type ResolvedRoute = RouteEntry & { id: string }

/** A partial entry from the override variable; merged over the table entry, then validated whole. */
export const routePatchSchema = z.strictObject({
  wire: z.enum(WIRES).optional(),
  model: z.string().min(1).optional(),
  effort: z.enum(EFFORTS).nullable().optional(),
  maxOutputTokens: z.int().positive().nullable().optional(),
  rate: rateSchema.nullable().optional(),
})
export type RoutePatch = z.infer<typeof routePatchSchema>

export const overridesSchema = z.record(z.string(), routePatchSchema)
