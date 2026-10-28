// The one file that knows the HTTP framework. A capability's handler is a plain function of
// `(input, ctx)`; here it becomes an oRPC procedure so `call` and HTTP share validation and middleware.
import { call, ORPCError, os } from '@orpc/server'
import type { z } from 'zod'
import type { Ctx, Usage } from './context.ts'
import {
  type CallOptions,
  type Capability,
  type CapabilityDefinition,
  type ResolvedCliSpec,
  resolveDefinition,
} from './define.ts'
import { CapabilityCallError, CapabilityError, ERRORS } from './errors.ts'

/** Per-request context: where billed calls are reported, tagged with the capability. */
export interface RequestContext {
  onUsage?: (capability: string, usage: Usage) => void
  /**
   * Runs the call in place of the handler, after input validation and before output validation: the host makes a
   * direct HTTP call a run of its own. Absent (and always on `call`), the handler runs in place.
   */
  invoke?: (capability: string, input: unknown, signal: AbortSignal) => Promise<unknown>
}

const CODES = Object.keys(ERRORS)

const base = os
  .$context<RequestContext>()
  .errors(ERRORS)
  // Runs on every door: maps what handlers throw to typed errors, so HTTP and `call` fail identically.
  .use(async ({ next, errors }) => {
    try {
      return await next()
    } catch (error) {
      if (error instanceof ORPCError) throw error
      if (error instanceof CapabilityError && CODES.includes(error.code)) {
        const code = error.code as keyof typeof ERRORS
        throw errors[code]({ message: error.message, data: error.data as never, cause: error })
      }
      throw new ORPCError('INTERNAL_SERVER_ERROR', { cause: error })
    }
  })

/** `llm.title` → `llmTitle`: the one rule for operation ids, shared with the host's own operations. */
export const operationIdOf = (id: string): string => id.replace(/\.(\w)/g, (_, c: string) => c.toUpperCase())

const neverAborted = () => new AbortController().signal

/**
 * The `x-cli` extension rides on the operation's `spec` callback; this is the only place it is attached. The host
 * uses it for its workflow and run operations, so every operation of the process carries the same block.
 */
export const withCli =
  (x: ResolvedCliSpec) =>
  <T extends object>(operation: T): T => ({ ...operation, 'x-cli': x })

export function buildProcedure<I extends z.ZodObject, O extends z.ZodType>(
  def: CapabilityDefinition<I, O>,
  resolved: ReturnType<typeof resolveDefinition>,
) {
  return base
    .route({
      method: resolved.route.method,
      path: resolved.route.path,
      operationId: operationIdOf(def.id),
      summary: def.summary,
      tags: [def.id.split('.')[0] ?? def.id],
      spec: withCli(resolved.cli),
    })
    .input(def.input.strict()) // an unknown key (a renamed flag) is a 400, never silently dropped
    .output(def.output)
    .handler(({ input, context, signal }) => {
      if (context.invoke) return context.invoke(def.id, input, signal ?? neverAborted()) as never
      const ctx: Ctx = { signal: signal ?? neverAborted(), addUsage: (usage) => context.onUsage?.(def.id, usage) }
      return def.handler(input as z.output<I>, ctx) as never
    })
}
export type CapabilityProcedure = ReturnType<typeof buildProcedure>

/** `call` and the router throw oRPC's error; callers see ours, with the same fields as the HTTP body. */
export function toCallError(error: unknown): unknown {
  if (!(error instanceof ORPCError)) return error
  return new CapabilityCallError(error.code, error.status, error.message, error.defined, error.data, { cause: error })
}

const procedures = new WeakMap<object, CapabilityProcedure>()

export function defineCapability<I extends z.ZodObject, O extends z.ZodType, const Id extends string>(
  def: CapabilityDefinition<I, O> & { id: Id },
): Capability<Id, I, O> {
  const resolved = resolveDefinition(def)
  const procedure = buildProcedure(def, resolved)
  const capability: Capability<Id, I, O> = {
    ...def,
    ...resolved,
    async call(input: z.input<I>, options: CallOptions = {}) {
      const { addUsage } = options
      try {
        return (await call(procedure, input as never, {
          context: { onUsage: addUsage ? (_, usage) => addUsage(usage) : undefined },
          signal: options.signal,
        })) as z.output<O>
      } catch (error) {
        throw toCallError(error)
      }
    },
  }
  procedures.set(capability, procedure)
  return capability
}

export function procedureOf(capability: Capability): CapabilityProcedure {
  const procedure = procedures.get(capability)
  if (!procedure) throw new Error(`${capability.id} was not created by defineCapability`)
  return procedure
}
