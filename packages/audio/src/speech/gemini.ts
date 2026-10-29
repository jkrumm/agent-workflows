import { iuHeaders, rawFetch, throttleDelay } from '../http.ts'
import { type AudioOutputFormat, type ChunkAudio, concatPcm, SAMPLE_RATE_DEFAULT, silencePcm } from '../media/audio.ts'
import type { AudioScope } from '../scope.ts'
import {
  type ChunkLimits,
  detectLanguage,
  enforceChunkLimits,
  normalizeForSpeech,
  type PrepChunk,
  type PrepResult,
  resolveDelivery,
  stripDisallowedTags,
  synthConcurrent,
  TAG_PATTERN,
} from './core.ts'
import {
  callPrepLlm,
  fallbackTitle,
  GEMINI_PREP_SYSTEM_PROMPT,
  listed,
  PREP_STYLE,
  SUMMARY_SYSTEM_PROMPT,
  VOCABULARY_STYLES,
} from './prep.ts'

// Gemini TTS lane. TTS only answers on the native `generateContent` endpoint with an AUDIO modality (base64 L16,
// 24 kHz, mono). Prep (briefing models) rewrites the text into styled chunks; chunks synthesize concurrently, the PCM
// is joined and transcoded. `pcm` streams instead (`streamGenerateContent?alt=sse`). Request shapes, tag vocabulary
// and traps: modelpick `docs/gemini-tts.md` (IU-proven; do not re-probe).

/** The 30 prebuilt Gemini voices. Anything else falls back to Charon. */
export const GEMINI_VOICES = new Set([
  'Charon',
  'Schedar',
  'Iapetus',
  'Algieba',
  'Orus',
  'Puck',
  'Enceladus',
  'Sadachbia',
  'Rasalgethi',
  'Sadaltager',
  'Achird',
  'Umbriel',
  'Alnilam',
  'Fenrir',
  'Algenib',
  'Zubenelgenubi',
  'Sulafat',
  'Kore',
  'Leda',
  'Callirrhoe',
  'Despina',
  'Laomedeia',
  'Gacrux',
  'Pulcherrima',
  'Vindemiatrix',
  'Zephyr',
  'Aoede',
  'Autonoe',
  'Erinome',
  'Achernar',
])
const DEFAULT_VOICE = 'Charon'

/** Gemini audio tokens per second of audio. Streamed `usageMetadata` reports 1 token: a stream is billed from duration. */
export const AUDIO_TOKENS_PER_SECOND = 25

/** No byte from upstream for this long means a wedged stream (idle rule, never a total-duration cap). */
const STREAM_IDLE_MS = 60_000

export interface GeminiSpeechRequest {
  routeId: string
  input: string
  voice: string
  responseFormat: AudioOutputFormat
  summarize: boolean
  /** A delivery vocabulary key for the whole request; wins over a prep-chosen style. */
  delivery?: string
}

export interface LaneResult {
  response: Response
  /** A streamed body: resolves when it is fully written (or cancelled), rejects on a mid-stream failure. */
  settled?: Promise<void>
}

const geminiUrl = (scope: AudioScope, model: string, method: string) =>
  `${scope.config.transports.geminiBase}/models/${model}:${method}`

const chunkLimits = (scope: AudioScope): ChunkLimits => ({
  targetWords: scope.config.ttsChunkTargetWords,
  maxWords: scope.config.ttsChunkMaxWords,
  maxBytes: scope.config.ttsChunkMaxBytes,
})

/** A single-chunk PrepResult with no style and no LLM call: deterministic cleanup, allowlisted input tags kept. */
function defaultPrep(scope: AudioScope, input: string): PrepResult {
  const de = (detectLanguage(input) ?? scope.config.ttsDefaultLanguage) === 'de'
  const lang = de ? 'de' : 'en'
  const text = normalizeForSpeech(stripDisallowedTags(input), lang)
  return { lang, title: fallbackTitle(input, de), chunks: [{ style: '', text }] }
}

