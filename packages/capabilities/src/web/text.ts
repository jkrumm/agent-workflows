const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  laquo: '«',
  raquo: '»',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1]?.toLowerCase() === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

const DROPPED =
  /<(script|style|noscript|svg|template|iframe|head|title|nav|footer|form|button|select)\b[\s\S]*?<\/\1\s*>/gi
const BLOCKS =
  /<\/?(p|div|section|article|main|header|li|ul|ol|tr|table|h[1-6]|pre|blockquote|br|hr|dd|dt|figure|figcaption)\b[^>]*>/gi

/** The page's `<title>`, tags and entities removed; undefined when there is none. */
export function htmlTitle(html: string): string | undefined {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)
  const title = match
    ? decodeEntities(match[1]!.replace(/<[^>]*>/g, ''))
        .replace(/\s+/g, ' ')
        .trim()
    : ''
  return title || undefined
}

/**
 * Readable text from an HTML document: scripts, styles and page chrome dropped, block tags become line breaks, the
 * rest of the markup is stripped. The `<main>` or `<article>` body wins when there is one. It is a text extractor,
 * not a parser: what it returns is untrusted page content and stays data.
 */
export function htmlToText(html: string): string {
  const body = html.replace(/<!--[\s\S]*?-->/g, '')
  const scoped = body.match(/<(main|article)\b[^>]*>([\s\S]*)<\/\1\s*>/i)?.[2] ?? body
  const text = decodeEntities(
    scoped
      .replace(DROPPED, ' ')
      .replace(BLOCKS, '\n')
      .replace(/<[^>]*>/g, ''),
  )
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line, i, lines) => line !== '' || (i > 0 && lines[i - 1] !== ''))
    .join('\n')
    .trim()
}

/** `text` cut to at most `max` UTF-16 units without splitting a surrogate pair. */
export function cut(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  const high = text.charCodeAt(max - 1)
  return { text: text.slice(0, high >= 0xd800 && high <= 0xdbff ? max - 1 : max), truncated: true }
}
