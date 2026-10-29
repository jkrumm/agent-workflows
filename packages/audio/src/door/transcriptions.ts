import { errorMessage } from '../http.ts'
import { AUDIO_DEFAULT_ROUTES } from '../routes.ts'
import { type AudioDeps, AudioScope, resolveDeps } from '../scope.ts'
import {
  PartFailure,
  postTranscription,
  readReply,
  record,
  stripPromptEcho,
  transcribeParts,
} from '../transcriptions/dispatch.ts'
import { srt, verboseJson, vtt } from '../transcriptions/envelopes.ts'
import { prepareSttInput, SttChunkLimitError, SttChunkTooLargeError } from '../transcriptions/input.ts'
import { callerOf, internalError, requestIdOf } from './common.ts'

const RICH_FORMATS = new Set(['verbose_json', 'srt', 'vtt'])

/** A transient outage of the model/backend (IU 404 "No suitable backend server found", a 5xx), not a bad request. */
const isModelUnavailable = (status: number): boolean => status === 404 || status >= 500
const isOk = (status: number): boolean => status >= 200 && status < 300

/**
 * The STT route for a requested model: honoured only when the table has it on the STT wire; anything else (an OpenAI
 * name IU lists but does not serve here, a realtime-only model, a typo) is the default.
 */
export function resolveSttRoute(scope: AudioScope, requested: string): { routeId: string; overridden: boolean } {
  const routeId = scope.routeIdForModel(requested, ['stt'])
  if (routeId) return { routeId, overridden: false }
  return { routeId: AUDIO_DEFAULT_ROUTES.stt, overridden: requested.length > 0 }
}

interface AttemptResult {
  status: number
  body: string
  contentType: string
  text: string
  language: string | null
  /** A billed reply that could not be read: never retried on the fallback. */
  final?: boolean
}

/**
 * `POST /v1/audio/transcriptions`, OpenAI-compatible, as audio-gateway serves it: upload fitting (compress, silence-
 * snapped chunks), the fallback chain, envelope synthesis for verbose_json/srt/vtt, the empty-5xx message. Every
 * upstream call is one usage event; the request ends with one `transcription-request` event.
 */
export function createTranscriptionsHandler(deps: AudioDeps): (req: Request) => Promise<Response> {
  const resolved = resolveDeps(deps)
  return async (req) => {
    const scope = new AudioScope(resolved, requestIdOf(deps, req), callerOf(deps, req))
    try {
      return await dispatchTranscription(scope, req)
    } catch (error) {
      return internalError(scope, error)
    }
  }
}

