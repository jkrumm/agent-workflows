import { WorkflowError } from '@agent-workflows/runtime'
import sharp from 'sharp'
import { optimize } from 'svgo'
import { encodeIcns, encodeIco, ICNS_SIZES, ICNS_TYPES } from './containers.ts'

/**
 * The deterministic half of the icon-set pipeline, ported from the retired image-gateway's `/icons`:
 * master artwork in, every web + macOS + store icon out. Pure and network-free; the workflow runs
 * the Replicate calls (upscale, cutout, vectorize) as separate journaled steps and calls these
 * functions between them. Order: upscale -> cutout -> clean/trim/master -> rasters -> vectorize.
 *
 * Padding is the empty margin on each side as a fraction of the canvas, tuned per target: tight
 * for browser chrome, looser where the OS crops or frames the icon. All of it lives here.
 */
const PADDING = {
  favicon: 0.04,
  pwa: 0.06,
  appleTouch: 0.12,
  appStore: 0.1,
  icns: 0.1,
} as const

/** The maskable safe zone: a centered 409px box (80%) inside the 512px icon-mask canvas. */
export const MASKABLE_BOX = 409

/** Cutout input is downscaled to this long edge first - the icons never need more resolution. */
export const CUTOUT_INPUT_MAX_EDGE = 1536

/** recraft's documented cutout input limits; a violation is a clear error instead of an upstream failure. */
const CUTOUT_LIMITS = {
  maxImageBytes: 5 * 1024 * 1024,
  maxPixels: 16_000_000,
  minEdge: 256,
  maxEdge: 4096,
} as const

/** Caller bytes decode only up to this many pixels (sharp's own default is 268 MP); a larger image is `invalid_input`. */
const SOURCE_MAX_PIXELS = 64_000_000

/** The master is a square of the trimmed subject's long side; a larger subject is refused before the canvas is built. */
const MASTER_MAX_SIDE = 8192

/** Below this alpha a pixel is treated as fully transparent (recraft's "transparent" is alpha=1). */
const ALPHA_FLOOR = 8

/** `auto` treats an image as already cut out when ANY pixel is below this alpha. */
const OPAQUE_ALPHA = 250

/** `upscale: auto` runs when the long edge is under this; real-esrgan then makes it 4x (8x under 128). */
const UPSCALE_BELOW_EDGE = 512
const UPSCALE_X8_BELOW_EDGE = 128

/** real-esrgan's recommended maximum input (~1440p); `upscale: always` refuses anything larger. */
export const UPSCALE_MAX_INPUT_EDGE = 1440

/** The master is rendered at this size (with favicon padding) as the vectorize input. */
const VECTORIZE_SIZE = 1024

/** A larger SVG is omitted: browsers prefer the SVG icon, so a bloated one is worse than none. */
export const SVG_MAX_BYTES = 64 * 1024

const FAVICON_SIZES = [16, 32, 48] as const

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 }

export type UpscaleMode = 'auto' | 'always' | 'never'

export interface Rgba {
  data: Buffer
  width: number
  height: number
}

export interface IconAsset {
  name: string
  mime: string
  width: number
  height: number
  bytes: Buffer
}

export interface IconsManifest {
  icons: { src: string; sizes: string; type: string; purpose?: string }[]
}

/**
 * The ICO keeps `sizes="32x32"`: without it Chrome prefers the ICO over the SVG icon. The SVG link
 * exists only when `favicon.svg` was actually emitted.
 */
export const iconsHtml = (withSvg: boolean): string =>
  [
    '<link rel="icon" href="/favicon.ico" sizes="32x32">',
    ...(withSvg ? ['<link rel="icon" href="/favicon.svg" type="image/svg+xml">'] : []),
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/manifest.webmanifest">',
  ].join('\n')

export const ICONS_MANIFEST: IconsManifest = {
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icon-mask.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}

