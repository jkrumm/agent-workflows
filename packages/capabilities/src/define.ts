import type { z } from 'zod'
import type { Ctx, Usage } from './context.ts'

/**
 * The `x-cli` extension on each operation (concept §9). The Wave 3 generator reads it from the OpenAPI
 * document; flags come from the input schema's properties that are not positional.
 */
export interface CliSpec {
  /** Command path after `agw`, e.g. `['llm', 'summarize']`. Default: the id split on `.`. */
  command?: string[]
  /** Input properties taken as positional arguments, in order. Default: none. */
  positional?: string[]
  /** Input property read from stdin when it is not given as an argument or flag. */
  stdin?: string
  /** Default: false. */
  mutating?: boolean
  /** Default: `plain`. */
  defaultFormat?: 'plain' | 'json'
  /** Dotted path into the output printed in `plain` format. */
  plainField?: string
}

/** The `x-cli` block as emitted: every default filled in. */
export type ResolvedCliSpec = Required<Pick<CliSpec, 'command' | 'positional' | 'mutating' | 'defaultFormat'>> &
  Pick<CliSpec, 'stdin' | 'plainField'>

export interface RouteSpec {
  /** Default: `POST`. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Default: the id with dots as slashes, e.g. `/llm/summarize`. */
  path?: `/${string}`
}

export interface CapabilityDefinition<I extends z.ZodObject, O extends z.ZodType> {
  /** Dotted, lowercase: `llm.summarize`. Names the HTTP path, the CLI command and the operation. */
  id: string
  summary: string
  input: I
  output: O
  cli?: CliSpec
  route?: RouteSpec
  /** A plain function; it never sees the HTTP framework. Throw `fail(code, …)` for typed errors. */
  handler: (input: z.output<I>, ctx: Ctx) => Promise<z.input<O>> | z.input<O>
}

export interface CallOptions {
  signal?: AbortSignal
  addUsage?: (usage: Usage) => void
}

/** A typed function defined once, exposed as import (`call`), HTTP (the registry's router) and CLI (`x-cli`). */
export interface Capability<
  Id extends string = string,
  I extends z.ZodObject = z.ZodObject,
  O extends z.ZodType = z.ZodType,
> extends CapabilityDefinition<I, O> {
  id: Id
  cli: ResolvedCliSpec
  route: Required<RouteSpec>
  /** In-process call through the same validation, typed errors and middleware as HTTP. */
  call: (input: z.input<I>, options?: CallOptions) => Promise<z.output<O>>
}

export const ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/

export function resolveDefinition<I extends z.ZodObject, O extends z.ZodType>(
  def: CapabilityDefinition<I, O>,
): Pick<Capability, 'cli' | 'route'> {
  if (!ID_PATTERN.test(def.id))
    throw new Error(`capability id "${def.id}" must be dotted lowercase, e.g. "llm.summarize"`)
  const properties = Object.keys(def.input.shape)
  for (const name of [...(def.cli?.positional ?? []), ...(def.cli?.stdin ? [def.cli.stdin] : [])]) {
    if (!properties.includes(name))
      throw new Error(`capability ${def.id}: cli names "${name}", not a property of its input`)
  }
  return {
    cli: {
      command: def.cli?.command ?? def.id.split('.'),
      positional: def.cli?.positional ?? [],
      mutating: def.cli?.mutating ?? false,
      defaultFormat: def.cli?.defaultFormat ?? 'plain',
      ...(def.cli?.stdin ? { stdin: def.cli.stdin } : {}),
      ...(def.cli?.plainField ? { plainField: def.cli.plainField } : {}),
    },
    route: {
      method: def.route?.method ?? 'POST',
      path: def.route?.path ?? (`/${def.id.split('.').join('/')}` as const),
    },
  }
}