async function dispatchTranscription(scope: AudioScope, req: Request): Promise<Response> {
  const requestStart = scope.deps.clock.now()
  const form = await req.formData()
  const requestedModel = String(form.get('model') ?? '')
  const resolved = resolveSttRoute(scope, requestedModel)
  if (resolved.overridden) {
    scope.log.warn('stt model overridden', {
      requested: requestedModel,
      used: scope.route(resolved.routeId).model,
      caller: scope.caller,
    })
  }
  const clientFormat = String(form.get('response_format') ?? 'json')
  const language = form.get('language') ? String(form.get('language')) : null
  const upload = form.get('file')
  const file = upload instanceof File ? upload : null

  const finish = (
    response: Response,
    opts: { routeId: string; status: number; audioSeconds?: number | null; errorText?: string | null },
  ): Response => {
    scope.summary({
      endpoint: 'transcription-request',
      routeId: opts.routeId,
      model: scope.route(opts.routeId).model,
      requestedModel,
      status: opts.status,
      latencyMs: scope.deps.clock.now() - requestStart,
      errorText: opts.errorText ?? null,
      responseFormat: clientFormat,
      mode: null,
      lane: null,
      chunks: scope.meta.chunks ?? null,
      languageCode: language,
      voice: null,
      title: null,
      audioSeconds: opts.audioSeconds ?? null,
      bytesOut: null,
      inputChars: null,
    })
    if (opts.status < 400) {
      scope.log.info('stt.done', {
        model: scope.route(opts.routeId).model,
        caller: scope.caller,
        latencyMs: scope.deps.clock.now() - requestStart,
        responseFormat: clientFormat,
        audioSeconds: opts.audioSeconds ?? null,
      })
    }
    return response
  }

  // Fit the upload before the first attempt. A rejected one is a 413; a broken ffmpeg falls back to the original.
  let parts: File[] = []
  let partSeconds: number[] = []
  let totalSeconds: number | null = null
  if (file) {
    try {
      const prepared = await prepareSttInput(scope, file)
      parts = prepared.parts
      partSeconds = prepared.partSeconds
      totalSeconds = prepared.totalSeconds
    } catch (error) {
      if (error instanceof SttChunkLimitError || error instanceof SttChunkTooLargeError) {
        scope.log.warn('stt upload rejected', { caller: scope.caller, error: error.message })
        return finish(
          Response.json({ error: { message: error.message, type: 'invalid_request_error' } }, { status: 413 }),
          { routeId: resolved.routeId, status: 413, errorText: error.message },
        )
      }
      scope.log.error('stt input preparation failed; sending the original upload unchanged', {
        caller: scope.caller,
        error: errorMessage(error),
      })
      parts = [file]
    }
  }
  scope.meta.chunks = Math.max(1, parts.length)

  const build = (routeId: string, part: File | undefined, forceJson = false): FormData => {
    const route = scope.route(routeId)
    const synth = forceJson || (route.synthesizeEnvelope === true && RICH_FORMATS.has(clientFormat))
    const upstream = new FormData()
    for (const [key, value] of form.entries()) {
      if (key === 'model' || key === 'response_format' || key === 'timestamp_granularities[]') continue
      if (key === 'file' && part) continue
      upstream.append(key, value)
    }
    if (part) upstream.append('file', part)
    upstream.append('model', route.model)
    upstream.append('response_format', synth ? 'json' : clientFormat)
    // `language` is a hard lock; `prompt` a softer bias.
    const { config } = scope
    if (!form.has('language') && config.sttLanguage) upstream.append('language', config.sttLanguage)
    if (!form.has('prompt') && config.sttPrompt) upstream.append('prompt', config.sttPrompt)
    // `context_bias` is Voxtral-only: injected for it, never forwarded to others (unknown field upstream).
    if (route.contextBias) {
      if (!form.has('context_bias') && config.sttContextBias) upstream.append('context_bias', config.sttContextBias)
    } else {
      upstream.delete('context_bias')
    }
    return upstream
  }

  const attemptSingle = async (routeId: string): Promise<AttemptResult> => {
    const reply = await postTranscription(scope, build(routeId, parts[0]))
    if (!isOk(reply.status)) {
      record(scope, routeId, reply, null)
      return { ...reply, text: '', language: null }
    }
    const read = readReply(scope, routeId, reply, totalSeconds)
    if ('failure' in read) {
      // Billed and recorded already: a fallback would bill the same audio again, so this ends here.
      return {
        status: 502,
        body: JSON.stringify(read.failure),
        contentType: 'application/json',
        text: '',
        language: null,
        final: true,
      }
    }
    return { ...reply, text: read.text, language: read.language }
  }

  let routeId = resolved.routeId
  let result: AttemptResult
  const joined = parts.length > 1
  if (joined) {
    const fallbackRouteId = scope.route(routeId).sttFallback ?? null
    try {
      const { text, usedFallback } = await transcribeParts(scope, {
        parts,
        routeId,
        fallbackRouteId,
        isModelUnavailable,
        buildUpstream: (id, part) => build(id, part, true),
        partSeconds: (i) => partSeconds[i] ?? null,
      })
      // Report the model that served: the fallback if any part needed it.
      if (usedFallback && fallbackRouteId) routeId = fallbackRouteId
      result = { status: 200, body: JSON.stringify({ text }), contentType: 'application/json', text, language: null }
    } catch (error) {
      if (!(error instanceof PartFailure)) throw error
      result = { status: error.status, body: error.body, contentType: error.contentType, text: '', language: null }
    }
  } else {
    result = await attemptSingle(routeId)
    const fallback = scope.route(routeId).sttFallback
    if (!isOk(result.status) && !result.final && isModelUnavailable(result.status) && fallback) {
      scope.log.warn('stt upstream unavailable; retrying on fallback', {
        model: scope.route(routeId).model,
        fallback: scope.route(fallback).model,
        status: result.status,
        caller: scope.caller,
      })
      routeId = fallback
      result = await attemptSingle(routeId)
    }
  }

  const route = scope.route(routeId)
  const { status, body, contentType } = result
  if (!isOk(status)) {
    const errorText = body.slice(0, 500)
    scope.log.error('stt upstream error', { model: route.model, status, caller: scope.caller, error: errorText })
    // An empty body (IU's 25 MiB-oversize 500) would otherwise reach the client as a message-less error.
    if (body.trim() === '') {
      const message = `upstream ${route.model} returned ${status} with an empty body`
      return finish(Response.json({ error: { message, type: 'upstream_error' } }, { status }), {
        routeId,
        status,
        errorText: message,
      })
    }
    return finish(new Response(body, { status, headers: { 'content-type': contentType } }), {
      routeId,
      status,
      errorText,
    })
  }

  // A collapsed chunk can echo the prompt verbatim. Stripped from the text we build responses from; Whisper's raw rich
  // bodies below stay untouched (stripping inside SRT/VTT framing would corrupt the cues).
  const text = stripPromptEcho(result.text, scope.config.sttPrompt)
  if (text !== result.text)
    scope.log.warn('stt transcript echoed the prompt verbatim; stripped', { caller: scope.caller })
  const detectedLang = language ?? result.language ?? (scope.config.sttLanguage || null)

  // A joined transcript has no real segment timing: a rich format is always synthesized there.
  const synthesize = RICH_FORMATS.has(clientFormat) && (joined || route.synthesizeEnvelope === true)
  if (synthesize && file) {
    // The duration prepareSttInput already measured; a probe only when preparation fell back to the raw upload.
    const duration = totalSeconds && totalSeconds > 0 ? totalSeconds : await scope.deps.media.duration(file)
    const done = { routeId, status, audioSeconds: duration }
    if (clientFormat === 'verbose_json') return finish(Response.json(verboseJson(text, duration, detectedLang)), done)
    if (clientFormat === 'srt') {
      return finish(
        new Response(srt(text, duration), { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
        done,
      )
    }
    return finish(new Response(vtt(text, duration), { headers: { 'content-type': 'text/vtt; charset=utf-8' } }), done)
  }

  const done = { routeId, status, audioSeconds: totalSeconds }
  if (clientFormat === 'json') return finish(Response.json({ text }), done)
  // Our joined `{ text }` and Voxtral's JSON-whatever-you-ask are not the plain text a `text` client expects.
  if (joined || (clientFormat === 'text' && contentType.includes('application/json'))) {
    return finish(new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } }), done)
  }
  // Whisper's native rich formats and plain text: the raw body, deliberately untouched.
  return finish(new Response(body, { status, headers: { 'content-type': contentType } }), done)
}
