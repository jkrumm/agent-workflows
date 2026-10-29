import { errorMessage, iuHeaders, rawFetch } from '../http.ts'
import { type AudioOutputFormat, type ChunkAudio, concatPcm, SAMPLE_RATE_DEFAULT } from '../media/audio.ts'
import type { AudioScope } from '../scope.ts'
import {
  type ChunkLimits,
  detectLanguage,
  enforceChunkLimits,
  normalizeForSpeech,
  type PrepChunk,
  type PrepResult,
  synthConcurrent,
} from './core.ts'
import type { LaneResult } from './gemini.ts'
import { callPrepLlm, fallbackTitle, listed, SUMMARY_SYSTEM_PROMPT } from './prep.ts'

// ElevenLabs on IU's Replicate route: create prediction, poll if not immediately `succeeded`, fetch the delivery MP3.

/** ElevenLabs' fixed voice enum (identical across flash/turbo/v3). */
export const ELEVENLABS_VOICES = new Set([
  'Rachel',
  'Drew',
  'Clyde',
  'Paul',
  'Aria',
  'Domi',
  'Dave',
  'Roger',
  'Fin',
  'Sarah',
  'James',
  'Jane',
  'Juniper',
  'Arabella',
  'Hope',
  'Bradford',
  'Reginald',
  'Gaming',
  'Austin',
  'Kuon',
  'Blondie',
  'Priyanka',
  'Alexandra',
  'Monika',
  'Mark',
  'Grimblewood',
])

/** v3 audio tags: inline, English, at most one per chunk. */
const V3_TAGS = ['[sighs]', '[laughs]', '[whispers]', '[curious]', '[excited]', '[thoughtful]']

/** ISO-639-1/-3 with an optional region; anything else falls back to detection. */
const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/

const POLL_DEADLINE_MS = 60_000
const POLL_INTERVAL_MS = 500
/** The delivery fetch: a hang guard on a plain CDN download, and a cap far above any chunk (~1 MB per minute). */
const DELIVERY_TIMEOUT_MS = 120_000
const MAX_DELIVERY_BYTES = 50 * 1024 * 1024

/** Prep-off models: above this many characters, split at sentence boundaries (no rewriting). */
const NO_PREP_SPLIT_THRESHOLD = 4000

export interface ReplicateSpeechRequest {
  routeId: string
  input: string
  voice: string
  responseFormat: AudioOutputFormat
  summarize: boolean
  speed?: number
  instructions?: string
  language?: string
  stability?: number
  style?: number
  similarityBoost?: number
}

const prepPrompt = (
  limits: ChunkLimits,
) => `You prepare text for ElevenLabs v3 text-to-speech in the persona of Hermes — a calm, warm, concise "sharp older friend". No greetings, no filler, substance first.

Your job, in order:
1. Detect the language of the input: "de" (German) or "en" (English).
2. Write a short title (3–6 words) summarizing the content, IN the transcript's language, suitable as a filename/label: plain words, no quotes, no trailing punctuation, no emoji.
3. Rewrite numbers, times, dates, units and abbreviations into the spoken form IN that language (German: "Viertel nach neun", "neunzig Kilo", "achtzehn Uhr dreißig"; English: "quarter past nine", "ninety kilos"). Do not translate the text — keep its language.
4. Split the text into short chunks of about ${limits.targetWords} words each (never more than ${limits.maxWords}). Break at paragraph boundaries first, then at sentence boundaries; never split in the middle of a sentence. Short text stays a single chunk.
5. For each chunk, write a short "style" field (one sentence, IN the transcript's language) describing the intended delivery — it is not spoken and mainly documents intent. Embed AT MOST ONE of these English audio tags per chunk, placed at the start of the sentence it colours, and only where it genuinely fits: ${V3_TAGS.join(' ')}. Most chunks should have NO tag at all — be sparse. Never translate a tag, never invent a new one.

Return STRICT JSON only, no markdown, no commentary:
{"lang":"de"|"en","title":"<short title>","chunks":[{"style":"<directive>","text":"<transcript with at most one tag per chunk>"}]}`

const chunkLimits = (scope: AudioScope): ChunkLimits => ({
  targetWords: scope.config.ttsReplicateChunkTargetWords,
  maxWords: scope.config.ttsReplicateChunkMaxWords,
  maxBytes: scope.config.ttsChunkMaxBytes,
})

const resolveLanguage = (scope: AudioScope, input: string): 'de' | 'en' =>
  detectLanguage(input) ?? scope.config.ttsDefaultLanguage

