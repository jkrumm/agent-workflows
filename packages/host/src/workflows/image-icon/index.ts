import { mkdirSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { defineWorkflow, type StepScope, WorkflowError } from '@agent-workflows/runtime'
import { type ArtifactOptions, artifactDir } from '../../artifacts.ts'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import { readImageSource, rasterizeSvg } from '../image-source.ts'
import { CARD_HEIGHT, CARD_WIDTH, renderCard } from './card.ts'
import {
  assertCutoutReachable,
  buildMaster,
  CUTOUT_INPUT_MAX_EDGE,
  cleanVectorized,
  decodeRgba,
  encodePng,
  ICONS_MANIFEST,
  iconsHtml,
  lacksTransparency,
  optimizeAuthoredSvg,
  prepareCutoutInput,
  renderRasters,
  SVG_MAX_BYTES,
  upscaleScale,
  vectorizeInput,
} from './pipeline.ts'
import { imageIconScorer } from './scorer.ts'
import { detectTile } from './tile.ts'
import {
  type IconFileValue,
  ImageIconInput,
  type ImageIconInputValue,
  ImageIconOutput,
  type ImageIconOutputValue,
} from './schema.ts'

const IMAGE_ICON_VERSION = '2026-11-20.1'

/** The registry the workflow calls: the host's, typed by the image capabilities it holds. */
export type ImageIconCaller = Pick<HostRegistry, 'call'>

type Cost = { usd: number | null; source: 'provider' | 'rate' | 'unknown' }
type ModelStep = { model: string; cost: Cost; latencyMs: number }

/** `faviconSvgPath`: the optimised SVG the master (or the flat source) was given as, which becomes favicon.svg without a model. */
type PrepareResult = { scale: number | null; sourcePath: string; flatPath?: string; faviconSvgPath?: string }
type UpscaleResult = ModelStep & { path: string }
type CutoutResult = { ran: false; path: string } | ({ ran: true; path: string } & ModelStep)
type RenderResult = {
  masterPath: string
  /** The flat source's master, when `flat` was given: it drives the ico and the vectorize input. */
  smallPath?: string
  tile: boolean
  assets: IconFileValue[]
  card?: IconFileValue
}
type FaviconSvg = { file: IconFileValue } | { skippedReason: string }
type VectorizeResult = ModelStep & FaviconSvg

type Billed = { step: string; usd: number | null }

/** `usd` summed to micro-dollars: the prices are 3-decimal figures, a float sum must not leak into the output. */
const sumUsd = (values: number[]) => Number(values.reduce((sum, usd) => sum + usd, 0).toFixed(6))

function describeBilled(billed: Billed[]): string {
  const parts = billed.map(({ step, usd }) => `${step} ${usd === null ? 'cost unknown' : `$${usd}`}`)
  const total = billed.some(({ usd }) => usd === null)
    ? 'total unknown'
    : `$${sumUsd(billed.map(({ usd }) => usd ?? 0))}`
  return `${parts.join(', ')}; total ${total}`
}

/** The same failure, saying which model steps the run had already paid for (their cost is on the run either way). */
function withBilled(error: unknown, billed: Billed[]): Error {
  if (billed.length === 0) return error instanceof Error ? error : new Error(String(error))
  const message = error instanceof Error ? error.message : String(error)
  return new WorkflowError(
    error instanceof WorkflowError ? error.kind : 'error',
    `${message} (already billed: ${describeBilled(billed)})`,
    { cause: error },
  )
}

async function afterBilled<T>(billed: Billed[], work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw withBilled(error, billed)
  }
}

/** One file through a temp file and a rename, so it is whole or absent. */
async function writeFile(path: string, bytes: Uint8Array | string): Promise<void> {
  const temp = `${path}.tmp`
  await Bun.write(temp, bytes)
  await rename(temp, path)
}

const decodeBase64 = (b64: string) => Buffer.from(b64, 'base64')

/** A source image as the pixels the pipeline reads; an SVG is rendered at 1024 px and its text is kept for the favicon. */
async function loadSource(path: string): Promise<{ pixels: Uint8Array; svg?: Uint8Array }> {
  const source = await readImageSource(path)
  return source.kind === 'svg'
    ? { pixels: await rasterizeSvg(source.bytes), svg: source.bytes }
    : { pixels: source.bytes }
}

/** What every step needs: the registry, the validated input and where the run keeps its files. */
interface IconRun {
  registry: ImageIconCaller
  input: ImageIconInputValue
  dir: () => string
  workDir: () => string
}

const billedSoFar = (upscaled?: UpscaleResult, cutOut?: CutoutResult): Billed[] => [
  ...(upscaled ? [{ step: 'upscale', usd: upscaled.cost.usd }] : []),
  ...(cutOut?.ran ? [{ step: 'cutout', usd: cutOut.cost.usd }] : []),
]

