import { errorMessage, gatewayTextHeaders, rawFetch } from '../http.ts'
import { isBalanceFailure } from '@agent-workflows/routes'
import { AUDIO_DEFAULT_ROUTES, type AudioRoute, fallbackOf } from '../routes.ts'
import type { AudioScope } from '../scope.ts'
import { type Measure, measureFromAnthropicUsage, measureFromOpenAiUsage } from '../usage.ts'
import { DELIVERY_KEYS, DELIVERY_STYLES, type PrepResult, parsePrepResponse, SPEECH_TAGS } from './core.ts'

/**
 * The one short `speechMetadata.style` string Gemini prep uses for every chunk of a request. 3.8 reads direction in
 * the text aloud; sustained delivery belongs in this field, identical across chunks so the voice does not drift.
 */
export const PREP_STYLE = 'calm, warm, conversational'
export const VOCABULARY_STYLES = new Set<string>([PREP_STYLE, ...Object.values(DELIVERY_STYLES)])
const DELIVERY_LIST = DELIVERY_KEYS.join(', ')
const TAG_LIST = SPEECH_TAGS.join(' ')

export const SUMMARY_SYSTEM_PROMPT = `You turn an assistant reply into what should be SPOKEN aloud, in the persona of Hermes — a calm, warm, concise "sharp older friend". The user reads the written reply on screen; the spoken rendering is for the ear. There is no length limit: decide from the text how much deserves to be heard.

Your job, in order:
1. Detect the language of the input: "de" (German) or "en" (English).
2. Write a short title (3–6 words) IN that language: plain words, no quotes, no trailing punctuation, no emoji.
3. Decide what the listener needs, and write exactly that:
   - An action confirmation ("I created the todo…") → one short clause: "Todo Serverrechnung für morgen angelegt".
   - An answer to a question → the answer with the details that actually matter (the day, time, amount, condition), in flowing sentences; drop lists, headers, hedges and anything the user would only want to read, not hear.
   - Content that is meant to be listened to in full — a weather report, a briefing, a message the user asked to have spoken, a story — → keep ALL of its substance, rewritten as natural speech.
   Never pad, never add greetings or filler, never truncate a report to be brief.
4. Speak numbers, times, dates and units in spoken form (German: "achtzehn Uhr dreißig", "zweiundzwanzig Grad", "Samstag, der neunundzwanzigste"; English: "half past six", "twenty-two degrees"). No markdown, no bullet characters, no emoji, no tags.
5. Use exactly "${PREP_STYLE}" as the "style" value.

Return STRICT JSON only, no markdown, no commentary:
{"lang":"de"|"en","title":"<short title>","chunks":[{"style":"${PREP_STYLE}","text":"<the spoken rendering>"}]}`