/** Whether `model` runs the prep LLM (`TTS_REPLICATE_PREP_MODELS`, id or prefix). */
export const replicateWantsPrep = (scope: AudioScope, model: string): boolean =>
  listed(scope.config.ttsReplicatePrepModels, model)

/**
 * Prep for this lane. Skipped (one chunk, no LLM call, no title) unless the model is a prep model or `summarize`
 * forces it: the chat fast path. `instructions` rides along as a delivery hint.
 */
async function runReplicatePrep(
  scope: AudioScope,
  model: string,
  input: string,
  summarize: boolean,
  instructions: string | undefined,
): Promise<{ prep: PrepResult; ran: boolean }> {
  if (!summarize && !replicateWantsPrep(scope, model)) {
    const lang = resolveLanguage(scope, input)
    const title = fallbackTitle(input, lang === 'de')
    const text = normalizeForSpeech(input, lang)
    const chunks =
      input.length > NO_PREP_SPLIT_THRESHOLD
        ? enforceChunkLimits([{ style: '', text }], chunkLimits(scope))
        : [{ style: '', text }]
    return { prep: { lang, title, chunks }, ran: false }
  }
  const prep = await callPrepLlm(scope, {
    systemPrompt: summarize ? SUMMARY_SYSTEM_PROMPT : prepPrompt(chunkLimits(scope)),
    userContent: instructions ? `${input}\n\n[delivery hint: ${instructions}]` : input,
    inputChars: input.length,
    summarize,
  })
  return { prep, ran: true }
}

interface ReplicatePrediction {
  id?: string
  status: string
  output?: string | string[]
  error?: string | null
  metrics?: { predict_time?: number }
}

/** Any Replicate-side synth failure (create, poll, failed status, delivery): a 502, never a 500. */
export class ReplicateSynthError extends Error {}

async function createPrediction(
  scope: AudioScope,
  model: string,
  input: Record<string, unknown>,
): Promise<ReplicatePrediction> {
  const [owner, name] = model.split('/')
  const res = await rawFetch(scope, `${scope.config.transports.replicateBase}/models/${owner}/${name}/predictions`, {
    method: 'POST',
    headers: iuHeaders(scope, { 'content-type': 'application/json', Prefer: 'wait' }),
    body: JSON.stringify({ input }),
  })
  if (res.status < 200 || res.status >= 300) {
    throw new ReplicateSynthError(`Replicate create failed: HTTP ${res.status} ${res.body.slice(0, 300)}`)
  }
  return parsePrediction(res.body, 'create')
}

/** A prediction body; anything unreadable is a Replicate-side failure (502), never a 500. */
function parsePrediction(body: string, stage: string): ReplicatePrediction {
  try {
    const pred = JSON.parse(body) as ReplicatePrediction | null
    if (pred && typeof pred.status === 'string') return pred
  } catch {
    // below
  }
  throw new ReplicateSynthError(`Replicate ${stage} answered an unreadable body: ${body.slice(0, 200)}`)
}

async function pollPrediction(scope: AudioScope, id: string): Promise<ReplicatePrediction> {
  const { clock } = scope.deps
  const deadline = clock.now() + POLL_DEADLINE_MS
  while (clock.now() < deadline) {
    await clock.sleep(POLL_INTERVAL_MS)
    // Flat under the Replicate base, keyed by prediction id alone.
    const res = await rawFetch(
      scope,
      `${scope.config.transports.replicateBase}/predictions/${encodeURIComponent(id)}`,
      {
        method: 'GET',
        headers: iuHeaders(scope),
      },
    )
    if (res.status < 200 || res.status >= 300) {
      throw new ReplicateSynthError(`Replicate poll failed: HTTP ${res.status} ${res.body.slice(0, 300)}`)
    }
    const pred = parsePrediction(res.body, 'poll')
    if (pred.status !== 'starting' && pred.status !== 'processing') return pred
  }
  throw new ReplicateSynthError(`Replicate prediction ${id} timed out after ${POLL_DEADLINE_MS}ms`)
}

async function runPrediction(
  scope: AudioScope,
  model: string,
  input: Record<string, unknown>,
): Promise<ReplicatePrediction> {
  let pred = await createPrediction(scope, model, input)
  if (pred.status === 'starting' || pred.status === 'processing') {
    if (!pred.id) throw new ReplicateSynthError('Replicate prediction missing id for polling')
    pred = await pollPrediction(scope, pred.id)
  }
  if (pred.status === 'failed' || pred.status === 'canceled') {
    throw new ReplicateSynthError(`Replicate prediction ${pred.status}: ${pred.error ?? 'unknown error'}`)
  }
  if (pred.status !== 'succeeded') {
    throw new ReplicateSynthError(`Replicate prediction ended in unexpected status: ${pred.status}`)
  }
  return pred
}

