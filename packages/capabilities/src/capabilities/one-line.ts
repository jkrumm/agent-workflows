import { z } from 'zod'

// The one home of "a reason is one line": what a model's free-text reason may look like on the way in, and how code brings
// it to the contract on the way out. A model that writes 300 characters or two lines is never re-asked for it (a re-ask
// bills the whole call again, and a hygiene agent re-reads its checkout); the schema takes the raw string and the code
// collapses and clips it. A reason is the deciding fact, never a field a parser branches on, so a clipped one loses nothing.

/** What the factory's parsers take for a reason: one line, at most this many characters. */
export const REASON_MAX_CHARS = 240
/** What a prompt asks for: below the cap, so a model that overshoots a little still fits without a clip. */
export const REASON_ASK_CHARS = 200
/** What a model's reason may carry before it is clipped: a sanity cap, not the contract. */
const RAW_REASON_MAX_CHARS = 2_000

/** The sentence every prompt uses for the reason field. */
export const REASON_ASK = `one line, at most ${REASON_ASK_CHARS} characters`

/** The reason as the model writes it: any single string up to a sanity cap. Brought to the contract by `clipReason`. */
export const rawReason = z.string().min(1).max(RAW_REASON_MAX_CHARS)

/** A strict one-line string of at most `max` characters, for a value the factory supplies (an input) or must stay exact. */
export const strictLine = (max: number) =>
  z.string().regex(new RegExp(`^[^\\r\\n\\u2028\\u2029]{1,${max}}$`), `one line, at most ${max} characters`)

/** Newlines, tabs and runs of spaces collapsed to single spaces, trimmed. */
export const collapseLine = (text: string) =>
  text
    .replace(/[\r\n\u2028\u2029\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()

/** One line of at most `max` characters, cut at a word boundary where one is near, with an ellipsis. */
export function clipLine(text: string, max: number = REASON_MAX_CHARS): string {
  const one = collapseLine(text)
  if (one.length <= max) return one
  const room = one.slice(0, max - 1)
  const space = room.lastIndexOf(' ')
  return `${(space > max / 2 ? room.slice(0, space) : room).trimEnd()}…`
}

/** A model's reason as the contract takes it: one line, at most `REASON_MAX_CHARS`, never empty. */
export const clipReason = (text: string): string => clipLine(text) || 'unavailable'