export const GEMINI_PREP_SYSTEM_PROMPT = `You prepare text for Gemini 3.8 text-to-speech in the persona of Hermes — a calm, warm, concise "sharp older friend". No greetings, no filler, substance first. The model speaks the "text" field VERBATIM: anything that is not meant to be heard must not be in it.

Your job, in order:
1. Detect the language of the input: "de" (German) or "en" (English).
2. Write a short title (3–6 words) summarizing the content, IN the transcript's language, suitable as a filename/label: plain words, no quotes, no trailing punctuation, no emoji.
3. Rewrite numbers, times, dates, units, symbols and abbreviations into the spoken form IN that language (German: "Viertel nach neun", "neunzig Kilo", "achtzehn Uhr dreißig", "zum Beispiel", "Millionen Euro"; English: "quarter past nine", "ninety kilos"). Do not translate the text — keep its language. Times, dates, prices and versions stay exact. For statistics and large counts where the exact digits do not matter, round to the figure a person would say ("gut viertausend Nutzer", "rund dreizehnhundert Euro") and keep to about one figure per sentence. Round only into forms people actually say: small decimals stay decimals ("null Komma drei Sekunden"), never unusual fractions ("eine drittel Sekunde"); "halb" and "Viertel" only where they are idiomatic. No markdown, bullet characters or emoji.
4. Split the text into chunks of about 110 words each (never more than 150, roughly 1,000 characters), so each chunk is only about 50 seconds of speech — Gemini TTS drifts and drops words on longer generations. Break at paragraph boundaries first, then at sentence boundaries; never split in the middle of a sentence. Short text stays a single chunk.
5. Delivery: every chunk has a stable baseline (the voice's calm, warm, conversational default) and carries NO "delivery" field. Set "delivery" ONLY on a chunk where the content turns — bad news, a warning, good news, a dry aside, something to think about — to exactly one of: ${DELIVERY_LIST}. Never the same non-baseline delivery on three chunks in a row. Never put direction, emotion words or "Style:" prefixes inside "text"; they would be read aloud.
6. Embed inline tags inside "text" where a real speaker would pause or react, in angle brackets, always in English even inside German text. The only tags: ${TAG_LIST}. Use a few well-placed ones: a <short pause> before the figure or turn that matters, a <long pause> once for weight, a reaction (<laugh>, <chuckle>, <sigh>) only where the content truly calls for it — roughly one to three tags per chunk of about a hundred words, between two sentences, never as the first word of the chunk, never two tags side by side. No square-bracket tags, no emotion tags, no other tag names.

Return STRICT JSON only, no markdown, no commentary:
{"lang":"de"|"en","title":"<short title>","chunks":[{"delivery":"<optional: one of ${DELIVERY_LIST} — omit on a baseline chunk>","text":"<transcript with <tags>>"}]}`

/** Whether `model` is listed (id or prefix). */
export const listed = (models: readonly string[], model: string): boolean =>
  models.some((entry) => model === entry || model.startsWith(entry))

/** First few words of the input as a fallback title for the no-LLM path. */
export function fallbackTitle(input: string, de: boolean): string {
  const words = input.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ')
  const trimmed = words.replace(/[.,;:!?]+$/, '').trim()
  return trimmed || (de ? 'Sprachnachricht' : 'Voice memo')
}

const ANTHROPIC_VERSION = '2023-06-01'

interface PrepRequest {
  url: string
  headers: Record<string, string>
  body: unknown
}

/**
 * The request for the route's wire. The seats decide the wire (`audio.tts.prep` is on `anthropic` where the credit
 * is spent, `iu-openai` otherwise), so the call dispatches on it. The Messages wire sends `x-agw-fallback: none`: with
 * no credit left the gateway answers 402 and the route's own fallback takes over, never IU's Claude.
 */
function prepRequest(
  scope: AudioScope,
  route: AudioRoute,
  opts: { systemPrompt: string; userContent: string; inputChars: number; summarize: boolean },
): PrepRequest {
  const { transports } = scope.config
  // Reasoning-capable models reject `max_tokens` on chat completions; reasoning tokens count against this one.
  const maxTokens = Math.min(32_000, Math.max(2000, opts.inputChars + 1000))
  const effort = !opts.summarize ? route.effort : undefined
  if (route.wire === 'anthropic') {
    return {
      url: `${transports.anthropicBase}/v1/messages`,
      headers: gatewayTextHeaders(scope, {
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
        'x-agw-fallback': 'none',
      }),
      body: {
        model: route.model,
        max_tokens: maxTokens,
        system: opts.systemPrompt,
        messages: [{ role: 'user', content: opts.userContent }],
        // `none` is the route saying no thinking: the Messages wire omits it, where chat completions send `none`.
        ...(effort && effort !== 'none' && { thinking: { type: 'adaptive' }, output_config: { effort } }),
      },
    }
  }
  if (route.wire === 'iu-openai') {
    return {
      url: `${transports.openaiBase}/chat/completions`,
      headers: gatewayTextHeaders(scope, { 'content-type': 'application/json' }),
      body: {
        model: route.model,
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.userContent },
        ],
        max_completion_tokens: maxTokens,
        ...(effort && { reasoning_effort: effort }),
      },
    }
  }
  throw new Error(`audio route "${route.id}" is on the ${route.wire} wire, which a text call does not speak`)
}