/** `sharp` on bytes from the caller, under the source pixel limit. */
const sharpSource = (bytes: Uint8Array) => sharp(bytes, { limitInputPixels: SOURCE_MAX_PIXELS })

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Decode any supported image into straight sRGB RGBA, applying EXIF orientation. */
export async function decodeRgba(bytes: Uint8Array): Promise<Rgba> {
  try {
    const { data, info } = await sharpSource(bytes)
      .rotate()
      .toColourspace('srgb')
      .ensureAlpha()
      .raw({ depth: 'uchar' })
      .toBuffer({ resolveWithObject: true })
    if (info.channels !== 4) throw new Error(`expected 4 channels, got ${info.channels}`)
    return { data, width: info.width, height: info.height }
  } catch (err) {
    throw new WorkflowError('invalid_input', `unreadable image: ${reason(err)}`, { cause: err })
  }
}

/** True when the image carries no real transparency (no alpha channel, or all alpha >= 250). */
export function lacksTransparency(data: Buffer): boolean {
  for (let i = 3; i < data.length; i += 4) {
    if ((data[i] ?? 255) < OPAQUE_ALPHA) return false
  }
  return true
}

/** The scale to upscale by, or null to skip. `always` is refused above real-esrgan's input limit. */
export function upscaleScale(mode: UpscaleMode, { width, height }: Rgba): number | null {
  if (mode === 'never') return null
  const longEdge = Math.max(width, height)
  if (mode === 'auto' && longEdge >= UPSCALE_BELOW_EDGE) return null
  if (longEdge > UPSCALE_MAX_INPUT_EDGE) {
    throw new WorkflowError(
      'invalid_input',
      `image long edge is ${longEdge}px; upscaling accepts at most ${UPSCALE_MAX_INPUT_EDGE}px (use upscale: never)`,
    )
  }
  return longEdge < UPSCALE_X8_BELOW_EDGE ? 8 : 4
}

/**
 * Refuses, before anything is billed, a run whose cutout would be rejected for size: the image the cutout gets is the
 * source scaled by the upscale, and recraft needs a short edge of at least `CUTOUT_LIMITS.minEdge`.
 */
export function assertCutoutReachable(args: { rgba: Rgba; scale: number | null; cutout: 'auto' | 'always' | 'never' }) {
  const { rgba, scale, cutout } = args
  const needed = cutout === 'always' || (cutout === 'auto' && lacksTransparency(rgba.data))
  if (!needed) return
  const edge = Math.min(rgba.width, rgba.height) * (scale ?? 1)
  if (edge >= CUTOUT_LIMITS.minEdge) return
  throw new WorkflowError(
    'invalid_input',
    `the cutout needs a short edge of at least ${CUTOUT_LIMITS.minEdge}px but this image would be ${edge}px after the upscale; use --cutout never or a larger source`,
  )
}

export const encodePng = (rgba: Rgba): Promise<Buffer> =>
  sharp(rgba.data, { raw: { width: rgba.width, height: rgba.height, channels: 4 } })
    .png()
    .toBuffer()

const isPng = (bytes: Uint8Array): boolean =>
  bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47

/** The sides a cutout is sent at, after the EXIF swap and the `maxEdge` downscale; a violation of recraft's limits throws. */
function cutoutSize(
  meta: { width?: number; height?: number; orientation?: number },
  maxEdge: number | undefined,
): { width: number; height: number; scale: number; swapped: boolean } {
  if (!meta.width || !meta.height) throw new WorkflowError('invalid_input', 'unreadable image')
  const swapped = (meta.orientation ?? 1) >= 5
  const width = swapped ? meta.height : meta.width
  const height = swapped ? meta.width : meta.height
  const longEdge = Math.max(width, height)
  const scale = maxEdge && longEdge > maxEdge ? maxEdge / longEdge : 1
  const out = { width: Math.round(width * scale), height: Math.round(height * scale), scale, swapped }
  assertCutoutLimits(out.width, out.height)
  return out
}

function assertCutoutLimits(width: number, height: number): void {
  if (Math.min(width, height) < CUTOUT_LIMITS.minEdge) {
    throw new WorkflowError('invalid_input', `image sides must be at least ${CUTOUT_LIMITS.minEdge}px for cutout`)
  }
  if (Math.max(width, height) > CUTOUT_LIMITS.maxEdge) {
    throw new WorkflowError('invalid_input', `image sides must be at most ${CUTOUT_LIMITS.maxEdge}px for cutout`)
  }
  if (width * height > CUTOUT_LIMITS.maxPixels) {
    throw new WorkflowError('invalid_input', `image must be at most ${CUTOUT_LIMITS.maxPixels} pixels for cutout`)
  }
}

