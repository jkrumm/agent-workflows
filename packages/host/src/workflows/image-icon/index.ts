import { mkdirSync } from 'node:fs'
import { rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { defineWorkflow, type StepScope, WorkflowError } from '@agent-workflows/runtime'
import { type ArtifactOptions, artifactDir } from '../../artifacts.ts'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import {
  buildMaster,
  CUTOUT_INPUT_MAX_EDGE,
  cleanVectorized,
  decodeRgba,
  encodePng,
  ICONS_MANIFEST,
  iconsHtml,
  lacksTransparency,
  prepareCutoutInput,
  renderRasters,
  SVG_MAX_BYTES,
  upscaleScale,
  vectorizeInput,
} from './pipeline.ts'
import {
  type IconFileValue,
  ImageIconInput,
  type ImageIconInputValue,
  ImageIconOutput,
  type ImageIconOutputValue,
  MAX_SOURCE_BYTES,
} from './schema.ts'

const IMAGE_ICON_VERSION = '2026-10-30.1'

/** The registry the workflow calls: the host's, typed by the image capabilities it holds. */
export type ImageIconCaller = Pick<HostRegistry, 'call'>

type Cost = { usd: number | null; source: 'provider' | 'rate' | 'unknown' }
type ModelStep = { model: string; cost: Cost; latencyMs: number }

type PrepareResult = { scale: number | null; sourcePath: string }
type UpscaleResult = ModelStep & { path: string }
type CutoutResult = { ran: false; path: string } | ({ ran: true; path: string } & ModelStep)
type RenderResult = { masterPath: string; assets: IconFileValue[] }
type VectorizeResult = ModelStep & ({ file: IconFileValue } | { skippedReason: string })

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

const SOURCE_MAGIC = {
  png: (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  jpeg: (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b: Uint8Array) =>
    Buffer.from(b.subarray(0, 4)).toString('latin1') === 'RIFF' &&
    Buffer.from(b.subarray(8, 12)).toString('latin1') === 'WEBP',
}

/** The master image as bytes: a regular file within the size limit that is a PNG, JPEG or WebP by its first bytes. */
async function readSource(path: string): Promise<Uint8Array> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new WorkflowError('invalid_input', `no such file: ${path}`)
  if (info.size > MAX_SOURCE_BYTES) {
    throw new WorkflowError('invalid_input', `image is ${info.size} bytes, over the ${MAX_SOURCE_BYTES} byte limit`)
  }
  const bytes = await Bun.file(path).bytes()
  if (!Object.values(SOURCE_MAGIC).some((matches) => matches(bytes))) {
    throw new WorkflowError('invalid_input', `image must be png, jpeg or webp: ${path}`)
  }
  return bytes
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
  const rgba = await decodeRgba(await readSource(input.file))
  const scale = upscaleScale(input.upscale, rgba)
  const sourcePath = join(workDir(), 'source.png')
  await writeFile(sourcePath, await encodePng(rgba))
  return { scale, sourcePath }
}

async function upscaleStep(
  { registry, workDir }: IconRun,
  { addUsage, signal }: StepScope,
  source: { scale: number; sourcePath: string },
): Promise<UpscaleResult> {
  const out = await registry.call(
    'image.upscale',
    { file: source.sourcePath, scale: source.scale },
    { addUsage, signal },
  )
  const path = join(workDir(), 'upscaled.png')
  await afterBilled([{ step: 'upscale', usd: out.cost.usd }], () => writeFile(path, decodeBase64(out.image.b64)))
  return { path, model: out.model, cost: out.cost, latencyMs: out.latencyMs }
}

async function cutoutStep(
  { registry, input, workDir }: IconRun,
  { addUsage, signal }: StepScope,
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
    registry.call('image.cutout', { file: inputPath, model: input.cutoutModel }, { addUsage, signal }),
  )
  const path = join(workDir(), 'cutout.png')
  await afterBilled([...billed, { step: 'cutout', usd: out.cost.usd }], () =>
    writeFile(path, decodeBase64(out.image.b64)),
  )
  return { ran: true, path, model: out.model, cost: out.cost, latencyMs: out.latencyMs }
}

function renderStep(run: IconRun, finalImage: string, billed: Billed[]): Promise<RenderResult> {
  return afterBilled(billed, async () => {
    const master = await buildMaster(await decodeRgba(await Bun.file(finalImage).bytes()))
    const masterPath = join(run.workDir(), 'master.png')
    await writeFile(masterPath, master)
    const assets = await renderRasters(master, run.input.background)
    await Promise.all(assets.map((asset) => writeFile(join(run.dir(), asset.name), asset.bytes)))
    return { masterPath, assets: assets.map((asset) => listing(run, asset)) }
  })
}

