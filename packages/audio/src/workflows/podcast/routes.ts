import { type ResolvedRoute, resolveRoute } from '../../../../routes/src/index.ts'

// The room's routes, one per stage, in the route table (`packages/routes/src/table/podcast.ts`); `AGW_ROUTES` applies.

export type PodcastRouteId =
  | 'podcast.research'
  | 'podcast.editorial'
  | 'podcast.outline'
  | 'podcast.write'
  | 'podcast.review.a'
  | 'podcast.review.b'
  | 'podcast.metadata'

/** The route entry with `AGW_ROUTES` applied, resolved on every call (an override takes effect without a restart). */
export function resolvePodcastRoute(
  id: PodcastRouteId,
  env: Record<string, string | undefined> = process.env,
): ResolvedRoute {
  return resolveRoute(id, env)
}