/**
 * Normalise an image into the PNG the cutout models are sent, enforcing recraft's documented
 * limits (<=5 MB, <=16 MP, sides 256-4096 px). A PNG that already fits is passed through
 * byte-for-byte; anything else (or anything above `maxEdge`) is re-encoded, with EXIF orientation
 * applied.
 */
export async function prepareCutoutInput(bytes: Uint8Array, options: { maxEdge?: number } = {}): Promise<Buffer> {
  try {
    const { width, height, scale, swapped } = cutoutSize(await sharpSource(bytes).metadata(), options.maxEdge)
    const passthrough = scale === 1 && swapped === false && isPng(bytes)
    const png = passthrough
      ? Buffer.from(bytes)
      : await sharpSource(bytes).rotate().resize(width, height).png({ compressionLevel: 9 }).toBuffer()
    if (png.byteLength > CUTOUT_LIMITS.maxImageBytes) {
      throw new WorkflowError('invalid_input', `image must be at most ${CUTOUT_LIMITS.maxImageBytes} bytes for cutout`)
    }
    return png
  } catch (err) {
    if (err instanceof WorkflowError) throw err
    throw new WorkflowError('invalid_input', `unreadable image: ${reason(err)}`, { cause: err })
  }
}

/**
 * Zero near-transparent pixels in place (and their colour, so resampling can't bleed it), and
 * return the bounding box of what is left, or null when nothing is visible.
 */
