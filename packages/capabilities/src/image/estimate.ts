import { SIZE_PRESETS } from './size.ts'

/**
 * Output tokens at 1024x1024 per quality tier, measured against the endpoint on 2026-09-23 for both generation models
 * (image-gateway `shared/src/cost.ts`, `docs/research/endpoint-verification.md`). Output scales roughly linearly with
 * pixels; a pre-run estimate, not a guarantee. The USD per token comes from the route's price, never from here.
 */
const OUTPUT_TOKENS_AT_BASE = { low: 196, medium: 439, high: 1756, xhigh: 3122, max: 7024 } as const
const BASE_PIXELS = 1024 * 1024

export function sizeToPixels(size: string): number {
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(size)
  return match ? Number(match[1]) * Number(match[2]) : BASE_PIXELS
}

/** USD for `n` images. `auto` quality is priced as `high`: estimate the expensive case rather than under-quote. */
export function estimateCost(args: {
  quality: keyof typeof OUTPUT_TOKENS_AT_BASE | 'auto'
  size: string
  n: number
  outputPerM: number
}) {
  const quality = args.quality === 'auto' ? 'high' : args.quality
  const tokens = OUTPUT_TOKENS_AT_BASE[quality] * (sizeToPixels(args.size) / BASE_PIXELS)
  const perImageUsd = (tokens / 1_000_000) * args.outputPerM
  return { perImageUsd, totalUsd: perImageUsd * args.n }
}

/** Invalid sizes snap to the nearest real preset by aspect ratio in log space (3:2 and 2:3 are equidistant from square). */
export function snapToNearestPreset(size: string): string {
  const match = /^(\d+)x(\d+)$/.exec(size)
  if (!match) return '1024x1024'
  const ratio = Number(match[1]) / Number(match[2])
  let best = '1024x1024'
  let bestDiff = Number.POSITIVE_INFINITY
  for (const preset of SIZE_PRESETS) {
    if (preset === 'auto') continue
    const [w, h] = preset.split('x').map(Number) as [number, number]
    const diff = Math.abs(Math.log(ratio) - Math.log(w / h))
    if (diff < bestDiff) {
      bestDiff = diff
      best = preset
    }
  }
  return best
}
