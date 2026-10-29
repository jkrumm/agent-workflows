// The speech vocabulary the writers' room writes against: inline tags, the per-turn delivery keys, and the synth's
// multi-speaker request units (the segment writer measures its own draft with them). Ported verbatim from
// audio-gateway (`gemini-tts-core.ts`, `podcast-synth.ts`); the synth itself lives in `podcast.produce`.

/** Allowed inline tags: angle brackets, English, never spoken. One allowlist for every lane. */
export const SPEECH_TAGS = [
  '<short pause>',
  '<long pause>',
  '<laugh>',
  '<chuckle>',
  '<sigh>',
  '<exhales>',
  '<breath>',
  '<whispers>',
] as const

/**
 * Per-turn delivery vocabulary: the writer picks a KEY, the synth sends the English style string (never spoken).
 * Closed on purpose: reused exact strings keep the voice from drifting, and nothing the writer invents can reach the
 * TTS request.
 */
export const DELIVERY_STYLES = {
  curious: 'curious, leaning in',
  amused: 'amused, a smile in the voice',
  surprised: 'surprised, a little incredulous',
  serious: 'serious, measured',
  thoughtful: 'thoughtful, a bit slower',
  energetic: 'energetic, a little faster',
  dry: 'dry, understated',
  warm: 'warm, reassuring',
} as const satisfies Record<string, string>

export type DeliveryKey = keyof typeof DELIVERY_STYLES
export const DELIVERY_KEYS = Object.keys(DELIVERY_STYLES) as DeliveryKey[]
export const isDeliveryKey = (value: string): value is DeliveryKey => Object.hasOwn(DELIVERY_STYLES, value)

/** True when a turn's last sentence is a question (a trailing tag aside): its answer belongs in the same synth request. */
export const endsOnQuestion = (text: string): boolean =>
  /\?["»“”')\]]*\s*$/.test(text.replace(/<[^<>\n]{1,24}>\s*$/, '').trim())

/** Any `<angle tag>` (no space after `<`, so `a < 5 und b > 3` survives) or `[square]` tag-shaped span. */
export const TAG_PATTERN = /<[^\s<>][^<>\n]{0,40}>|\[[^\]\n]+\]/g

/** Remove a tag-shaped span unless it is in `allowed` (case-insensitive): invented and legacy `[v3]` tags go. */
export function stripDisallowedTags(text: string, allowed: readonly string[] = SPEECH_TAGS): string {
  const set = new Set(allowed.map((t) => t.toLowerCase()))
  return text.replace(TAG_PATTERN, (m) => (set.has(m.toLowerCase()) ? m : ''))
}

/** A run of consecutive turns synthesized in one request. */
export interface SynthUnit {
  turnIndexes: number[]
}

/**
 * Pack consecutive turns into runs of at most `maxChars` characters, never across a segment boundary
 * (`segmentLengths` = turns per segment). A single over-long turn is its own run. A cut never lands between a
 * question and its answer: when a run would end on a question, the question moves to the next run, unless that
 * leaves the run empty. Only the turn texts matter, so it takes `{ text }`.
 */
export function unitsForMultiSpeaker(
  turns: readonly { text: string }[],
  segmentLengths: number[],
  maxChars: number,
): SynthUnit[] {
  const units: SynthUnit[] = []
  let start = 0
  for (const length of segmentLengths) {
    let current: number[] = []
    let chars = 0
    for (let i = start; i < start + length; i++) {
      const size = turns[i]?.text.length ?? 0
      if (current.length > 0 && chars + size > maxChars) {
        const last = current[current.length - 1]
        const lastSize = last === undefined ? 0 : (turns[last]?.text.length ?? 0)
        // The question moves to the next run only when it still fits there together with the turn that triggered the cut.
        const carry =
          current.length > 1 &&
          last !== undefined &&
          endsOnQuestion(turns[last]?.text ?? '') &&
          lastSize + size <= maxChars
        if (carry) current.pop()
        units.push({ turnIndexes: current })
        current = carry && last !== undefined ? [last] : []
        chars = carry ? lastSize : 0
      }
      current.push(i)
      chars += size
    }
    if (current.length > 0) units.push({ turnIndexes: current })
    start += length
  }
  return units
}

/**
 * Bounded-concurrency map in input order: windows of `concurrency`, a failing window settles fully and stops the
 * next one from starting, then the first error is thrown.
 */
export async function mapConcurrent<I, O>(
  concurrency: number,
  items: readonly I[],
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const out: O[] = []
  for (let start = 0; start < items.length; start += concurrency) {
    const batch = items.slice(start, start + concurrency)
    const settled = await Promise.allSettled(batch.map((item, i) => fn(item, start + i)))
    const failed = settled.find((s) => s.status === 'rejected')
    if (failed) throw failed.reason
    for (const s of settled) if (s.status === 'fulfilled') out.push(s.value)
  }
  return out
}
