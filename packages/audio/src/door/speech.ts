import { errorMessage } from '../http.ts'
import { parseOutputFormat } from '../media/audio.ts'
import { AUDIO_DEFAULT_ROUTES, type AudioWire } from '../routes.pending.ts'
import { type AudioDeps, AudioScope, resolveDeps } from '../scope.ts'
import { DELIVERY_KEYS, isDeliveryKey } from '../speech/core.ts'
import { handleGeminiSpeech, type LaneResult } from '../speech/gemini.ts'
import { handleReplicateSpeech, replicateWantsPrep } from '../speech/replicate.ts'
import { callerOf, internalError, invalid, requestIdOf } from './common.ts'

const TTS_WIRES: readonly AudioWire[] = ['iu-gemini-tts', 'iu-replicate-tts']

/**
 * The TTS lane for a requested model: its route when the table has one on a TTS wire; anything else (empty, a typo,
 * an unknown id) is the default route. The door owns model choice, so a caller's wrong model never reaches upstream.
 */
export function resolveTtsRoute(scope: AudioScope, requested: string): { routeId: string; overridden: boolean } {
  const routeId = scope.routeIdForModel(requested, TTS_WIRES)
  if (routeId) return { routeId, overridden: false }
  return { routeId: AUDIO_DEFAULT_ROUTES.tts, overridden: requested.length > 0 }
}

interface SpeechBody {
  model: string
  input: string
  voice: string
  responseFormat: string
  summarize: boolean
  speed?: number
  instructions?: string
  language?: string
  stability?: number
  style?: number
  similarityBoost?: number
  delivery?: string
}

/** The OpenAI body plus legacy's extras. `style` is a NUMBER for ElevenLabs; a string `style` means `delivery`. */
function parseSpeechBody(json: Record<string, unknown>): SpeechBody {
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const numOf = (v: unknown) => (typeof v === 'number' ? v : undefined)
  // `lang_code` is what Hermes' OpenAI provider sends (tts.openai.language -> extra_body.lang_code).
  const delivery = json.delivery ?? (typeof json.style === 'string' ? json.style : undefined)
  const deliveryRaw =
    delivery === undefined || delivery === null
      ? undefined
      : typeof delivery === 'string'
        ? delivery.trim()
          ? delivery
          : undefined
        : String(delivery)
  const body: SpeechBody = {
    model: str(json.model) ?? '',
    input: str(json.input) ?? '',
    voice: str(json.voice) ?? '',
    responseFormat: str(json.response_format) ?? '',
    summarize: json.summarize === true,
  }
  const optional = {
    speed: numOf(json.speed),
    instructions: str(json.instructions),
    language: str(json.language ?? json.lang_code),
    stability: numOf(json.stability),
    style: numOf(json.style),
    similarityBoost: numOf(json.similarity_boost),
    delivery: deliveryRaw,
  }
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) Object.assign(body, { [key]: value })
  }
  return body
}

/**
 * `POST /v1/audio/speech`, OpenAI-compatible, as audio-gateway serves it: lane gemini or replicate by the requested
 * model's route; status codes, error bodies and `X-Audio-Title` unchanged. Every billed upstream call is
 * one usage event; the request ends with one `speech-request` event (a pcm stream: when its body ended).
 */
export function createSpeechHandler(deps: AudioDeps): (req: Request) => Promise<Response> {
  const resolved = resolveDeps(deps)
  return async (req) => {
    const scope = new AudioScope(resolved, requestIdOf(deps, req), callerOf(deps, req))
    try {
      return await dispatchSpeech(scope, req)
    } catch (error) {
      return internalError(scope, error)
    }
  }
}

async function dispatchSpeech(scope: AudioScope, req: Request): Promise<Response> {
  const requestStart = scope.deps.clock.now()
  let body: SpeechBody
  try {
    body = parseSpeechBody(JSON.parse(await req.text()) as Record<string, unknown>)
  } catch {
    // No blank-model usage event for a body that is not JSON.
    return invalid('request body must be valid JSON')
  }
  const responseFormat = parseOutputFormat(body.responseFormat)
  if (responseFormat === null) return invalid(`unsupported response_format: ${body.responseFormat}`)

  const { routeId, overridden } = resolveTtsRoute(scope, body.model)
  const route = scope.route(routeId)
  if (
    route.wire === 'iu-gemini-tts' &&
    body.delivery !== undefined &&
    !isDeliveryKey(body.delivery.trim().toLowerCase())
  ) {
    return invalid(`unsupported delivery "${body.delivery}" — expected one of: ${DELIVERY_KEYS.join(', ')}`)
  }
  if (overridden) {
    scope.log.warn('tts model overridden', { requested: body.model, used: route.model, caller: scope.caller })
  }

  // Whole-file clients (Slack auto-TTS) cannot ask for a summary: long text on a prep-off ElevenLabs model gets one.
  // pcm is a streaming client speaking one sentence at a time: never summarized.
  const { config } = scope
  const autoSummarize =
    !body.summarize &&
    route.wire === 'iu-replicate-tts' &&
    !replicateWantsPrep(scope, route.model) &&
    responseFormat !== 'pcm' &&
    config.ttsAutoSummarizeMinChars > 0 &&
    body.input.trim().length >= config.ttsAutoSummarizeMinChars
  const summarize = body.summarize || autoSummarize

  const summary = (status: number, errorText: string | null) => {
    const m = scope.meta
    scope.summary({
      endpoint: 'speech-request',
      routeId,
      model: route.model,
      requestedModel: body.model,
      status,
      latencyMs: scope.deps.clock.now() - requestStart,
      errorText,
      responseFormat,
      mode: m.mode ?? null,
      lane: m.lane ?? null,
      chunks: m.chunks ?? null,
      languageCode: m.languageCode ?? null,
      voice: m.voice ?? null,
      title: m.title ?? null,
      audioSeconds: m.audioSeconds ?? null,
      bytesOut: m.bytesOut ?? null,
      inputChars: body.input.length,
    })
    if (status < 400) {
      scope.log.info('tts.done', {
        model: route.model,
        lane: m.lane,
        caller: scope.caller,
        latencyMs: scope.deps.clock.now() - requestStart,
        audioSeconds: m.audioSeconds ?? null,
      })
    }
  }

  let result: LaneResult
  try {
    result =
      route.wire === 'iu-gemini-tts'
        ? await handleGeminiSpeech(scope, {
            routeId,
            input: body.input,
            voice: body.voice,
            responseFormat,
            summarize,
            ...(body.delivery !== undefined && { delivery: body.delivery }),
          })
        : await handleReplicateSpeech(scope, {
            routeId,
            input: body.input,
            voice: body.voice,
            responseFormat,
            summarize,
            ...pick(body, ['speed', 'instructions', 'language', 'stability', 'style', 'similarityBoost']),
          })
  } catch (error) {
    summary(500, errorMessage(error).slice(0, 500))
    throw error
  }
  const { response, settled } = result
  if (!settled) {
    summary(response.status, null)
    return response
  }
  // A streamed body is still being written: its summary (audio seconds, bytes) waits for the body to end.
  settled.then(
    () => summary(response.status, null),
    (error: unknown) => summary(500, errorMessage(error).slice(0, 500)),
  )
  return response
}

function pick<T extends object, K extends keyof T>(source: T, keys: K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {}
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key]
  return out
}
