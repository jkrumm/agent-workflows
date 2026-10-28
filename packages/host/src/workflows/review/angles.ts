import { ALL_ANGLES, type Angle, FLOOR_ANGLES, type ReviewDepth, ROUTER_ANGLES } from './schema.ts'

/** Most angles one review runs. The floor is kept first; the router's extras fill what is left. */
export const MAX_ANGLES = 8

const isAngle = (name: string): name is Angle => (ALL_ANGLES as readonly string[]).includes(name)
const isRouterAngle = (name: string): name is (typeof ROUTER_ANGLES)[number] =>
  (ROUTER_ANGLES as readonly string[]).includes(name)

/** Dedupe by name, keep order, stop at `max`. */
function cap(angles: readonly Angle[], max = MAX_ANGLES): Angle[] {
  return [...new Set(angles)].slice(0, max)
}

/** The deterministic floor: architect and senior-dev always, the rest from what the diff touches. */
export function selectFloor(files: readonly string[], hasTestScript: boolean): Angle[] {
  const floor: Angle[] = ['architect', 'senior-dev']
  if (files.some((f) => /\.(tsx|jsx|css)$/i.test(f))) floor.push('frontend')
  if (files.some((f) => /\.ts$/i.test(f) && /(^|\/)(?:api|server)\//.test(f))) floor.push('backend')
  if (files.some((f) => /\.(ts|tsx)$/i.test(f))) floor.push('typescript')
  if (hasTestScript) floor.push('qa')
  return floor
}

/** An explicit caller list: the baseline stays, unknown names are dropped. */
export function requestedAngles(requested: readonly string[]): Angle[] {
  return cap(['architect', 'senior-dev', ...requested.filter(isAngle)])
}

/** The router's picks that exist as angles; anything else it invented is dropped. */
export function routerPicks(picked: readonly string[]): Angle[] {
  return cap(picked.filter(isRouterAngle))
}

/**
 * The angle set a depth earns. Gating on: `light` keeps senior-dev plus the router's angles; `standard` and `deep`
 * keep the floor plus the router's. Gating off: every depth runs the floor plus the router's.
 */
export function gatedAngles(
  depth: ReviewDepth,
  gating: boolean,
  floor: readonly Angle[],
  routed: readonly Angle[],
): Angle[] {
  if (gating && depth === 'light') return cap([...floor.filter((a) => a === 'senior-dev'), ...routed])
  return cap([...floor, ...routed])
}

export type DepthDecision = { depth: ReviewDepth; source: 'caller' | 'router' | 'fallback'; reason: string }

/** A caller's depth wins, then the router's, then `standard`. */
export function resolveDepth(
  caller: ReviewDepth | undefined,
  router: { depth: ReviewDepth | null; depthReason: string | null } | null,
): DepthDecision {
  if (caller) return { depth: caller, source: 'caller', reason: 'caller-specified' }
  if (router?.depth) return { depth: router.depth, source: 'router', reason: router.depthReason ?? '' }
  return { depth: 'standard', source: 'fallback', reason: 'no router depth; full angle set, no OCR' }
}

export { FLOOR_ANGLES }
