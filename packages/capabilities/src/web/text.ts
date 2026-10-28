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
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1]?.toLowerCase() === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

// The page body is hostile input of up to a couple of megabytes, scanned on the event loop. Nothing here backtracks:
// one forward pass with `indexOf` and character tests, and every search resumes where the last one ended, so the work
// is linear in the body however many tags are left open.

/** Elements whose content is not page text (code, styles, template and fallback markup): dropped with their content. */
const RAW = new Set(['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'title'])
/** Elements that break a line. Every other tag is dropped and its content kept. */
const BLOCKS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'nav',
  'aside',
  'li',
  'ul',
  'ol',
  'tr',
  'table',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'blockquote',
  'dd',
  'dt',
  'dl',
  'figure',
  'figcaption',
  'form',
  'fieldset',
  'td',
  'th',
  'details',
  'summary',
])
const SCOPES = ['main', 'article'] as const

const isLetter = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
const isNameChar = (code: number) => isLetter(code) || (code >= 48 && code <= 57) || code === 45 || code === 58

/** The index of the `>` that ends the tag whose attributes start at `from`, quotes respected; -1 when it never ends. */
function tagEnd(html: string, from: number): number {
  let quote = 0
  for (let i = from; i < html.length; i++) {
    const c = html.charCodeAt(i)
    if (quote) {
      if (c === quote) quote = 0
    } else if (c === 34 || c === 39) quote = c
    else if (c === 62) return i
  }
  return -1
}

/** Where the closing tag of `name` ends (just past its `>`), searching forward from `from`; -1 when there is none. */
function closeOf(html: string, name: string, from: number): number {
  const at = indexOfIgnoreCase(html, `</${name}`, from)
  const end = at < 0 ? -1 : html.indexOf('>', at)
  return end < 0 ? -1 : end + 1
}

/** `indexOf` for a lowercase ASCII `needle` that starts with `<`, ignoring case; no copy of the body, no backtracking. */
function indexOfIgnoreCase(html: string, needle: string, from: number): number {
  for (let i = html.indexOf('<', from); i >= 0; i = html.indexOf('<', i + 1)) {
    if (i + needle.length > html.length) return -1
    let k = 1
    for (; k < needle.length; k++) {
      let c = html.charCodeAt(i + k)
      if (c >= 65 && c <= 90) c += 32
      if (c !== needle.charCodeAt(k)) break
    }
    if (k === needle.length) return i
  }
  return -1
}

/** The page's `<title>`, tags and entities removed; undefined when there is none. */
export function htmlTitle(html: string): string | undefined {
  const open = indexOfIgnoreCase(html, '<title', 0)
  if (open < 0) return undefined
  const start = tagEnd(html, open + 6)
  if (start < 0) return undefined
  const end = indexOfIgnoreCase(html, '</title', start)
  const raw = html.slice(start + 1, end < 0 ? Math.min(html.length, start + 1 + 500) : end)
  const title = decodeEntities(raw.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
  return title || undefined
}

/**
 * Readable text from an HTML document, in one pass: script, style, `<title>`, `noscript`, `svg`, `template` and `iframe`
 * dropped with their content, block tags become line breaks, every other tag is dropped and its content kept (forms and
 * navigation included: ASP.NET wraps a whole page in one `<form>`, and a dropped menu costs little against a dropped
 * page). The `<main>` text wins when there is any, then `<article>`, else the whole body. It is a text extractor, not a
 * parser: what it returns is untrusted page content and stays data.
 */
export function htmlToText(html: string): string {
  let all = ''
  const scoped = { main: { depth: 0, text: '' }, article: { depth: 0, text: '' } }
  const emit = (text: string) => {
    all += text
    if (scoped.main.depth > 0) scoped.main.text += text
    if (scoped.article.depth > 0) scoped.article.text += text
  }

  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) {
      emit(html.slice(i))
      break
    }
    if (lt > i) emit(html.slice(i, lt))
    const next = html.charCodeAt(lt + 1)
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      if (end < 0) break
      i = end + 3
      continue
    }
    const closing = next === 47 // "/"
    const nameStart = lt + (closing ? 2 : 1)
    if (!isLetter(html.charCodeAt(nameStart))) {
      if (next === 33 || next === 63) {
        // <!doctype …>, <?xml …?>
        const end = html.indexOf('>', lt + 2)
        if (end < 0) break
        i = end + 1
        continue
      }
      emit('<') // "a < b": not a tag
      i = lt + 1
      continue
    }
    let nameEnd = nameStart
    while (nameEnd < html.length && isNameChar(html.charCodeAt(nameEnd))) nameEnd++
    const name = html.slice(nameStart, nameEnd).toLowerCase()
    const end = tagEnd(html, nameEnd)
    if (end < 0) break // a tag that never ends: the rest is not text
    i = end + 1
    if (closing) {
      for (const scope of SCOPES) if (name === scope && scoped[scope].depth > 0) scoped[scope].depth--
    } else if (RAW.has(name) && html.charCodeAt(end - 1) !== 47) {
      const after = closeOf(html, name, i)
      if (after < 0) break // an element that never closes swallows the rest, as in a browser
      i = after
      continue
    } else {
      for (const scope of SCOPES) if (name === scope) scoped[scope].depth++
    }
    if (BLOCKS.has(name)) emit('\n')
  }

  const chosen = [scoped.main.text, scoped.article.text].find((text) => text.trim() !== '') ?? all
  return decodeEntities(chosen)
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line, n, lines) => line !== '' || (n > 0 && lines[n - 1] !== ''))
    .join('\n')
    .trim()
}

/** `text` cut to at most `max` UTF-16 units without splitting a surrogate pair. */
export function cut(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  const high = text.charCodeAt(max - 1)
  return { text: text.slice(0, high >= 0xd800 && high <= 0xdbff ? max - 1 : max), truncated: true }
}
