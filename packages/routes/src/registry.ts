import { basename, join } from 'node:path'
import { ROUTE_ID, type RouteEntry, type RouteId, routeSchema } from './schema.ts'

/** The one file in a table directory that is not a group: the rates and fallbacks the groups import. */
const SHARED = '_shared.ts'

/**
 * Every route of every `<dir>/<group>.ts` (sorted; `_shared.ts`, the constants, and `*.test.ts` skipped), each
 * default-exporting its entries; any other file there is a group, so a stray one fails rather than going unread.
 * Fails, naming the file, on an empty dir, a default export that is not an object, an invalid id or
 * entry, or an id another group already declared.
 */
export async function discoverRoutes(dir: string): Promise<Record<string, Readonly<RouteEntry>>> {
  const files = [...new Bun.Glob('*.ts').scanSync({ cwd: dir, absolute: true })]
    .filter((file) => basename(file) !== SHARED && !file.endsWith('.test.ts'))
    .sort()
  if (files.length === 0) throw new Error(`route table: no route group under ${dir}`)
  const out: Record<string, Readonly<RouteEntry>> = {}
  const owner = new Map<string, string>()
  for (const file of files) {
    const entries: unknown = (await import(file)).default
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries))
      throw new Error(`route table: ${file}: default export is not an object of routes`)
    for (const [id, entry] of Object.entries(entries)) {
      const other = owner.get(id)
      if (other) throw new Error(`route table: ${file}: route "${id}" is already declared by ${other}`)
      owner.set(id, file)
      out[id] = parseEntry(file, id, entry)
    }
  }
  return Object.freeze(out)
}

function parseEntry(file: string, id: string, entry: unknown): Readonly<RouteEntry> {
  if (!ROUTE_ID.test(id)) throw new Error(`route table: ${file}: invalid route id "${id}"`)
  const parsed = routeSchema.safeParse(entry)
  if (!parsed.success) throw new Error(`route table: ${file}: "${id}" is invalid: ${parsed.error.message}`)
  // The parsed copy is ours alone; freezing it (and its rate) makes the table immutable for the process.
  if (parsed.data.rate) Object.freeze(parsed.data.rate)
  if (parsed.data.fallback?.rate) Object.freeze(parsed.data.fallback.rate)
  if (parsed.data.fallback) Object.freeze(parsed.data.fallback)
  return Object.freeze(parsed.data)
}

/** The validated table of `src/table/`, deeply frozen, discovered once per process. Overrides never touch it. */
export const DEFAULT_ROUTES = (await discoverRoutes(join(import.meta.dir, 'table'))) as Readonly<
  Record<RouteId, Readonly<RouteEntry>>
>