const listing = (
  { dir }: IconRun,
  file: { name: string; mime: string; width: number; height: number; bytes: Uint8Array },
) => ({
  name: file.name,
  path: join(dir(), file.name),
  mime: file.mime,
  width: file.width,
  height: file.height,
  bytes: file.bytes.byteLength,
})

async function prepareStep({ input, workDir }: IconRun): Promise<PrepareResult> {
  if (input.cardLine !== undefined && input.cardTitle === undefined) {
    throw new WorkflowError('invalid_input', 'cardLine needs a cardTitle')
  }
  const master = await loadSource(input.file)
  const rgba = await decodeRgba(master.pixels)
  const scale = upscaleScale(input.upscale, rgba)
  assertCutoutReachable({ rgba, scale, cutout: input.cutout })
  const sourcePath = join(workDir(), 'source.png')
  await writeFile(sourcePath, await encodePng(rgba))
  // The favicon comes from the flat source when there is one, else from the master.
  const flat = input.flat ? await loadSource(input.flat) : undefined
  const faviconSvg = input.svg === 'auto' ? (flat ? flat.svg : master.svg) : undefined
  // Optimised here, not at the publish step, so an SVG that cannot be published fails before anything is billed.
  const faviconSvgPath = faviconSvg ? join(workDir(), 'favicon-source.svg') : undefined
  if (faviconSvg && faviconSvgPath) {
    await writeFile(faviconSvgPath, optimizeAuthoredSvg(Buffer.from(faviconSvg).toString('utf8')))
  }
  const svgPart = faviconSvgPath ? { faviconSvgPath } : {}
  if (!flat) return { scale, sourcePath, ...svgPart }
  const flatPath = join(workDir(), 'flat-source.png')
  await writeFile(flatPath, await encodePng(await decodeRgba(flat.pixels)))
  return { scale, sourcePath, flatPath, ...svgPart }
}

async function upscaleStep(
  { registry, workDir }: IconRun,
  { callContext }: StepScope,
  source: { scale: number; sourcePath: string },
): Promise<UpscaleResult> {
  const out = await registry.call('image.upscale', { file: source.sourcePath, scale: source.scale }, callContext)
  const path = join(workDir(), 'upscaled.png')
  await afterBilled([{ step: 'upscale', usd: out.cost.usd }], () => writeFile(path, decodeBase64(out.image.b64)))
  return { path, model: out.model, cost: out.cost, latencyMs: out.latencyMs }
}

async function cutoutStep(
  { registry, input, workDir }: IconRun,
  { callContext }: StepScope,
  imagePath: string,
  billed: Billed[],
): Promise<CutoutResult> {
  const bytes = await Bun.file(imagePath).bytes()
  const needed =
    input.cutout === 'always' || (input.cutout === 'auto' && lacksTransparency((await decodeRgba(bytes)).data))
  if (!needed) return { ran: false, path: imagePath }
  const inputPath = join(workDir(), 'cutout-input.png')
  await writeFile(inputPath, await prepareCutoutInput(bytes, { maxEdge: CUTOUT_INPUT_MAX_EDGE }))
  const out = await afterBilled(billed, () =>
    registry.call('image.cutout', { file: inputPath, model: input.cutoutModel }, callContext),
  )
  const path = join(workDir(), 'cutout.png')
  await afterBilled([...billed, { step: 'cutout', usd: out.cost.usd }], () =>
    writeFile(path, decodeBase64(out.image.b64)),
  )
  return { ran: true, path, model: out.model, cost: out.cost, latencyMs: out.latencyMs }
}

function renderStep(
  run: IconRun,
  source: { finalImage: string; flatPath?: string },
  billed: Billed[],
): Promise<RenderResult> {
  return afterBilled(billed, async () => {
    const { background, cardTitle, cardLine } = run.input
    const master = await buildMaster(await decodeRgba(await Bun.file(source.finalImage).bytes()))
    const masterPath = join(run.workDir(), 'master.png')
    await writeFile(masterPath, master)
    const small = source.flatPath
      ? await buildMaster(await decodeRgba(await Bun.file(source.flatPath).bytes()))
      : undefined
    const smallPath = small ? join(run.workDir(), 'small-master.png') : undefined
    if (small && smallPath) await writeFile(smallPath, small)

    const tile = await detectTile(master)
    const assets = [...(await renderRasters(master, background, small ? { small } : {}))]
    if (cardTitle) {
      const bytes = await renderCard({ master, tile, background, title: cardTitle, line: cardLine })
      assets.push({ name: 'og-image.png', mime: 'image/png', width: CARD_WIDTH, height: CARD_HEIGHT, bytes })
    }
    await Promise.all(assets.map((asset) => writeFile(join(run.dir(), asset.name), asset.bytes)))
    const listed = assets.map((asset) => listing(run, asset))
    const card = cardTitle ? listed.pop() : undefined
    return {
      masterPath,
      ...(smallPath ? { smallPath } : {}),
      tile: tile !== null,
      assets: listed,
      ...(card ? { card } : {}),
    }
  })
}

