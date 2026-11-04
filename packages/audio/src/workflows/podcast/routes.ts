import { type PatchInput, type ResolvedRoute, resolveRoute } from '../../../../routes/src/index.ts'

// The room's routes, one per stage, in the route table (`packages/routes/src/table/podcast.ts`); a run's arm patches them.

export type PodcastRouteId =
  | 'podcast.research'
  | 'podcast.editorial'
  | 'podcast.outline'
  | 'podcast.write'
  | 'podcast.review'
  | 'podcast.metadata'

/** The route entry with `patch` (the run's arm's `routes`) applied, resolved on every call; without one, the table. */
export function resolvePodcastRoute(id: PodcastRouteId, patch?: PatchInput): ResolvedRoute {
  return resolveRoute(id, patch)
}