/** The model's text and usage out of a 2xx body on the route's wire. */
function readPrepReply(route: AudioRoute, body: string): { text: string; measure: Measure } {
  const json = JSON.parse(body) as {
    choices?: Array<{ message?: { content?: string } }>
    content?: Array<{ type?: string; text?: string }>
    usage?: unknown
  }
  if (route.wire === 'anthropic') {
    const text = (json.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
    return { text, measure: measureFromAnthropicUsage(json.usage) }
  }
  return { text: json.choices?.[0]?.message?.content ?? '', measure: measureFromOpenAiUsage(json.usage) }
}

type Attempt = { ok: true; prep: PrepResult } | { ok: false; error: Error; balance: boolean }

/** One prep or summary call on one route, priced and recorded before any failure is returned (a failed call is visible too). */
async function attemptPrep(
  scope: AudioScope,
  routeId: string,
  route: AudioRoute,
  opts: { systemPrompt: string; userContent: string; inputChars: number; summarize: boolean },
): Promise<Attempt> {
  const endpoint = opts.summarize ? 'speech-summary' : 'speech-prep'
  const request = prepRequest(scope, route, opts)
  const start = scope.deps.clock.now()
  const res = await rawFetch(
    scope,
    request.url,
    { method: 'POST', headers: request.headers, body: JSON.stringify(request.body) },
    undefined,
    // A balance 503 goes to the route's fallback now, not after two more sends.
    (reply) => isBalanceFailure({ status: reply.status, text: reply.body }),
  )
  const latencyMs = scope.deps.clock.now() - start
  if (res.status < 200 || res.status >= 300) {
    const errorText = res.body.slice(0, 500)
    scope.log.error('tts prep error', { endpoint, model: route.model, status: res.status, latencyMs, error: errorText })
    scope.call({
      endpoint,
      routeId,
      route,
      model: route.model,
      status: res.status,
      latencyMs,
      inputChars: opts.inputChars,
      errorText,
    })
    return {
      ok: false,
      error: new Error(`TTS prep failed: HTTP ${res.status} ${res.body.slice(0, 300)}`),
      balance: isBalanceFailure({ status: res.status, text: res.body }),
    }
  }
  let reply: { text: string; measure: Measure }
  try {
    reply = readPrepReply(route, res.body)
  } catch (error) {
    scope.call({
      endpoint,
      routeId,
      route,
      model: route.model,
      status: res.status,
      latencyMs,
      errorText: errorMessage(error),
    })
    return { ok: false, error: new Error(`TTS prep answered no JSON: ${res.body.slice(0, 200)}`), balance: false }
  }
  scope.call({
    endpoint,
    routeId,
    route,
    model: route.model,
    status: res.status,
    latencyMs,
    ...reply.measure,
    inputChars: opts.inputChars,
  })
  return { ok: true, prep: parsePrepResponse(reply.text) }
}

/**
 * One prep or summary call on its route's wire (chat completions or Messages). A provider-balance failure moves it
 * once to the route's fallback, which may be on the other wire. `summarize` swaps the system prompt and the route; only
 * prep gets an effort.
 */
export async function callPrepLlm(
  scope: AudioScope,
  opts: { systemPrompt: string; userContent: string; inputChars: number; summarize: boolean },
): Promise<PrepResult> {
  const routeId = opts.summarize ? AUDIO_DEFAULT_ROUTES.summary : AUDIO_DEFAULT_ROUTES.prep
  const primary = scope.route(routeId)
  const first = await attemptPrep(scope, routeId, primary, opts)
  if (first.ok) return first.prep
  const fallback = fallbackOf(primary)
  if (!first.balance || !fallback) throw first.error
  scope.log.warn('tts prep provider balance exhausted; falling back', { route: routeId, to: fallback.model })
  const second = await attemptPrep(scope, routeId, fallback, opts)
  if (second.ok) return second.prep
  throw second.error
}