async function vectorizeStep(
  run: IconRun,
  { callContext }: StepScope,
  sourcePath: string,
  billed: Billed[],
): Promise<VectorizeResult> {
  const inputPath = join(run.workDir(), 'vectorize-input.png')
  await afterBilled(billed, async () =>
    writeFile(inputPath, await vectorizeInput(Buffer.from(await Bun.file(sourcePath).bytes()), run.input.background)),
  )
  const out = await afterBilled(billed, () => run.registry.call('image.vectorize', { file: inputPath }, callContext))
  const step = { model: out.model, cost: out.cost, latencyMs: out.latencyMs }
  return afterBilled([...billed, { step: 'vectorize', usd: out.cost.usd }], async () => ({
    ...step,
    ...(await publishFaviconSvg(
      run,
      Buffer.from(cleanVectorized(out.svg)),
      (kb) =>
        `vectorized SVG is ${kb} KB - art with gradients/photo detail does not vectorize well; raster favicons only`,
    )),
  }))
}

/** favicon.svg from the SVG the caller gave, already optimised by `prepare`: no model call and no cost. */
function faviconSvgStep(run: IconRun, svgPath: string, billed: Billed[]): Promise<FaviconSvg> {
  return afterBilled(billed, async () =>
    publishFaviconSvg(
      run,
      Buffer.from(await Bun.file(svgPath).bytes()),
      (kb) => `favicon SVG is ${kb} KB after svgo, over the ${SVG_MAX_BYTES / 1024} KB limit; raster favicons only`,
    ),
  )
}

/** Writes favicon.svg, or says why it is left out when it is over the size limit. */
async function publishFaviconSvg(run: IconRun, svg: Buffer, oversize: (kb: number) => string): Promise<FaviconSvg> {
  if (svg.byteLength > SVG_MAX_BYTES) return { skippedReason: oversize(Math.round(svg.byteLength / 1024)) }
  await writeFile(join(run.dir(), 'favicon.svg'), svg)
  // 0x0: an SVG has no intrinsic pixel size (its viewBox is its own coordinate space).
  return {
    file: listing(run, { name: 'favicon.svg', mime: 'image/svg+xml', width: 0, height: 0, bytes: svg }),
  }
}

/** The run's price: unknown if any step's is, else the sum, `rate` when no model step ran or any was priced by rate. */
function totalCost(costs: Cost[]): Cost {
  if (costs.some((cost) => cost.usd === null)) return { usd: null, source: 'unknown' }
  return {
    usd: sumUsd(costs.map((c) => c.usd ?? 0)),
    source: costs.length === 0 || costs.some((c) => c.source === 'rate') ? 'rate' : 'provider',
  }
}

type Results = {
  rendered: RenderResult
  upscaled?: UpscaleResult
  cutOut: CutoutResult
  vectorized?: VectorizeResult
  /** favicon.svg made from the SVG the caller gave: no model step. */
  authored?: FaviconSvg
}

/** The model steps that ran, in order. */
const ranSteps = ({ upscaled, cutOut, vectorized }: Results) => [
  ...(upscaled ? [{ step: 'upscale' as const, result: upscaled }] : []),
  ...(cutOut.ran ? [{ step: 'cutout' as const, result: cutOut }] : []),
  ...(vectorized ? [{ step: 'vectorize' as const, result: vectorized }] : []),
]

/** The icon files in listing order: the ico, then the svg when there is one, then the rasters and the card when made. */
function listFiles(
  assets: IconFileValue[],
  svgFile: IconFileValue | undefined,
  card: IconFileValue | undefined,
): IconFileValue[] {
  const [ico, ...rasters] = assets
  return [...(ico ? [ico] : []), ...(svgFile ? [svgFile] : []), ...rasters, ...(card ? [card] : [])]
}