/** Whether `model` runs the prep LLM (`TTS_GEMINI_PREP_MODELS`, id or prefix). */
export const geminiWantsPrep = (scope: AudioScope, model: string): boolean =>
  listed(scope.config.ttsGeminiPrepModels, model)

/**
 * Prep for the Gemini lane: only for prep models (and then per `ttsPrep`); `summarize` always calls the summary LLM.
 * A prep-invented style never reaches the request (vocabulary strings only), invented tags are stripped, and a prep
 * that returned only tags falls back to speaking the input as is.
 */
export async function runGeminiPrep(
  scope: AudioScope,
  model: string,
  input: string,
  summarize: boolean,
): Promise<{ prep: PrepResult; ran: boolean }> {
  if (!summarize) {
    if (!geminiWantsPrep(scope, model)) return { prep: defaultPrep(scope, input), ran: false }
    const mode = scope.config.ttsPrep
    if (mode === 'off') return { prep: defaultPrep(scope, input), ran: false }
    if (mode === 'long' && input.length < scope.config.ttsChunkCharThreshold) {
      return { prep: defaultPrep(scope, input), ran: false }
    }
  }
  const parsed = await callPrepLlm(scope, {
    systemPrompt: summarize ? SUMMARY_SYSTEM_PROMPT : GEMINI_PREP_SYSTEM_PROMPT,
    userContent: input,
    inputChars: input.length,
    summarize,
  })
  const chunks = parsed.chunks
    .map((c) => ({
      style: VOCABULARY_STYLES.has(c.style) ? c.style : PREP_STYLE,
      text: stripDisallowedTags(c.text)
        .replace(/[ \t]{2,}/g, ' ')
        .trim(),
    }))
    .filter((c) => c.text.replace(TAG_PATTERN, '').trim())
  if (chunks.length === 0) {
    scope.log.warn('prep returned only tags, speaking the input as is', { inputChars: input.length })
    return { prep: defaultPrep(scope, input), ran: false }
  }
  return { prep: { ...parsed, chunks }, ran: true }
}

/**
 * The 3.8 request body for one chunk. Style rides in `parts[].speechMetadata.style`, never as a spoken prefix and
 * never in `systemInstruction` / `speechConfig` (both 400 on IU). `rawPcm` asks the unary route for headerless L16;
 * the stream route is headerless L16 already.
 */
