// A leaf of this package for a process that bundles to one file (`@agent-workflows/routes/rates`): the text-token rate
// of a model, read from the route table without `discoverRoutes()`. The groups are imported statically, so a bundler
// sees them; `rates.test.ts` fails when a file of `src/table/` is missing below. Nothing here may import `index.ts` or
// `registry.ts`.
import type { Rate, RouteEntry } from './schema.ts'
import audio from './table/audio.ts'
import brain from './table/brain.ts'
import cheap from './table/cheap.ts'
import check from './table/check.ts'
import claude from './table/claude.ts'
import decide from './table/decide.ts'
import diagram from './table/diagram.ts'
import digest from './table/digest.ts'
import evalSeats from './table/eval.ts'
import factory from './table/factory.ts'
import hermes from './table/hermes.ts'
import image from './table/image.ts'
import narrative from './table/narrative.ts'
import otel from './table/otel.ts'
import overview from './table/overview.ts'
import podcast from './table/podcast.ts'
import prose from './table/prose.ts'
import research from './table/research.ts'
import retrospective from './table/retrospective.ts'
import triage from './table/triage.ts'

/** Every route group of `src/table/` by file name (`_shared.ts` holds no routes). */
export const ROUTE_GROUPS: Readonly<Record<string, Readonly<Record<string, RouteEntry>>>> = Object.freeze({
  audio,
  brain,
  cheap,
  check,
  claude,
  decide,
  diagram,
  digest,
  eval: evalSeats,
  factory,
  hermes,
  image,
  narrative,
  otel,
  overview,
  podcast,
  prose,
  research,
  retrospective,
  triage,
})

const RATES: ReadonlyMap<string, Rate> = (() => {
  const rates = new Map<string, Rate>()
  for (const group of Object.values(ROUTE_GROUPS)) {
    for (const route of Object.values(group)) {
      for (const entry of [route, route.fallback]) {
        // The table names one rate per model (rates.test.ts), so the first is the only one.
        if (entry?.rate && !rates.has(entry.model)) rates.set(entry.model, entry.rate)
      }
    }
  }
  return rates
})()

/**
 * The `rate` of any route or fallback that names this model (exact id, no alias), or `null` when none carries one: a
 * model priced per call (`price`), or one the table does not name. The table's own object: do not mutate it. Claude
 * models are priced by `claudeRate` (`./pricing`), which also knows aliases and snapshot ids.
 */
export function routeRate(model: string): Rate | null {
  return RATES.get(model) ?? null
}