/** Final assembly: deterministic from the journaled results of the steps. */
async function assemble(run: IconRun, started: number, results: Results): Promise<ImageIconOutputValue> {
  const { rendered } = results
  const { dir } = run
  const faviconSvg = results.authored ?? results.vectorized
  const svgFile = faviconSvg && 'file' in faviconSvg ? faviconSvg.file : undefined
  const { cardTitle, cardLine } = run.input
  const files = listFiles(rendered.assets, svgFile, rendered.card)
  const html = iconsHtml(
    svgFile !== undefined,
    rendered.card && cardTitle ? { title: cardTitle, ...(cardLine ? { line: cardLine } : {}) } : undefined,
  )
  const htmlPath = join(dir(), 'head.html')
  const manifestPath = join(dir(), 'manifest.webmanifest')
  await writeFile(htmlPath, `${html}\n`)
  await writeFile(manifestPath, `${JSON.stringify(ICONS_MANIFEST, null, 2)}\n`)

  const ran = ranSteps(results)
  const skippedReason = faviconSvg && 'skippedReason' in faviconSvg ? faviconSvg.skippedReason : undefined

  return ImageIconOutput.parse({
    dir: dir(),
    workDir: run.workDir(),
    files,
    html,
    htmlPath,
    manifest: ICONS_MANIFEST,
    manifestPath,
    tile: rendered.tile,
    steps: ran.map(({ step, result }) => ({
      step,
      model: result.model,
      costUsd: result.cost.usd,
      latencyMs: result.latencyMs,
    })),
    ...(skippedReason ? { svgSkippedReason: skippedReason } : {}),
    cost: totalCost(ran.map(({ result }) => result.cost)),
    latencyMs: Date.now() - started,
  })
}

/**
 * `image-icon`: a full icon set from one master image, the outputs of the retired image-gateway's `/icons`. The
 * pipeline (`pipeline.ts`) is pure sharp + svgo; the three Replicate steps (upscale, cutout, vectorize) are capability
 * calls, each recording its own price. Intermediates live in `<run dir>/work/`, the icon files in `<run dir>/`; the
 * steps journal paths and small facts, never pixels. The command is `image-icon`, not `image icon`: the host refuses a
 * command that is a prefix of another, and `agw image` exists.
 */
export function createImageIconWorkflows(
  deps: { registry: ImageIconCaller },
  options: { artifacts?: ArtifactOptions } = {},
): HostWorkflow[] {
  const imageIcon = defineWorkflow({
    id: 'image-icon',
    version: IMAGE_ICON_VERSION,
    input: ImageIconInput,
    output: ImageIconOutput,
    scorer: imageIconScorer,
    async run(ctx, input: ImageIconInputValue): Promise<ImageIconOutputValue> {
      const started = Date.now()
      const dir = () => artifactDir('image-icon', ctx.runId, options.artifacts)
      const workDir = () => {
        const work = join(dir(), 'work')
        mkdirSync(work, { recursive: true, mode: 0o700 })
        return work
      }
      const run: IconRun = { registry: deps.registry, input, dir, workDir }

      const prepared = await ctx.step('prepare', () => prepareStep(run))

      let upscaled: UpscaleResult | undefined
      let imagePath = prepared.sourcePath
      if (prepared.scale !== null) {
        const source = { scale: prepared.scale, sourcePath: prepared.sourcePath }
        upscaled = await ctx.step('upscale', (scope: StepScope) => upscaleStep(run, scope, source))
        imagePath = upscaled.path
      }

      const sourceImage = imagePath
      const cutOut = await ctx.step('cutout', (scope: StepScope) =>
        cutoutStep(run, scope, sourceImage, billedSoFar(upscaled)),
      )

      const billed = billedSoFar(upscaled, cutOut)
      const rendered = await ctx.step('render', () =>
        renderStep(run, { finalImage: cutOut.path, flatPath: prepared.flatPath }, billed),
      )

      const { faviconSvgPath } = prepared
      const authored =
        input.svg === 'auto' && faviconSvgPath
          ? await ctx.step('favicon-svg', () => faviconSvgStep(run, faviconSvgPath, billed))
          : undefined
      const vectorized =
        input.svg === 'auto' && !faviconSvgPath
          ? await ctx.step('vectorize', (scope: StepScope) =>
              vectorizeStep(run, scope, rendered.smallPath ?? rendered.masterPath, billed),
            )
          : undefined

      return assemble(run, started, { rendered, upscaled, cutOut, vectorized, authored })
    },
  })

  return [
    {
      workflow: imageIcon,
      summary:
        'Build a full icon set (favicon.ico and .svg, PWA, maskable, apple-touch, 1024 and AppIcon.icns, head tags and manifest) from one master image (png, jpeg, webp or svg), and optionally a social card (og-image.png); a master on a rounded tile runs full bleed with the icns on the macOS grid, --flat takes a flat derivative for the favicon; upscales, cuts out and vectorizes with Replicate where a raster needs it (an SVG is rasterised at 1024 px and, as master or flat, is optimised into favicon.svg for free), and lists the files in the artifact store',
      cli: { positional: ['file'], defaultFormat: 'json' },
    },
  ]
}