export function synthBody(voiceName: string, chunk: PrepChunk, opts: { rawPcm: boolean }): Record<string, unknown> {
  return {
    contents: [{ parts: [{ text: chunk.text, ...(chunk.style && { speechMetadata: { style: chunk.style } }) }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      ...(opts.rawPcm && { responseFormat: { audio: { mimeType: 'AUDIO_L16' } } }),
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  }
}

/**
 * Only the `data` chunk of a RIFF/WAVE file; non-RIFF bytes pass through as raw PCM. 3.8 unary WAVs carry a trailing
 * `C2PA` chunk (~6 KB) after `data`, which a fixed 44-byte header skip plays as ~0.13 s of loud noise.
 */
export function stripWavHeader(bytes: Uint8Array): Uint8Array {
  const tag = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4))
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return bytes
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 12
  while (at + 8 <= bytes.byteLength) {
    const size = view.getUint32(at + 4, true)
    if (tag(at) === 'data') return bytes.subarray(at + 8, Math.min(at + 8 + size, bytes.byteLength))
    at += 8 + size + (size % 2)
  }
  throw new Error('Gemini TTS WAV has no data chunk')
}

interface GeminiTtsResponse {
  candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
}

const tokensOf = (usage: GeminiTtsResponse['usageMetadata']) => ({
  inputTokens: usage?.promptTokenCount ?? null,
  outputTokens: usage?.candidatesTokenCount ?? null,
})

const evenBytes = (pcm: Uint8Array): Uint8Array => (pcm.byteLength % 2 ? pcm.subarray(0, pcm.byteLength - 1) : pcm)

/** POST one unary synth request on a route; priced and recorded before any throw. */
async function postSynth(scope: AudioScope, routeId: string, body: Record<string, unknown>): Promise<ChunkAudio> {
  const model = scope.route(routeId).model
  const start = scope.deps.clock.now()
  const res = await rawFetch(scope, geminiUrl(scope, model, 'generateContent'), {
    method: 'POST',
    headers: iuHeaders(scope, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  })
  const latencyMs = scope.deps.clock.now() - start
  const fail = (errorText: string, message: string, usage?: GeminiTtsResponse['usageMetadata']): never => {
    scope.log.error('gemini tts synth error', { model, status: res.status, latencyMs, error: errorText })
    // A 2xx without audio still bills its prompt (and whatever it generated): its usageMetadata is recorded.
    scope.call({ endpoint: 'speech', routeId, model, status: res.status, latencyMs, errorText, ...tokensOf(usage) })
    throw new Error(message)
  }
  if (res.status < 200 || res.status >= 300) {
    return fail(res.body.slice(0, 500), `Gemini TTS failed: HTTP ${res.status} ${res.body.slice(0, 300)}`)
  }
  let parsed: GeminiTtsResponse
  try {
    parsed = JSON.parse(res.body) as GeminiTtsResponse
  } catch {
    return fail(`unparseable response: ${res.body.slice(0, 400)}`, `Gemini TTS answered no JSON: HTTP ${res.status}`)
  }
  const inline = parsed.candidates?.[0]?.content?.parts?.[0]?.inlineData
  if (!inline?.data) {
    return fail(
      `no audio in response: ${res.body.slice(0, 400)}`,
      `Gemini TTS returned no audio: HTTP ${res.status} ${res.body.slice(0, 300)}`,
      parsed.usageMetadata,
    )
  }
  // An odd byte count would shift every later chunk by one byte into noise: trimmed to whole samples.
  const pcm = evenBytes(stripWavHeader(Uint8Array.from(Buffer.from(inline.data, 'base64'))))
  const sampleRate = Number(/rate=(\d+)/.exec(inline.mimeType ?? '')?.[1]) || SAMPLE_RATE_DEFAULT
  scope.call({
    endpoint: 'speech',
    routeId,
    model,
    status: res.status,
    latencyMs,
    ...tokensOf(parsed.usageMetadata),
    audioSeconds: pcm.byteLength / (2 * sampleRate),
    bytesOut: pcm.byteLength,
  })
  return { pcm, sampleRate }
}

export interface MultiSpeakerPart {
  /** Must match one of the two `voices` speaker names exactly. */
  speaker: string
  text: string
  /** Short sustained-delivery string; omitted = the model's default. */
  style?: string
}

export type MultiSpeakerVoices = [{ speaker: string; voiceName: string }, { speaker: string; voiceName: string }]

/**
 * The 3.8 two-speaker body: one part per turn carrying `speechMetadata.speaker` (a `Name:` prefix 400s on IU),
 * prebuilt voices only, unary `AUDIO_L16` (no WAV container, no trailing C2PA chunk).
 */
export function multiSpeakerBody(voices: MultiSpeakerVoices, parts: MultiSpeakerPart[]): Record<string, unknown> {
  return {
    contents: [
      {
        parts: parts.map((p) => ({
          text: p.text,
          speechMetadata: { speaker: p.speaker, ...(p.style && { style: p.style }) },
        })),
      },
    ],
    generationConfig: {
      responseModalities: ['AUDIO'],
      responseFormat: { audio: { mimeType: 'AUDIO_L16' } },
      speechConfig: {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: voices.map((v) => ({
            speaker: v.speaker,
            voiceConfig: { prebuiltVoiceConfig: { voiceName: v.voiceName } },
          })),
        },
      },
    },
  }
}

/**
 * Synthesize a run of turns by two speakers in one request; the podcast's production stage calls this in-process.
 * One `speech` usage event per call, on `scope`.
 */
export function synthMultiSpeaker(
  scope: AudioScope,
  opts: { routeId: string; voices: MultiSpeakerVoices; parts: MultiSpeakerPart[] },
): Promise<ChunkAudio> {
  return postSynth(scope, opts.routeId, multiSpeakerBody(opts.voices, opts.parts))
}

/** All chunks with bounded concurrency, in order; fail-fast with no partial output. */
export function synthChunksConcurrent(
  scope: AudioScope,
  routeId: string,
  voiceName: string,
  chunks: PrepChunk[],
): Promise<ChunkAudio[]> {
  return synthConcurrent(scope.config.ttsConcurrency, chunks, (chunk) =>
    postSynth(scope, routeId, synthBody(voiceName, chunk, { rawPcm: true })),
  )
}

/** The base64 PCM of one SSE `data:` payload; null for an event without audio; a garbled or error event throws. */
export function sseAudio(data: string): Uint8Array | null {
  return sseEvent(data).audio
}

/** One SSE `data:` payload: its audio and the prompt token count it reports (input is billed once per call). */
export function sseEvent(data: string): { audio: Uint8Array | null; promptTokens: number | null } {
  let event: GeminiTtsResponse & { error?: { message?: string } }
  try {
    event = JSON.parse(data) as typeof event
  } catch {
    throw new Error(`Gemini TTS stream sent an unparseable event: ${data.slice(0, 120)}`)
  }
  if (event.error) {
    throw new Error(
      `Gemini TTS stream error event: ${(event.error.message ?? JSON.stringify(event.error)).slice(0, 300)}`,
    )
  }
  const b64 = event.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data
  const prompt = event.usageMetadata?.promptTokenCount
  return {
    audio: b64 ? Uint8Array.from(Buffer.from(b64, 'base64')) : null,
    promptTokens: typeof prompt === 'number' && Number.isFinite(prompt) ? prompt : null,
  }
}

async function readWithIdleGuard(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Gemini TTS stream idle for ${STREAM_IDLE_MS / 1000}s`)), STREAM_IDLE_MS)
  })
  try {
    return await Promise.race([reader.read(), idle])
  } finally {
    clearTimeout(timer)
  }
}

/** Open the SSE stream for one chunk; 429/503 and transport failures are retried before any body byte is read. */
async function openStream(
  scope: AudioScope,
  model: string,
  voiceName: string,
  chunk: PrepChunk,
  signal: AbortSignal,
): Promise<Response> {
  const attempts = 3
  for (let attempt = 1; ; attempt++) {
    let res: Response
    try {
      res = await scope.deps.fetch(`${geminiUrl(scope, model, 'streamGenerateContent')}?alt=sse`, {
        method: 'POST',
        headers: iuHeaders(scope, { 'content-type': 'application/json' }),
        body: JSON.stringify(synthBody(voiceName, chunk, { rawPcm: false })),
        signal,
      })
    } catch (error) {
      if (attempt >= attempts || signal.aborted) throw error
      scope.retried()
      await scope.deps.clock.sleep(1000 * attempt)
      continue
    }
    if ((res.status === 503 || res.status === 429) && attempt < attempts) {
      scope.retried()
      await scope.deps.clock.sleep(await throttleDelay(res, attempt))
      continue
    }
    return res
  }
}

/** Sample-aligned PCM runs of one chunk as its SSE events arrive. A non-2xx or audio-less stream throws (recorded). */
async function* streamChunkPcm(
  scope: AudioScope,
  routeId: string,
  voiceName: string,
  chunk: PrepChunk,
  started: number,
  signal: AbortSignal,
  meter: { promptTokens: number | null },
): AsyncGenerator<Uint8Array> {
  const model = scope.route(routeId).model
  const res = await openStream(scope, model, voiceName, chunk, signal)
  const fail = (errorText: string, message: string): never => {
    scope.log.error('gemini tts stream error', { model, status: res.status, error: errorText })
    scope.call({
      endpoint: 'speech',
      routeId,
      model,
      status: res.ok ? 502 : res.status,
      latencyMs: scope.deps.clock.now() - started,
      errorText,
      inputTokens: meter.promptTokens,
    })
    throw new Error(message)
  }
  if (!res.ok || !res.body) {
    const errorText = (await res.text()).slice(0, 500)
    return fail(errorText, `Gemini TTS stream failed: HTTP ${res.status} ${errorText.slice(0, 300)}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let carry: Uint8Array | null = null
  let yielded = false
  const emit = (audio: Uint8Array): Uint8Array | null => {
    const joined: Uint8Array = carry ? Uint8Array.from([...carry, ...audio]) : audio
    const even = joined.byteLength - (joined.byteLength % 2)
    carry = even < joined.byteLength ? joined.slice(even) : null
    return even > 0 ? joined.subarray(0, even) : null
  }
  try {
    for (;;) {
      const { done, value } = await readWithIdleGuard(reader)
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = done ? '' : (events.pop() ?? '')
      for (const raw of events) {
        const data = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('')
        const event = data ? sseEvent(data) : null
        if (event?.promptTokens != null) meter.promptTokens = event.promptTokens
        const audio = event?.audio ?? null
        const run = audio ? emit(audio) : null
        if (run) {
          yielded = true
          yield run
        }
      }
      if (done) break
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  if (!yielded) fail('no audio in stream', `Gemini TTS stream returned no audio: HTTP ${res.status}`)
}

/**
 * Stream the chunks as raw PCM. The first bytes leave as soon as Gemini produces them; chunks run one after another
 * with the 400 ms silence join. The contract: the Response is returned only once the first audio byte arrived, so a
 * failure before it is a normal HTTP error; a failure after it ERRORS the body (clients see a transfer error, never a
 * clean EOF). Each chunk's usage is recorded when that chunk ends, never before a byte is pushed.
 */
async function streamGeminiSpeech(
  scope: AudioScope,
  params: { routeId: string; voiceName: string; chunks: PrepChunk[]; headers: Record<string, string> },
): Promise<LaneResult> {
  const { routeId, voiceName, chunks, headers } = params
  const model = scope.route(routeId).model
  const sampleRate = SAMPLE_RATE_DEFAULT
  const clock = scope.deps.clock
  const started = clock.now()
  let cancelled = false
  // A client that leaves aborts the upstream read too: Gemini would otherwise keep generating (and billing).
  const upstream = new AbortController()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let wake: (() => void) | null = null
  // Pull-based backpressure: ~256 KiB (~5 s of audio) may queue ahead of the client; a cancelled stream stops asking.
  const body = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c
      },
      pull() {
        wake?.()
      },
      cancel() {
        cancelled = true
        upstream.abort()
        wake?.()
      },
    },
    { highWaterMark: 262_144, size: (bytes) => bytes?.byteLength ?? 0 },
  )
  const push = async (bytes: Uint8Array): Promise<void> => {
    while (!cancelled && (controller.desiredSize ?? 1) <= 0) {
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
    if (!cancelled) controller.enqueue(bytes)
  }

  let totalBytes = 0
  let firstByteMs: number | null = null
  let signalFirst!: () => void
  const first = new Promise<void>((resolve) => {
    signalFirst = resolve
  })

  const run = async () => {
    try {
      for (let i = 0; i < chunks.length && !cancelled; i++) {
        const chunk = chunks[i]
        if (!chunk) continue
        const chunkStart = clock.now()
        let chunkBytes = 0
        let chunkStatus = 500
        const meter: { promptTokens: number | null } = { promptTokens: null }
        try {
          if (i > 0 && firstByteMs !== null) {
            const gap = silencePcm(sampleRate)
            totalBytes += gap.byteLength
            await push(gap)
          }
          for await (const bytes of streamChunkPcm(
            scope,
            routeId,
            voiceName,
            chunk,
            chunkStart,
            upstream.signal,
            meter,
          )) {
            if (cancelled) break
            if (firstByteMs === null) {
              firstByteMs = clock.now() - started
              signalFirst()
            }
            chunkBytes += bytes.byteLength
            totalBytes += bytes.byteLength
            await push(bytes)
          }
          if (!cancelled) chunkStatus = 200
        } catch (error) {
          // The abort a cancel caused is the end of the request, not a failure.
          if (!cancelled) throw error
        } finally {
          if (chunkBytes > 0) {
            const seconds = chunkBytes / (2 * sampleRate)
            // Billed audio is billed even when the stream failed or the client left: price it as delivered.
            scope.call({
              endpoint: 'speech',
              routeId,
              model,
              status: 200,
              errorText:
                chunkStatus === 200
                  ? null
                  : `${cancelled ? 'client cancelled' : 'stream failed'} after ${chunkBytes} bytes`,
              latencyMs: clock.now() - chunkStart,
              inputTokens: meter.promptTokens,
              outputTokens: Math.round(seconds * AUDIO_TOKENS_PER_SECOND),
              audioSeconds: seconds,
              bytesOut: chunkBytes,
            })
          }
        }
      }
    } finally {
      scope.meta.audioSeconds = totalBytes / (2 * sampleRate)
      scope.meta.bytesOut = totalBytes
    }
  }

  const settled = run().then(
    () => {
      if (!cancelled) controller.close()
    },
    (error: unknown) => {
      if (!cancelled) controller.error(error)
      throw error
    },
  )
  settled.catch(() => {}) // observed by the caller; this keeps an unobserved rejection from crashing the process

  await Promise.race([first, settled]) // a failure before the first byte rejects here
  if (firstByteMs !== null) scope.log.info('tts.first_byte', { model, firstByteMs })
  return { response: new Response(body, { status: 200, headers }), settled }
}

export async function handleGeminiSpeech(scope: AudioScope, req: GeminiSpeechRequest): Promise<LaneResult> {
  const { routeId, input, voice, responseFormat, summarize, delivery } = req
  const model = scope.route(routeId).model
  if (!input.trim()) {
    return {
      response: Response.json(
        { error: { message: 'input is required', type: 'invalid_request_error' } },
        { status: 400 },
      ),
    }
  }
  const voiceName = GEMINI_VOICES.has(voice) ? voice : DEFAULT_VOICE
  const { prep, ran } = await runGeminiPrep(scope, model, input, summarize)
  // The per-chunk ceiling, however prep split things: long chunks are what makes the voice drift mid-audio.
  const callerStyle = resolveDelivery(delivery)
  const chunks = enforceChunkLimits(
    callerStyle ? prep.chunks.map((c) => ({ ...c, style: callerStyle })) : prep.chunks,
    chunkLimits(scope),
  )
  const title = prep.title || fallbackTitle(input, prep.lang === 'de')
  Object.assign(scope.meta, {
    mode: summarize ? 'summary' : ran ? 'prep' : 'direct',
    lane: 'gemini',
    chunks: chunks.length,
    languageCode: prep.lang,
    voice: voiceName,
    title,
    outputText: chunks.map((c) => c.text).join(' '),
  })
  const headers = { 'x-audio-title': encodeURIComponent(title) }

  if (responseFormat === 'pcm') {
    return streamGeminiSpeech(scope, {
      routeId,
      voiceName,
      chunks,
      headers: { ...headers, 'content-type': 'audio/pcm' },
    })
  }

  const parts = await synthChunksConcurrent(scope, routeId, voiceName, chunks)
  const { pcm, sampleRate } = concatPcm(parts)
  const { bytes, contentType } = await scope.deps.media.transcode(pcm, { kind: 'pcm', sampleRate }, responseFormat)
  scope.meta.audioSeconds = pcm.byteLength / (2 * sampleRate)
  scope.meta.bytesOut = bytes.byteLength
  return { response: new Response(bytes, { status: 200, headers: { ...headers, 'content-type': contentType } }) }
}