/** Replicate serves output from its own CDN only; anything else is refused (no open fetch). */
function isReplicateDeliveryUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'replicate.delivery' || url.hostname.endsWith('.replicate.delivery'))
    )
  } catch {
    return false
  }
}

async function fetchDelivery(scope: AudioScope, pred: ReplicatePrediction): Promise<Uint8Array> {
  const url = Array.isArray(pred.output) ? pred.output[0] : pred.output
  if (!url) throw new ReplicateSynthError('Replicate prediction succeeded with no output URL')
  if (!isReplicateDeliveryUrl(url))
    throw new ReplicateSynthError('Replicate output URL is not a replicate.delivery URL')
  let res: Response
  try {
    // No redirects (a redirect could leave the allowlisted host), a hang guard, and a byte cap below.
    res = await scope.deps.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) })
  } catch (error) {
    throw new ReplicateSynthError(`Failed to fetch Replicate output: ${errorMessage(error)}`)
  }
  if (!res.ok) throw new ReplicateSynthError(`Failed to fetch Replicate output: HTTP ${res.status}`)
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_DELIVERY_BYTES) {
    res.body?.cancel().catch(() => {})
    throw new ReplicateSynthError(`Replicate output is ${declared} bytes, over the ${MAX_DELIVERY_BYTES}-byte cap`)
  }
  const reader = res.body?.getReader()
  if (!reader) throw new ReplicateSynthError('Replicate output has no body')
  const parts: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_DELIVERY_BYTES) {
        reader.cancel().catch(() => {})
        throw new ReplicateSynthError(`Replicate output exceeds the ${MAX_DELIVERY_BYTES}-byte cap`)
      }
      parts.push(value)
    }
  } catch (error) {
    if (error instanceof ReplicateSynthError) throw error
    throw new ReplicateSynthError(`Failed to read Replicate output: ${errorMessage(error)}`)
  }
  return new Uint8Array(Buffer.concat(parts))
}

/** `speed` into ElevenLabs' 0.7–1.2; the neutral 1 is omitted. */
function clampSpeed(speed: number | undefined): number | undefined {
  if (speed === undefined) return undefined
  const clamped = Math.min(1.2, Math.max(0.7, speed))
  return clamped === 1 ? undefined : clamped
}

export interface ReplicateChunkParams {
  routeId: string
  text: string
  previousText?: string
  nextText?: string
  voice: string
  languageCode: string
  stability: number
  style: number
  similarityBoost: number
  speed?: number
}

export interface ReplicateChunkResult {
  mp3: Uint8Array
  /** Decoded to s16le mono 24 kHz: the shape the concat/transcode stage consumes. */
  pcm: Uint8Array
  audioSeconds: number
  inputChars: number
  latencyMs: number
  predictTime: number | null
}

/**
 * One chunk (or one podcast turn) on ElevenLabs, decoded to PCM. One usage event per prediction: a failed prediction is
 * a not-billed 502; once it succeeded its characters are billed, even when the delivery fetch or the decode fails
 * afterwards (the event then carries the error). Failures rethrow. The podcast's production stage calls this per turn.
 */
export async function synthReplicateChunk(
  scope: AudioScope,
  params: ReplicateChunkParams,
): Promise<ReplicateChunkResult> {
  const route = scope.route(params.routeId)
  const speed = clampSpeed(params.speed)
  const continuity = route.continuity !== false
  const input = {
    prompt: params.text,
    voice: params.voice,
    language_code: params.languageCode,
    stability: params.stability,
    style: params.style,
    similarity_boost: params.similarityBoost,
    ...(speed !== undefined && { speed }),
    ...(continuity && params.previousText && { previous_text: params.previousText }),
    ...(continuity && params.nextText && { next_text: params.nextText }),
  }
  const start = scope.deps.clock.now()
  const record = (status: number, extra: { audioSeconds?: number; bytesOut?: number; errorText?: string } = {}) =>
    scope.call({
      endpoint: 'speech',
      routeId: params.routeId,
      model: route.model,
      status,
      latencyMs: scope.deps.clock.now() - start,
      // ElevenLabs bills per input character, not per token.
      inputChars: params.text.length,
      ...extra,
    })
  const fail = (status: number, error: unknown): never => {
    const errorText = errorMessage(error).slice(0, 500)
    scope.log.error('replicate tts synth error', { model: route.model, status, error: errorText })
    record(status, { errorText })
    throw error
  }

  let pred: ReplicatePrediction
  try {
    pred = await runPrediction(scope, route.model, input)
  } catch (error) {
    return fail(502, error)
  }
  // The prediction succeeded: its characters are billed from here on, whatever happens to the delivery.
  let result: ReplicateChunkResult
  try {
    const mp3 = await fetchDelivery(scope, pred)
    const latencyMs = scope.deps.clock.now() - start
    const decoded = await scope.deps.media.transcode(mp3, { kind: 'auto' }, 'pcm')
    const pcm = new Uint8Array(decoded.bytes)
    result = {
      mp3,
      pcm,
      audioSeconds: pcm.byteLength / (2 * SAMPLE_RATE_DEFAULT),
      inputChars: params.text.length,
      latencyMs,
      predictTime: pred.metrics?.predict_time ?? null,
    }
  } catch (error) {
    return fail(200, error)
  }
  record(200, { audioSeconds: result.audioSeconds, bytesOut: result.mp3.byteLength })
  return result
}

