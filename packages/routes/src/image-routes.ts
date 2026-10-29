import type { ResolvedRoute, RouteEntry } from './schema.ts'

// The image seats (Wave 8). The platform calls IU's OpenAI images endpoint directly (and Replicate through the same IU
// host), where the personal image-gateway wrapped them. Source of every figure: image-gateway `gateway/src/lib/pricing.ts`
// and `shared/src/assets.ts`, measured against IU's own `usage` on 2026-09-23 (the 2.5 pair) and 2026-10-13 (Replicate).
//
// Both generation models bill identically, USD/M: text in 5.00, image in 8.00, image out 30.00; they trade latency, not
// price. `flare` is the speed model (drafts), `sunburst` the quality model (final renders and every edit): the capability
// picks between them the way the gateway's `model: auto` did.
const IMAGE_PRICE = { kind: 'image-tokens', textInPerM: 5, imageInPerM: 8, outputPerM: 30 } as const

export const IMAGE_ROUTES = {
  'image.flare': { wire: 'iu-openai', model: 'gpt-image-2.5-flare', price: IMAGE_PRICE },
  'image.sunburst': { wire: 'iu-openai', model: 'gpt-image-2.5-sunburst', price: IMAGE_PRICE },
  // Replicate bills per run, not per token. recraft keeps the input resolution; bria may downscale to 1024 px.
  'image.cutout.recraft': {
    wire: 'iu-openai',
    model: 'recraft-ai/recraft-remove-background',
    price: { kind: 'unit', unit: 'call', usd: 0.01 },
  },
  'image.cutout.bria': {
    wire: 'iu-openai',
    model: 'bria/remove-background',
    price: { kind: 'unit', unit: 'call', usd: 0.018 },
  },
} as const satisfies Record<string, RouteEntry>

export type ImageRouteId = keyof typeof IMAGE_ROUTES

/**
 * The route for an image seat. Until the route table registers the image seats by directory (Wave 8 registry), this reads
 * `IMAGE_ROUTES` directly and applies no `AGW_ROUTES` override; once registered, callers use `resolveRoute`.
 */
export function resolveImageRoute(id: ImageRouteId): ResolvedRoute {
  return { id, ...structuredClone(IMAGE_ROUTES[id]) }
}