function cleanAlphaAndBounds(rgba: Rgba): { left: number; top: number; width: number; height: number } | null {
  const { data, width, height } = rgba
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let pixel = 0; pixel < width * height; pixel++) {
    const i = pixel * 4
    if ((data[i + 3] ?? 0) < ALPHA_FLOOR) {
      data.fill(0, i, i + 4)
      continue
    }
    const x = pixel % width
    const y = (pixel - x) / width
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  if (maxX < 0) return null
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/** The trimmed subject centered on a square transparent canvas, as PNG. Cleans `rgba` in place. */
export async function buildMaster(rgba: Rgba): Promise<Buffer> {
  const bounds = cleanAlphaAndBounds(rgba)
  if (!bounds) throw new WorkflowError('invalid_input', 'image has no visible content')
  const side = Math.max(bounds.width, bounds.height)
  if (side > MASTER_MAX_SIDE) {
    throw new WorkflowError(
      'invalid_input',
      `the subject is ${bounds.width}x${bounds.height}px; the square master is at most ${MASTER_MAX_SIDE}px a side (downscale the image or crop it)`,
    )
  }

  const trimmed = await sharp(rgba.data, {
    raw: { width: rgba.width, height: rgba.height, channels: 4 },
  })
    .extract(bounds)
    .png()
    .toBuffer()

  const left = Math.floor((side - bounds.width) / 2)
  const top = Math.floor((side - bounds.height) / 2)
  return sharp(trimmed)
    .extend({
      top,
      bottom: side - bounds.height - top,
      left,
      right: side - bounds.width - left,
      background: TRANSPARENT,
    })
    .png()
    .toBuffer()
}

/**
 * Render the square master into a `size` canvas with the subject fit inside a centered
 * `box`x`box` square. With a `background` the result is flattened and fully opaque; without one
 * the margin stays transparent.
 */
async function renderIcon(args: { master: Buffer; size: number; box: number; background?: string }): Promise<Buffer> {
  const { master, size, box, background } = args
  const offset = Math.floor((size - box) / 2)
  const rest = size - box - offset
  let pipeline = sharp(master).resize(box, box)
  if (background) pipeline = pipeline.flatten({ background })
  return pipeline
    .extend({
      top: offset,
      bottom: rest,
      left: offset,
      right: rest,
      background: background ?? TRANSPARENT,
    })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

const boxFor = (size: number, padding: number): number => Math.round(size * (1 - 2 * padding))

async function pngAsset(args: {
  name: string
  master: Buffer
  size: number
  box: number
  background?: string
}): Promise<IconAsset> {
  const { name, size } = args
  return { name, mime: 'image/png', width: size, height: size, bytes: await renderIcon(args) }
}

/**
 * Every raster output from the square master, in the gateway's order: favicon.ico (16/32/48),
 * icon-192, icon-512, icon-mask, apple-touch-icon, icon-1024, AppIcon.icns. `background` fills the
 * OPAQUE targets only (icon-mask, apple-touch-icon, icon-1024).
 */
export async function renderRasters(master: Buffer, background: string): Promise<IconAsset[]> {
  const [icoFrames, icnsPngs, icon192, icon512, mask, apple, store] = await Promise.all([
    Promise.all(
      FAVICON_SIZES.map(async (size) => ({
        size,
        png: await renderIcon({ master, size, box: boxFor(size, PADDING.favicon) }),
      })),
    ),
    Promise.all(
      ICNS_SIZES.map(
        async (size) => [size, await renderIcon({ master, size, box: boxFor(size, PADDING.icns) })] as const,
      ),
    ),
    pngAsset({ name: 'icon-192.png', master, size: 192, box: boxFor(192, PADDING.pwa) }),
    pngAsset({ name: 'icon-512.png', master, size: 512, box: boxFor(512, PADDING.pwa) }),
    pngAsset({ name: 'icon-mask.png', master, size: 512, box: MASKABLE_BOX, background }),
    pngAsset({ name: 'apple-touch-icon.png', master, size: 180, box: boxFor(180, PADDING.appleTouch), background }),
    pngAsset({ name: 'icon-1024.png', master, size: 1024, box: boxFor(1024, PADDING.appStore), background }),
  ])

  const icnsBySize = new Map(icnsPngs)
  const icns = encodeIcns(
    ICNS_TYPES.map(({ type, size }) => {
      const png = icnsBySize.get(size)
      if (!png) throw new Error(`no ICNS render for ${size}px`)
      return { type, png }
    }),
  )

  return [
    { name: 'favicon.ico', mime: 'image/x-icon', width: 48, height: 48, bytes: encodeIco(icoFrames) },
    icon192,
    icon512,
    mask,
    apple,
    store,
    { name: 'AppIcon.icns', mime: 'image/icns', width: 1024, height: 1024, bytes: icns },
  ]
}

/** The vectorize input: the master on a 1024 canvas with transparent favicon padding. */
export const vectorizeInput = (master: Buffer): Promise<Buffer> =>
  renderIcon({ master, size: VECTORIZE_SIZE, box: boxFor(VECTORIZE_SIZE, PADDING.favicon) })

/** Markup that runs or embeds foreign content; the SVG is published under `public/`, so none of it may be written. */
const ACTIVE_SVG_CONTENT = /<script|<foreignObject|\son[a-z]+\s*=|javascript:/i

/**
 * recraft-vectorize emits a fixed `width`/`height`/`style` on the root and a no-op
 * `translate(0,0)` per path. Strip them (keep `viewBox`, so the icon scales), then let svgo shrink
 * the rest, dropping scripts and event handlers. Throws when active content survives or the result has no viewBox - it
 * would not scale as an icon.
 */
export function cleanVectorized(svg: string): string {
  const stripped = svg
    .replace(/<svg\b[^>]*>/, (root) =>
      root.replace(/\s(?:width|height|style|preserveAspectRatio)=(?:"[^"]*"|'[^']*')/g, ''),
    )
    .replace(/\s+transform="translate\(0,\s*0\)"/g, '')
  const optimized = optimize(stripped, { multipass: true, plugins: ['preset-default', 'removeScripts'] }).data
  if (ACTIVE_SVG_CONTENT.test(optimized)) throw new Error('vectorized SVG contains active content')
  if (!/<svg\b[^>]*\sviewBox=/.test(optimized)) throw new Error('vectorized SVG has no viewBox')
  return optimized
}
