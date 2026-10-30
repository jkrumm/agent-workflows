// The door's translation between the studio's wire shapes (snake_case, `contract.ts`) and the capabilities' own types
// (`image.generate`'s `requestImages`, `image.enhance`): requests in, envelopes and failures out. Pure; no I/O.
import {
  CapabilityCallError,
  CapabilityError,
  type EnhanceOutput,
  type EnhanceParams,
  type ImageRequest,
  type ImageResult,
  MODEL_CAPABILITIES,
  pickRoute,
  routingWhy,
  validateSize,
} from '@agent-workflows/capabilities'
import {
  type Cost,
  type EditRequest,
  type ErrorBody,
  type GenerateRequest,
  type GenerateResponse,
  IMAGE_MODELS,
  type ImageModel,
  type PlanRequest,
  type PlanResponse,
  type StreamEvent,
} from './contract.ts'

/** The capabilities' name for a model the studio names by id: `flare`, `sunburst`, or `auto` (also for the retired id). */
export function modelChoice(
  model: GenerateRequest['model'] | NonNullable<PlanRequest['overrides']>['model'],
): NonNullable<ImageRequest['model']> {
  if (model === IMAGE_MODELS[0]) return 'flare'
  if (model === IMAGE_MODELS[1]) return 'sunburst'
  return 'auto'
}

/** The studio's model id for a seat: what the response's `model` says, whatever the route table maps the seat to. */
export function studioModel(seat: ReturnType<typeof pickRoute>): ImageModel {
  return seat === 'image.flare' ? IMAGE_MODELS[0] : IMAGE_MODELS[1]
}

const studioChoice = (choice: 'flare' | 'sunburst'): ImageModel =>
  choice === 'flare' ? IMAGE_MODELS[0] : IMAGE_MODELS[1]

type Fields = GenerateRequest | EditRequest

/**
 * The rules the studio's routes check before any work, in its order: size for the resolved model, a transparent
 * background needs an output format with alpha, `input_fidelity` only where the model takes it. A message, or null.
 */
export function ruleError(fields: Fields, edit: boolean): string | null {
  const sizeError = validateSize(fields.size)
  if (sizeError) return sizeError
  if (fields.background === 'transparent' && fields.output_format === 'jpeg') {
    return 'a transparent background needs png or webp output — jpeg has no alpha channel'
  }
  const fidelity = 'input_fidelity' in fields ? fields.input_fidelity : undefined
  if (fidelity === undefined) return null
  const seat = pickRoute(modelChoice(fields.model), fields.quality, edit)
  if (MODEL_CAPABILITIES[seat].inputFidelity) return null
  return `${studioModel(seat)} does not support input_fidelity (it is always high)`
}

/** The request `requestImages` takes: the studio's fields as they are, the references and mask as bytes. */
export function imageRequest(fields: Fields, files: Pick<ImageRequest, 'references' | 'mask'> = {}): ImageRequest {
  return {
    prompt: fields.prompt,
    size: fields.size,
    n: fields.n,
    quality: fields.quality,
    model: modelChoice(fields.model),
    background: fields.background,
    output_format: fields.output_format,
    ...(fields.output_compression !== undefined ? { output_compression: fields.output_compression } : {}),
    moderation: fields.moderation,
    ...('input_fidelity' in fields && fields.input_fidelity !== undefined
      ? { input_fidelity: fields.input_fidelity }
      : {}),
    partial_images: fields.partial_images,
    ...files,
  }
}

/** The studio's cost: `computed` for a priced call, `none` when no price was known. */
export const studioCost = (cost: ImageResult['cost']): Cost =>
  cost.usd === null ? { usd: null, source: 'none' } : { usd: cost.usd, source: 'computed' }

/** The studio's reason for a routed request: `auto` names the target, the retired id also says it is retired. */
function routingReason(fields: Fields, model: ImageModel, edit: boolean): string | undefined {
  if (fields.model !== 'auto' && fields.model !== 'gpt-image-2') return undefined
  const why = `routed to ${model} for ${routingWhy(edit, fields.quality)}`
  return fields.model === 'auto' ? why : `${fields.model} is retired — ${why}`
}

/** The envelope of `/generate` and `/edit`, and of the final `completed` frame. */
export function generateEnvelope(result: ImageResult, fields: Fields): GenerateResponse {
  const model = studioModel(pickRoute(modelChoice(fields.model), fields.quality, result.edit))
  const reason = routingReason(fields, model, result.edit)
  return {
    id: result.id,
    created: result.created,
    model,
    requested_model: fields.model,
    routed: reason !== undefined,
    ...(reason !== undefined ? { routing_reason: reason } : {}),
    images: result.images.map((image) => ({ b64_json: image.b64, format: image.format })),
    size: result.size,
    quality: result.quality,
    background: result.background,
    usage: result.usage,
    cost: studioCost(result.cost),
    latency_ms: result.latencyMs,
  }
}