export async function handleReplicateSpeech(scope: AudioScope, req: ReplicateSpeechRequest): Promise<LaneResult> {
  const { routeId, input, voice, responseFormat, summarize, instructions, language } = req
  const model = scope.route(routeId).model
  if (!input.trim()) {
    return {
      response: Response.json(
        { error: { message: 'input is required', type: 'invalid_request_error' } },
        { status: 400 },
      ),
    }
  }
  const { config } = scope
  const voiceName = ELEVENLABS_VOICES.has(voice) ? voice : config.ttsElevenLabsVoice
  const languageCode = language && LANGUAGE_CODE.test(language) ? language : resolveLanguage(scope, input)
  const unit = (v: number | undefined, fallback: number) => (v === undefined ? fallback : Math.min(1, Math.max(0, v)))

  const { prep, ran } = await runReplicatePrep(scope, model, input, summarize, instructions)
  const chunks: PrepChunk[] = enforceChunkLimits(prep.chunks, chunkLimits(scope))
  const title = prep.title || fallbackTitle(input, prep.lang === 'de')
  Object.assign(scope.meta, {
    mode: summarize ? 'summary' : ran ? 'prep' : 'direct',
    lane: 'replicate',
    chunks: chunks.length,
    languageCode,
    voice: voiceName,
    title,
    outputText: chunks.map((c) => c.text).join(' '),
  })

  let parts: ReplicateChunkResult[]
  try {
    parts = await synthConcurrent(config.ttsConcurrency, chunks, (chunk, i) =>
      synthReplicateChunk(scope, {
        routeId,
        text: chunk.text,
        previousText: chunks[i - 1]?.text,
        nextText: chunks[i + 1]?.text,
        voice: voiceName,
        languageCode,
        stability: unit(req.stability, config.ttsElevenLabsStability),
        style: unit(req.style, config.ttsElevenLabsStyle),
        similarityBoost: unit(req.similarityBoost, config.ttsElevenLabsSimilarity),
        ...(req.speed !== undefined && { speed: req.speed }),
      }),
    )
  } catch (error) {
    if (error instanceof ReplicateSynthError) {
      return { response: Response.json({ error: { message: error.message, type: 'proxy_error' } }, { status: 502 }) }
    }
    throw error
  }

  // One chunk as mp3: the fetched bytes as they are. Otherwise concat the decoded PCM and transcode once.
  let bytes: ArrayBuffer
  let contentType: string
  const only = parts[0]
  if (chunks.length === 1 && responseFormat === 'mp3' && only) {
    bytes = only.mp3.buffer.slice(only.mp3.byteOffset, only.mp3.byteOffset + only.mp3.byteLength) as ArrayBuffer
    contentType = 'audio/mpeg'
  } else {
    const pcmParts: ChunkAudio[] = parts.map((p) => ({ pcm: p.pcm, sampleRate: SAMPLE_RATE_DEFAULT }))
    const { pcm, sampleRate } = concatPcm(pcmParts)
    const encoded = await scope.deps.media.transcode(pcm, { kind: 'pcm', sampleRate }, responseFormat)
    bytes = encoded.bytes
    contentType = encoded.contentType
  }
  const headers: Record<string, string> = { 'content-type': contentType }
  if (ran) headers['x-audio-title'] = encodeURIComponent(title)
  scope.meta.audioSeconds = parts.reduce((sum, p) => sum + p.audioSeconds, 0)
  scope.meta.bytesOut = bytes.byteLength
  return { response: new Response(bytes, { status: 200, headers }) }
}
