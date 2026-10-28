import { OpenAPIGenerator } from '@orpc/openapi'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { isProcedure } from '@orpc/server'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'
import type { z } from 'zod'
import type { Usage } from './context.ts'
import type { CallOptions, Capability } from './define.ts'
import { CapabilityCallError } from './errors.ts'
import { procedureOf, type RequestContext, toCallError } from './procedure.ts'

type AnyCapability = Capability<string, z.ZodObject, z.ZodType>
type ById<C extends readonly AnyCapability[], Id extends string> = Extract<C[number], { id: Id }>

export interface RegistryOptions {
  /** Sees every billed model call from HTTP and from `call`, tagged with the capability id. */
  onUsage?: (capability: string, usage: Usage) => void
  info?: { title: string; version: string }
}

export interface Registry<C extends readonly AnyCapability[]> {
  readonly capabilities: C
  ids: () => C[number]['id'][]
  get: <Id extends C[number]['id']>(id: Id) => ById<C, Id>
  call: <Id extends C[number]['id']>(
    id: Id,
    input: z.input<ById<C, Id>['input']>,
    options?: CallOptions,
  ) => Promise<z.output<ById<C, Id>['output']>>
  /** The oRPC router of every capability, nested by id segments; the host merges it into its own. */
  readonly router: RouterNode
  /** The per-request context its procedures expect (`onUsage`); pass it with the router into a handler. */
  readonly requestContext: RequestContext
  /** Fetch-API handler for every capability's route; mount it on `Bun.serve`. */
  fetch: (request: Request) => Promise<Response>
  /** OpenAPI 3.1 document; each operation carries `x-cli`. */
  openapi: () => Promise<Record<string, unknown>>
}

export type RouterNode = { [segment: string]: RouterNode | ReturnType<typeof procedureOf> }

function nest(capabilities: readonly AnyCapability[]): RouterNode {
  const root: RouterNode = {}
  for (const capability of capabilities) {
    const segments = capability.id.split('.')
    const leaf = segments.pop() as string
    let node = root
    for (const segment of segments) {
      const next = node[segment]
      if (next && isProcedure(next))
        throw new Error(`capability "${capability.id}" nests under capability "${segment}"`)
      const child: RouterNode = (next as RouterNode | undefined) ?? {}
      node[segment] = child
      node = child
    }
    if (node[leaf]) throw new Error(`capability "${capability.id}" collides with a namespace of the same name`)
    node[leaf] = procedureOf(capability)
  }
  return root
}

export function notFoundResponse(): Response {
  return Response.json({ defined: false, code: 'NOT_FOUND', status: 404, message: 'Not found' }, { status: 404 })
}

/** The error body everywhere: `{ defined, code, status, message, data? }`; anything unknown is an opaque 500. */
export function errorResponse(error: unknown): Response {
  const failure = toCallError(error)
  if (failure instanceof CapabilityCallError) return Response.json(failure.toJSON(), { status: failure.status })
  return Response.json(
    { defined: false, code: 'INTERNAL_SERVER_ERROR', status: 500, message: 'Internal server error' },
    { status: 500 },
  )
}

export function createRegistry<const C extends readonly AnyCapability[]>(
  capabilities: C,
  options: RegistryOptions = {},
): Registry<C> {
  const byId = new Map<string, AnyCapability>()
  for (const capability of capabilities) {
    if (byId.has(capability.id)) throw new Error(`capability "${capability.id}" is registered twice`)
    byId.set(capability.id, capability)
  }
  const paths = new Set<string>()
  for (const { route, id } of capabilities) {
    const key = `${route.method} ${route.path}`
    if (paths.has(key)) throw new Error(`capability "${id}": route ${key} is taken`)
    paths.add(key)
  }

  const router = nest(capabilities)
  const handler = new OpenAPIHandler(router as never)
  const context: RequestContext = { onUsage: options.onUsage }

  const get = (id: string): AnyCapability => {
    const capability = byId.get(id)
    if (!capability) throw new Error(`unknown capability "${id}" (known: ${[...byId.keys()].join(', ')})`)
    return capability
  }

  return {
    capabilities,
    router,
    requestContext: context,
    ids: () => capabilities.map((c) => c.id),
    get: (id) => get(id) as never,
    async call(id, input, callOptions = {}) {
      const capability = get(id)
      const { addUsage } = callOptions
      return capability.call(input, {
        signal: callOptions.signal,
        addUsage: (usage) => {
          addUsage?.(usage)
          options.onUsage?.(id, usage)
        },
      }) as Promise<never>
    },
    async fetch(request) {
      try {
        const { response } = await handler.handle(request, { context })
        return response ?? notFoundResponse()
      } catch (error) {
        return errorResponse(error)
      }
    },
    async openapi() {
      const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] })
      return generator.generate(router as never, {
        info: options.info ?? { title: 'agent-workflows capabilities', version: '0.0.0' },
      })
    },
  }
}