/** The planner's input from the studio's plan request. */
export function planToEnhance(request: PlanRequest): EnhanceParams {
  const { overrides, style_guide: style } = request
  return {
    ...(request.brief !== undefined ? { brief: request.brief } : {}),
    ...(request.current_prompt !== undefined ? { currentPrompt: request.current_prompt } : {}),
    ...(request.delta !== undefined ? { delta: request.delta } : {}),
    hasReferences: request.has_references,
    intent: request.intent,
    mode: request.mode,
    ...(overrides
      ? {
          overrides: {
            ...(overrides.model !== undefined ? { model: modelChoice(overrides.model) } : {}),
            ...(overrides.size !== undefined ? { size: overrides.size } : {}),
            ...(overrides.quality !== undefined ? { quality: overrides.quality } : {}),
            ...(overrides.background !== undefined ? { background: overrides.background } : {}),
            ...(overrides.n !== undefined ? { n: overrides.n } : {}),
            ...(overrides.moderation !== undefined ? { moderation: overrides.moderation } : {}),
            ...(overrides.input_fidelity !== undefined ? { inputFidelity: overrides.input_fidelity } : {}),
            ...(overrides.partial_images !== undefined ? { partialImages: overrides.partial_images } : {}),
          },
        }
      : {}),
    ...(style
      ? {
          styleGuide: {
            promptFragment: style.prompt_fragment,
            palette: style.palette,
            avoid: style.avoid,
            refImageCount: style.ref_image_count,
          },
        }
      : {}),
    seriesContext: request.series_context,
    preserveList: request.preserve_list,
  }
}

/** The plan response of the studio's contract. A planner with no price for its seat reports 0, as the studio's own unpriced plans read. */
export function planResponse(plan: EnhanceOutput): PlanResponse {
  const { settings } = plan
  return {
    intent: plan.intent,
    prompt: plan.prompt,
    additions: plan.additions,
    verbatim_check: plan.verbatimCheck,
    assumptions: plan.assumptions,
    settings: {
      endpoint: settings.endpoint,
      model: studioChoice(settings.model),
      size: settings.size,
      quality: settings.quality,
      background: settings.background,
      n: settings.n,
      moderation: settings.moderation,
      ...(settings.inputFidelity !== undefined ? { input_fidelity: settings.inputFidelity } : {}),
      partial_images: settings.partialImages,
    },
    estimated_cost: plan.estimatedCost
      ? { per_image_usd: plan.estimatedCost.perImageUsd, total_usd: plan.estimatedCost.totalUsd }
      : { per_image_usd: 0, total_usd: 0 },
    warnings: plan.warnings,
    mode_applied: plan.modeApplied,
    playbook_version: plan.playbookVersion,
    enhance_model: plan.enhanceModel,
  }
}

/** One SSE frame as the studio's client reads it: `data: <json>\n\n`. */
export const sseFrame = (event: StreamEvent): Uint8Array =>
  new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)

/** What a failed request answers: the status and the studio's error envelope. */
export interface Failure {
  status: number
  body: ErrorBody
  /** What the client is not told (a transport failure's text): the caller logs it with the run id. */
  detail?: string
}

export const doorFailure = (status: number, message: string, type: string): Failure => ({
  status,
  body: { error: { message, type } },
})

interface Typed {
  code: string
  message: string
  data?: unknown
}

const typedOf = (error: unknown): Typed | null =>
  error instanceof CapabilityError || error instanceof CapabilityCallError
    ? { code: error.code, message: error.message, data: error.data }
    : null

/**
 * A failed upstream call or planner run as the studio's gateway answered it: a refused request is a 400, an upstream
 * failure a 502 `upstream_error` whose message is the vendor's own, a moderation block also carries its `code` and
 * `moderation_details` (stage and categories) so the app can word the recovery; anything unexpected is an opaque 500.
 */
export function failureOf(error: unknown): Failure {
  const typed = typedOf(error)
  if (!typed) return doorFailure(500, 'internal error', 'proxy_error')
  switch (typed.code) {
    case 'INVALID_INPUT':
    case 'URL_REFUSED':
      return doorFailure(400, typed.message, 'invalid_request_error')
    case 'NOT_CONFIGURED':
      return doorFailure(503, 'the image service is not configured', 'proxy_error')
    case 'CANCELLED':
      return doorFailure(503, 'the request was cancelled', 'proxy_error')
    case 'UPSTREAM_ERROR':
    case 'INVALID_OUTPUT':
    case 'OUTPUT_TRUNCATED': {
      const data = typed.data as
        | {
            transport?: true
            userError?: { message: string; code?: string; moderation?: { stage?: string; categories?: string[] } }
          }
        | undefined
      // The client library's text of a failed connection (a host, a port, a reset) is not for the app: a generic message,
      // the text kept for the log.
      if (data?.transport) {
        return { ...doorFailure(502, 'upstream unavailable', 'upstream_error'), detail: typed.message }
      }
      const user = data?.userError
      const message = user?.message ?? typed.message
      if (user?.code === 'moderation_blocked' && user.moderation) {
        return {
          status: 502,
          body: {
            error: {
              message,
              type: 'upstream_error',
              code: user.code,
              moderation_details: {
                moderation_stage: user.moderation.stage ?? 'unknown',
                categories: user.moderation.categories ?? [],
              },
            },
          },
        }
      }
      return doorFailure(502, message, 'upstream_error')
    }
    default:
      return doorFailure(500, 'internal error', 'proxy_error')
  }
}
