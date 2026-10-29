/**
 * Image size rules, ported from image-gateway `shared/src/rules.ts` (`validateSizeForModel`, `snapSizeForModel`). Both
 * generation models take any `WxH` inside one envelope, so the rule is not per model here; gpt-image-2.5's `auto` size can
 * answer a dimension outside it (a 1024 reference produced 1254x1254), which is why a recorded size must be snapped back.
 */
export const SIZE_PRESETS = ['auto', '1024x1024', '1536x1024', '1024x1536'] as const

export const SIZE_ENVELOPE = {
  edgeMultiple: 16,
  maxRatio: 3,
  minPixels: 655_360,
  maxPixels: 8_294_400,
  maxEdge: 3839,
} as const

const SIZE_PATTERN = /^(\d{2,4})x(\d{2,4})$/

/** An error message, or null when `size` is `auto`, a preset or a `WxH` inside the envelope. */
export function validateSize(size: string): string | null {
  if ((SIZE_PRESETS as readonly string[]).includes(size)) return null
  const match = SIZE_PATTERN.exec(size)
  if (!match) return "size must be 'auto', a preset, or 'WxH'"
  const width = Number(match[1])
  const height = Number(match[2])
  const { edgeMultiple, maxRatio, minPixels, maxPixels, maxEdge } = SIZE_ENVELOPE
  if (width % edgeMultiple !== 0 || height % edgeMultiple !== 0) {
    return `width and height must be multiples of ${edgeMultiple}`
  }
  if (width > maxEdge || height > maxEdge) return `width and height must not exceed ${maxEdge}px`
  if (Math.max(width, height) / Math.min(width, height) > maxRatio) {
    return `aspect ratio must not exceed ${maxRatio}:1`
  }
  const pixels = width * height
  if (pixels < minPixels || pixels > maxPixels) return `total pixel count must be between ${minPixels} and ${maxPixels}`
  return null
}

/**
 * Scales the ideal (fractional) shape into the envelope, then rounds to the edge multiple. Floor-rounding is preferred
 * (it never overshoots maxEdge/maxPixels); ceil is the fallback when flooring undershoots minPixels. Independent per-axis
 * rounding can push the ratio past maxRatio, so a repair pass grows the shorter edge, then a final clamp guards the
 * unlikely overshoot. image-gateway proves the function by property test over ~400k inputs.
 */
function snapToEnvelope(width: number, height: number): string {
  const { edgeMultiple, maxRatio, minPixels, maxPixels, maxEdge } = SIZE_ENVELOPE
  let w = Math.max(width, 1)
  let h = Math.max(height, 1)
  if (w / h > maxRatio) w = h * maxRatio
  else if (h / w > maxRatio) h = w * maxRatio

  const downscale = Math.min(1, maxEdge / Math.max(w, h), Math.sqrt(maxPixels / (w * h)))
  w *= downscale
  h *= downscale
  if (w * h < minPixels) {
    const upscale = Math.sqrt(minPixels / (w * h))
    w *= upscale
    h *= upscale
  }

  let rw = Math.max(edgeMultiple, Math.floor(w / edgeMultiple) * edgeMultiple)
  let rh = Math.max(edgeMultiple, Math.floor(h / edgeMultiple) * edgeMultiple)
  if (rw * rh < minPixels) {
    rw = Math.max(edgeMultiple, Math.ceil(w / edgeMultiple) * edgeMultiple)
    rh = Math.max(edgeMultiple, Math.ceil(h / edgeMultiple) * edgeMultiple)
  }

  if (rw / rh > maxRatio) rh = Math.ceil(rw / maxRatio / edgeMultiple) * edgeMultiple
  else if (rh / rw > maxRatio) rw = Math.ceil(rh / maxRatio / edgeMultiple) * edgeMultiple

  if (rw > maxEdge) rw = Math.floor(maxEdge / edgeMultiple) * edgeMultiple
  if (rh > maxEdge) rh = Math.floor(maxEdge / edgeMultiple) * edgeMultiple
  if (rw * rh > maxPixels) {
    const scale = Math.sqrt(maxPixels / (rw * rh))
    rw = Math.floor((rw * scale) / edgeMultiple) * edgeMultiple
    rh = Math.floor((rh * scale) / edgeMultiple) * edgeMultiple
  }
  return `${rw}x${rh}`
}

/** `size` coerced into one the endpoint accepts: `auto`, presets and valid sizes unchanged, any other `WxH` snapped into the envelope, unparseable input `auto`. */
export function snapSize(size: string): string {
  if (validateSize(size) === null) return size
  const match = SIZE_PATTERN.exec(size)
  if (!match) return 'auto'
  return snapToEnvelope(Number(match[1]), Number(match[2]))
}