async function vectorizeStep(
  run: IconRun,
  { addUsage, signal }: StepScope,
  masterPath: string,
  billed: Billed[],
): Promise<VectorizeResult> {
  const inputPath = join(run.workDir(), 'vectorize-input.png')
  await afterBilled(billed, async () =>
    writeFile(inputPath, await vectorizeInput(Buffer.from(await Bun.file(masterPath).bytes()))),
  )
  const out = await afterBilled(billed, () =>
    run.registry.call('image.vectorize', { file: inputPath }, { addUsage, signal }),
  )
  const step = { model: out.model, cost: out.cost, latencyMs: out.latencyMs }
  return afterBilled([...billed, { step: 'vectorize', usd: out.cost.usd }], async () => {
    const svg = Buffer.from(cleanVectorized(out.svg))
    if (svg.byteLength > SVG_MAX_BYTES) {
      return {
        ...step,
        skippedReason: `vectorized SVG is ${Math.round(svg.byteLength / 1024)} KB - art with gradients/photo detail does not vectorize well; raster favicons only`,
      }
    }
    await writeFile(join(run.dir(), 'favicon.svg'), svg)
    // 0x0: an SVG has no intrinsic pixel size (its viewBox is vectorize's own coordinate space).
    return {
      ...step,
      file: listing(run, { name: 'favicon.svg', mime: 'image/svg+xml', width: 0, height: 0, bytes: svg }),
    }
  })
}

/** The run's price: unknown if any step's is, else the sum, `rate` when no model step ran or any was priced by rate. */
function totalCost(costs: Cost[]): Cost {
  if (costs.some((cost) => cost.usd === null)) return { usd: null, source: 'unknown' }
  return {
    usd: sumUsd(costs.map((c) => c.usd ?? 0)),
    source: costs.length === 0 || costs.some((c) => c.source === 'rate') ? 'rate' : 'provider',
  }
}

type Results = { rendered: RenderResult; upscaled?: UpscaleResult; cutOut: CutoutResult; vectorized?: VectorizeResult }

/** The model steps that ran, in order. */
const ranSteps = ({ upscaled, cutOut, vectorized }: Results) => [
  ...(upscaled ? [{ step: 'upscale' as const, result: upscaled }] : []),
  ...(cutOut.ran ? [{ step: 'cutout' as const, result: cutOut }] : []),
  ...(vectorized ? [{ step: 'vectorize' as const, result: vectorized }] : []),
]

/** The icon files in listing order: the ico, then the svg when there is one, then the rasters. */
function listFiles(assets: IconFileValue[], svgFile: IconFileValue | undefined): IconFileValue[] {
  const [ico, ...rasters] = assets
  return [...(ico ? [ico] : []), ...(svgFile ? [svgFile] : []), ...rasters]
}

/** Final assembly: deterministic from the journaled results of the steps. */
async function assemble(run: IconRun, started: number, results: Results): Promise<ImageIconOutputValue> {
  const { rendered, vectorized } = results
  const { dir } = run
  const svgFile = vectorized && 'file' in vectorized ? vectorized.file : undefined
  const files = listFiles(rendered.assets, svgFile)
  const html = iconsHtml(svgFile !== undefined)
  const htmlPath = join(dir(), 'head.html')
  const manifestPath = join(dir(), 'manifest.webmanifest')
  await writeFile(htmlPath, `${html}\n`)
  await writeFile(manifestPath, `${JSON.stringify(ICONS_MANIFEST, null, 2)}\n`)

  const ran = ranSteps(results)
  const skippedReason = vectorized && 'skippedReason' in vectorized ? vectorized.skippedReason : undefined

  return ImageIconOutput.parse({
    dir: dir(),
    workDir: run.workDir(),
    files,
    html,
    htmlPath,
    manifest: ICONS_MANIFEST,
    manifestPath,
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
      const rendered = await ctx.step('render', () => renderStep(run, cutOut.path, billed))

      const vectorized =
        input.svg === 'auto'
          ? await ctx.step('vectorize', (scope: StepScope) => vectorizeStep(run, scope, rendered.masterPath, billed))
          : undefined

      return assemble(run, started, { rendered, upscaled, cutOut, vectorized })
    },
  })

  return [
    {
      workflow: imageIcon,
      summary:
        'Build a full icon set (favicon.ico and .svg, PWA, maskable, apple-touch, 1024 and AppIcon.icns, head tags and manifest) from one master image; upscales, cuts out and vectorizes with Replicate where the image needs it, and lists the files in the artifact store',
      cli: { positional: ['file'], defaultFormat: 'json' },
    },
  ]
}
