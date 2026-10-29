// Plain-text and ANSI primitives of the overview renderer. SGR only: the text renders in a herdr pane under `watch
// --color`, plain output stays byte-identical when colour is off, and every coloured span resets before the newline.

export const RESET = '\x1b[0m'
export const BOLD = '\x1b[1m'
export const DIM = '\x1b[2m'
export const RED = '\x1b[31m'
export const GREEN = '\x1b[32m'
export const YELLOW = '\x1b[33m'
export const CYAN = '\x1b[36m'
export const MAGENTA = '\x1b[35m'
export const BOLD_RED = `${BOLD}${RED}`
export const DIM_GREEN = `${DIM}${GREEN}`

/** Strips SGR sequences. A scan, not a regex literal: `no-control-regex` flags the ESC byte in a pattern. */
export function stripAnsi(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '\x1b') {
      const end = text.indexOf('m', i)
      if (end === -1) break
      i = end + 1
      continue
    }
    out += text[i]
    i += 1
  }
  return out
}

/** Floor for a narrow-terminal title/text budget, so a narrow width never collapses a title to nothing. */
export const MIN_TITLE_CHARS = 20

/** Clamps a (possibly coloured) line to `maxChars` visible characters and always closes with a reset. */
export function clampVisible(line: string, maxChars: number): string {
  if (stripAnsi(line).length <= maxChars) return line
  let visible = 0
  let out = ''
  let i = 0
  while (i < line.length) {
    if (line[i] === '\x1b') {
      const end = line.indexOf('m', i)
      if (end === -1) break
      out += line.slice(i, end + 1)
      i = end + 1
      continue
    }
    if (visible >= maxChars) break
    out += line[i]
    visible += 1
    i += 1
  }
  return `${out}${RESET}`
}

/** Hard-cuts a plain line to `maxChars`. */
export function clampLine(line: string, maxChars: number): string {
  return line.length > maxChars ? line.slice(0, maxChars) : line
}

/** Truncates with an elided "…" when over budget; the renderer and the facts block cut text the same way. */
export function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

/** "N ago" phrasing shared by the renderer and the facts block handed to the model. */
export function relativeAge(ms: number | null, now: number): string {
  if (ms == null) return '?'
  const deltaSec = Math.max(0, Math.round((now - ms) / 1000))
  if (deltaSec < 60) return `${deltaSec}s`
  const deltaMin = Math.round(deltaSec / 60)
  if (deltaMin < 60) return `${deltaMin}m`
  const deltaHour = Math.round(deltaMin / 60)
  if (deltaHour < 24) return `${deltaHour}h`
  return `${Math.round(deltaHour / 24)}d`
}

/**
 * Drops the control bytes a terminal would act on: C0 (tab, newline and carriage return stay; callers collapse
 * whitespace) and C1 (U+0080 to U+009F, which several terminals read as an escape introducer). Text from an agent or a
 * queue request must never put an ESC into a coloured pane. A char-code scan, for the same reason as `stripAnsi`.
 */
export function stripControlBytes(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const control =
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f)
    if (!control) out += ch
  }
  return out
}

/** True when `text` carries a control byte or a line break: not a value to hand to a path argument or a key. */
export function hasControlBytes(text: string): boolean {
  return stripControlBytes(text) !== text || /[\r\n]/.test(text)
}

/** One line of text: control bytes dropped, every run of whitespace (CR and LF included) one space, trimmed. */
export function oneLine(text: string): string {
  return stripControlBytes(text).replace(/\s+/g, ' ').trim()
}
