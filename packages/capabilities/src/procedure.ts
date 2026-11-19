// The one file that knows the HTTP framework. A capability's handler is a plain function of
// `(input, ctx)`; here it becomes an oRPC procedure so `call` and HTTP share validation and middleware.
import { call, ORPCError, os } from '@orpc/server'
import type { z } from 'zod'
import type { Attribution, CallArm, Ctx, Usage } from './context.ts'
import {
  type CallOptions,
  type Capability,
  type CapabilityDefinition,
  type ResolvedCliSpec,
  resolveDefinition,
} from './define.ts'
import { CapabilityCallError, CapabilityError, causeOf, ERRORS } from './errors.ts'

/** Per-request context: where billed calls are reported, tagged with the capability. */
export interface RequestContext {
  onUsage?: (capability: string, usage: Usage) => void
  /** The calling step (`call` from a run step); the handler's `ctx.attribution`. */
  attribution?: Attribution
  /** The calling run's arm (`call` from an armed run's step); the handler's `ctx.arm`. Never set from HTTP. */
  arm?: CallArm
  /**
   * Runs the call in place of the handler, after input validation and before output validation: the host makes a
   * direct HTTP call a run of its own. Absent (and always on `call`), the handler runs in place.
   */
  invoke?: (capability: string, input: unknown, signal: AbortSignal) => Promise<unknown>
}

const CODES = Object.keys(ERRORS)

const base = os.$context<RequestContext>().errors(ERRORS)

/** The one log line of a throw no handler typed: which capability, and what threw, with its stack. */
function reportUntyped(capability: string, error: unknown): void {
  console.error('capability failed with an untyped error', {
    capability,
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  })
}

/**
 * Maps what a handler throws to typed errors on every door, so HTTP and `call` fail identically. A throw that is not
 * typed is logged once and answered as an `INTERNAL_SERVER_ERROR` whose message names its cause.
 */
const mapErrors = (capability: string) =>
  base.middleware(async ({ next, errors }) => {
    try {
      return await next()
    } catch (error) {
      if (error instanceof ORPCError) throw error
      // A capability that calls another one (`web.read` over `web.fetch`) gets its failure as a call error; the typed
      // answer of the inner call is the outer call's answer, never an untyped 500 that pages as an error log.
      if (error instanceof CapabilityCallError && CODES.includes(error.code)) {
        const code = error.code as keyof typeof ERRORS
        throw errors[code]({ message: error.message, data: error.data as never, cause: error })
      }
      if (error instanceof CapabilityError && CODES.includes(error.code)) {
        const code = error.code as keyof typeof ERRORS
        throw errors[code]({ message: error.message, data: error.data as never, cause: error })
      }
      reportUntyped(capability, error)
      throw new ORPCError('INTERNAL_SERVER_ERROR', {
        message: `Internal Server Error: ${causeOf(error)}`,
        cause: error,
      })
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
    .use(mapErrors(def.id))
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
      const ctx: Ctx = {
        signal: signal ?? neverAborted(),
        addUsage: (usage) => context.onUsage?.(def.id, usage),
        ...(context.attribution ? { attribution: context.attribution } : {}),
        ...(context.arm ? { arm: context.arm } : {}),
      }
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
      const { addUsage, attribution, arm } = options
      try {
        return (await call(procedure, input as never, {
          context: {
            onUsage: addUsage ? (_, usage) => addUsage(usage) : undefined,
            ...(attribution ? { attribution } : {}),
            ...(arm ? { arm } : {}),
          },
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
